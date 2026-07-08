/**
 * M1 dispatch-loop fixes — unit tests with a stubbed HubClient (no real hub,
 * no real claude spawns). Covers:
 *  - issue 46: per-task claim backoff in the worker poll loop
 *  - issue 44 (daemon side): quarantine failTask reason + no error spam
 *  - issue 12: prominent startup warning when defaultAgentId was defaulted
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  AgentRuntime,
  AgentRuntimeSpawnConfig,
  RuntimeInstance,
  Task,
} from '@forge-lab/core';
import { Daemon } from './daemon.js';
import { RuntimeRegistry } from './runtime/registry.js';
import type { WorkspaceContext } from './hub-client.js';

/**
 * Inert fake spawner: records spawns, never writes files, never sets timers.
 * MockRuntime's delayed done-file write races the temp-workdir teardown on
 * Windows (ENOTEMPTY), and none of these tests need a completing agent.
 */
class InertRuntime implements AgentRuntime {
  readonly id = 'mock';
  readonly displayName = 'Inert (test)';
  readonly capabilities = { supportsStreaming: false, supportsTools: false } as const;
  readonly spawns: Array<{ config: AgentRuntimeSpawnConfig; prompt: string }> = [];
  private seq = 0;
  spawn(config: AgentRuntimeSpawnConfig, initialPrompt: string): Promise<RuntimeInstance> {
    this.spawns.push({ config, prompt: initialPrompt });
    this.seq += 1;
    return Promise.resolve({
      id: `inert-${this.seq}`,
      runtimeId: this.id,
      agentId: config.agentId,
      pid: null,
      startedAt: new Date(),
      metadata: { config },
    });
  }
  sendInstruction(): Promise<void> { return Promise.resolve(); }
  stop(): Promise<void> { return Promise.resolve(); }
  isAlive(): Promise<boolean> { return Promise.resolve(true); }
}

interface CapturedLog {
  level: 'info' | 'error';
  msg: string;
  meta: Record<string, unknown> | undefined;
}

function makeLogger(sink: CapturedLog[]) {
  return {
    info: (msg: string, meta?: Record<string, unknown>) => sink.push({ level: 'info', msg, meta }),
    error: (msg: string, meta?: Record<string, unknown>) => sink.push({ level: 'error', msg, meta }),
  };
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'fx-001',
    workspaceId: null,
    projectPrefix: 'fx',
    title: 'Fixture task',
    description: null,
    status: 'pending_agent',
    priority: 'normal',
    assignedDeviceId: null,
    assignedAgentId: null,
    assignedAt: null,
    parentId: null,
    goalId: null,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    taskKind: 'coding',
    reviewConfig: null,
    ...overrides,
  };
}

function emptyContext(workspaceId: string, inboxTasks: Task[]): WorkspaceContext {
  return {
    workspaceId,
    docs: [],
    goals: [],
    agents: [],
    liveInstances: [],
    inboxTasks,
    recentHistory: [],
    dispatcherHistory: [],
    queueDepth: {},
    contextDocs: [],
  };
}

describe('issue 46: per-task claim backoff in the worker poll loop', () => {
  let workdir: string;
  let logs: CapturedLog[];
  let daemon: Daemon;
  let nowMs: number;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-claimbo-'));
    logs = [];
    nowMs = 1_000_000;
    const runtimes = new RuntimeRegistry();
    runtimes.register(new InertRuntime());
    daemon = new Daemon({
      hubUrl: 'http://127.0.0.1:1',
      deviceToken: 'tok',
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      defaultAgentId: 'furnace',
      logger: makeLogger(logs),
      now: () => nowMs,
    });
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  function claimErrorCount(): number {
    return logs.filter((l) => l.level === 'error' && l.msg === 'failed to claim task').length;
  }

  function backoffLogs(): CapturedLog[] {
    return logs.filter((l) => l.level === 'info' && l.msg === 'claim backoff');
  }

  it('skips claim attempts after 3 consecutive failures and escalates backoff up to the 5 min cap', async () => {
    const task = fakeTask();
    const listTasks = vi.spyOn(daemon.hubClient, 'listTasks').mockResolvedValue({ tasks: [task] });
    vi.spyOn(daemon.hubClient, 'getTask').mockResolvedValue(task);
    const claimTask = vi
      .spyOn(daemon.hubClient, 'claimTask')
      .mockRejectedValue(new Error('claim failed: 409 not_claimable'));
    expect(listTasks).toBeDefined();

    const poll = () => daemon['pollForPendingTasks']();

    // Three polls -> three claim attempts -> backoff engages on the third.
    await poll();
    await poll();
    await poll();
    expect(claimTask).toHaveBeenCalledTimes(3);
    expect(backoffLogs()).toHaveLength(1);
    expect(backoffLogs()[0]!.meta).toMatchObject({
      taskId: task.id,
      failures: 3,
      nextAttemptInMs: 30_000,
    });

    // Further polls inside the backoff window must NOT attempt the claim and
    // must NOT add error lines (this is the ~20-errors-in-100s spam from live).
    await poll();
    await poll();
    await poll();
    expect(claimTask).toHaveBeenCalledTimes(3);
    expect(claimErrorCount()).toBe(3);

    // After the 30s window elapses the claim is attempted once more and the
    // backoff doubles to 60s.
    nowMs += 30_000;
    await poll();
    expect(claimTask).toHaveBeenCalledTimes(4);
    expect(backoffLogs()).toHaveLength(2);
    expect(backoffLogs()[1]!.meta).toMatchObject({ failures: 4, nextAttemptInMs: 60_000 });

    // Walk the escalation ladder: 120s, 240s, then the 300s cap (twice).
    const expected = [120_000, 240_000, 300_000, 300_000];
    let prevWait = 60_000;
    for (const wait of expected) {
      nowMs += prevWait;
      await poll();
      const latest = backoffLogs().at(-1)!;
      expect(latest.meta).toMatchObject({ nextAttemptInMs: wait });
      prevWait = wait;
    }
    // One error line per actual attempt — never per skipped poll.
    expect(claimErrorCount()).toBe(claimTask.mock.calls.length);
  });

  it('resets the backoff when the task no longer appears in the poll', async () => {
    const task = fakeTask();
    const listTasks = vi.spyOn(daemon.hubClient, 'listTasks').mockResolvedValue({ tasks: [task] });
    vi.spyOn(daemon.hubClient, 'getTask').mockResolvedValue(task);
    const claimTask = vi
      .spyOn(daemon.hubClient, 'claimTask')
      .mockRejectedValue(new Error('claim failed: 403 policy_denied'));

    const poll = () => daemon['pollForPendingTasks']();
    await poll();
    await poll();
    await poll();
    expect(claimTask).toHaveBeenCalledTimes(3);
    // Backoff active: skipped.
    await poll();
    expect(claimTask).toHaveBeenCalledTimes(3);

    // Task disappears from the poll -> state resets.
    listTasks.mockResolvedValue({ tasks: [] });
    await poll();

    // Task reappears -> claim is attempted immediately (no leftover backoff).
    listTasks.mockResolvedValue({ tasks: [task] });
    await poll();
    expect(claimTask).toHaveBeenCalledTimes(4);
  });

  it('resets the backoff on a successful claim', async () => {
    const task = fakeTask();
    vi.spyOn(daemon.hubClient, 'listTasks').mockResolvedValue({ tasks: [task] });
    vi.spyOn(daemon.hubClient, 'getTask').mockResolvedValue(task);
    vi.spyOn(daemon.hubClient, 'getAgentMemory').mockResolvedValue(null);
    const claimTask = vi
      .spyOn(daemon.hubClient, 'claimTask')
      .mockRejectedValueOnce(new Error('claim failed: 409 not_claimable'))
      .mockRejectedValueOnce(new Error('claim failed: 409 not_claimable'))
      .mockResolvedValue(undefined);

    const poll = () => daemon['pollForPendingTasks']();
    await poll();
    await poll();
    await poll(); // third attempt succeeds
    expect(claimTask).toHaveBeenCalledTimes(3);
    expect(daemon['claimBackoff'].size).toBe(0);
  });
});

describe('issue 44 (daemon side): quarantine failTask reason + single error line', () => {
  let workdir: string;
  let logs: CapturedLog[];
  let daemon: Daemon;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-quarantine-'));
    logs = [];
    const runtimes = new RuntimeRegistry();
    runtimes.register(new InertRuntime());
    daemon = new Daemon({
      hubUrl: 'http://127.0.0.1:1',
      deviceToken: 'tok',
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      workspaceId: 'ws-quarantine',
      dispatcherMode: true,
      fmCooldownMs: 0,
      logger: makeLogger(logs),
    });
    vi.spyOn(daemon.hubClient, 'requeueStaleAssigned').mockResolvedValue({ requeued: 0 });
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('fails the quarantined task with a clear fm_quarantine reason', async () => {
    const stuck = fakeTask({ id: 'qr-001', status: 'pending_dispatcher_action', workspaceId: 'ws-quarantine' });
    vi.spyOn(daemon.hubClient, 'getWorkspaceContext').mockResolvedValue(
      emptyContext('ws-quarantine', [stuck]),
    );
    const failTask = vi.spyOn(daemon.hubClient, 'failTask').mockResolvedValue(undefined);

    // MAX_TRIAGE_ATTEMPTS is 3 — the 4th triage cycle quarantines.
    for (let i = 0; i < 4; i++) {
      await daemon['_triageWorkspace']('ws-quarantine');
    }

    expect(failTask).toHaveBeenCalledTimes(1);
    expect(failTask).toHaveBeenCalledWith(
      'qr-001',
      'fm_quarantine: task deferred 3 consecutive triage cycles; human action required',
    );
  });

  it('logs once and stops retrying quarantine when failTask keeps erroring', async () => {
    const stuck = fakeTask({ id: 'qr-002', status: 'pending_dispatcher_action', workspaceId: 'ws-quarantine' });
    vi.spyOn(daemon.hubClient, 'getWorkspaceContext').mockResolvedValue(
      emptyContext('ws-quarantine', [stuck]),
    );
    const failTask = vi
      .spyOn(daemon.hubClient, 'failTask')
      .mockRejectedValue(new Error('fail failed: 409 not_in_progress'));

    // Run well past the quarantine boundary — failTask must be attempted once,
    // and the failure logged once, with no per-poll spam afterwards.
    for (let i = 0; i < 8; i++) {
      await daemon['_triageWorkspace']('ws-quarantine');
    }

    expect(failTask).toHaveBeenCalledTimes(1);
    const failErrors = logs.filter(
      (l) => l.level === 'error' && l.msg === 'failed to fail quarantined task',
    );
    expect(failErrors).toHaveLength(1);
  });
});

describe('issue 12: startup warning when defaultAgentId was silently defaulted', () => {
  let workdir: string;
  let logs: CapturedLog[];

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-agentwarn-'));
    logs = [];
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  function makeDaemon(opts: { dispatcherMode?: boolean; defaulted?: boolean }): Daemon {
    const runtimes = new RuntimeRegistry();
    runtimes.register(new InertRuntime());
    const daemon = new Daemon({
      hubUrl: 'http://127.0.0.1:1',
      deviceToken: 'tok',
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      defaultAgentId: 'architect',
      pollIntervalMs: 60_000,
      logger: makeLogger(logs),
      ...(opts.dispatcherMode ? { dispatcherMode: true, workspaceId: 'ws-1' } : {}),
      ...(opts.defaulted !== undefined ? { defaultAgentIdWasDefaulted: opts.defaulted } : {}),
    });
    vi.spyOn(daemon.hubClient, 'connect').mockResolvedValue(undefined);
    vi.spyOn(daemon.hubClient, 'close').mockResolvedValue(undefined);
    vi.spyOn(daemon.hubClient, 'listTasks').mockResolvedValue({ tasks: [] });
    vi.spyOn(daemon.hubClient, 'requeueStaleAssigned').mockResolvedValue({ requeued: 0 });
    vi.spyOn(daemon.hubClient, 'getWorkspaceContext').mockResolvedValue(emptyContext('ws-1', []));
    return daemon;
  }

  function warningLogs(): CapturedLog[] {
    return logs.filter((l) => l.msg.includes('FORGE_DAEMON_AGENT_ID not set'));
  }

  it('warns on start in worker mode when the agentId default was used', async () => {
    const daemon = makeDaemon({ defaulted: true });
    await daemon.start();
    await daemon.stop();
    expect(warningLogs()).toHaveLength(1);
    expect(warningLogs()[0]!.msg).toContain('defaulting to architect');
    expect(warningLogs()[0]!.msg).toContain('will not be claimable');
  });

  it('does not warn in dispatcher mode even when defaulted', async () => {
    const daemon = makeDaemon({ dispatcherMode: true, defaulted: true });
    await daemon.start();
    await daemon.stop();
    expect(warningLogs()).toHaveLength(0);
  });

  it('does not warn when the agentId was explicitly provided (even if it is architect)', async () => {
    const daemon = makeDaemon({ defaulted: false });
    await daemon.start();
    await daemon.stop();
    expect(warningLogs()).toHaveLength(0);
  });
});

describe('issue 47: startup warning when FORGE_DAEMON_AGENT_ID differs from the hub device row agentId', () => {
  let workdir: string;
  let logs: CapturedLog[];

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-devrow-'));
    logs = [];
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  function makeDaemon(opts: { defaultAgentId?: string; defaulted?: boolean }): Daemon {
    const runtimes = new RuntimeRegistry();
    runtimes.register(new InertRuntime());
    const daemon = new Daemon({
      hubUrl: 'http://127.0.0.1:1',
      deviceToken: 'tok',
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      pollIntervalMs: 60_000,
      logger: makeLogger(logs),
      ...(opts.defaultAgentId !== undefined ? { defaultAgentId: opts.defaultAgentId } : {}),
      ...(opts.defaulted !== undefined ? { defaultAgentIdWasDefaulted: opts.defaulted } : {}),
    });
    vi.spyOn(daemon.hubClient, 'connect').mockResolvedValue(undefined);
    vi.spyOn(daemon.hubClient, 'close').mockResolvedValue(undefined);
    vi.spyOn(daemon.hubClient, 'listTasks').mockResolvedValue({ tasks: [] });
    return daemon;
  }

  function mismatchWarnings(): CapturedLog[] {
    return logs.filter((l) => l.msg.toUpperCase().includes('DEVICE ROW'));
  }

  it('warns when FORGE_DAEMON_AGENT_ID differs from the device row agentId, naming both values', async () => {
    const daemon = makeDaemon({ defaultAgentId: 'furnace', defaulted: false });
    vi.spyOn(daemon.hubClient, 'getSelf').mockResolvedValue({
      id: 'dev-1',
      name: 'worker-1',
      agentId: 'architect',
      deviceType: 'worker',
      status: 'active',
    });
    await daemon.start();
    await daemon.stop();
    expect(mismatchWarnings()).toHaveLength(1);
    expect(mismatchWarnings()[0]!.msg).toContain('furnace');
    expect(mismatchWarnings()[0]!.msg).toContain('architect');
  });

  it('warns when the device row agentId is null/unset', async () => {
    const daemon = makeDaemon({ defaultAgentId: 'furnace', defaulted: false });
    vi.spyOn(daemon.hubClient, 'getSelf').mockResolvedValue({
      id: 'dev-1',
      name: 'worker-1',
      agentId: null,
      deviceType: 'worker',
      status: 'active',
    });
    await daemon.start();
    await daemon.stop();
    expect(mismatchWarnings()).toHaveLength(1);
    expect(mismatchWarnings()[0]!.msg).toContain('furnace');
  });

  it('does not warn when FORGE_DAEMON_AGENT_ID matches the device row agentId', async () => {
    const daemon = makeDaemon({ defaultAgentId: 'architect', defaulted: false });
    vi.spyOn(daemon.hubClient, 'getSelf').mockResolvedValue({
      id: 'dev-1',
      name: 'worker-1',
      agentId: 'architect',
      deviceType: 'worker',
      status: 'active',
    });
    await daemon.start();
    await daemon.stop();
    expect(mismatchWarnings()).toHaveLength(0);
  });

  it('does not warn (and does not even fetch the device row) when FORGE_DAEMON_AGENT_ID is unset', async () => {
    const daemon = makeDaemon({ defaultAgentId: 'architect', defaulted: true });
    const getSelf = vi.spyOn(daemon.hubClient, 'getSelf').mockResolvedValue({
      id: 'dev-1',
      name: 'worker-1',
      agentId: 'someone-else',
      deviceType: 'worker',
      status: 'active',
    });
    await daemon.start();
    await daemon.stop();
    expect(mismatchWarnings()).toHaveLength(0);
    expect(getSelf).not.toHaveBeenCalled();
  });

  it('does not fail startup when the hub device-row fetch errors (e.g. route not deployed yet)', async () => {
    const daemon = makeDaemon({ defaultAgentId: 'furnace', defaulted: false });
    vi.spyOn(daemon.hubClient, 'getSelf').mockRejectedValue(new Error('GET /devices/me 404: not_found'));
    await expect(daemon.start()).resolves.toBeUndefined();
    await daemon.stop();
    expect(mismatchWarnings()).toHaveLength(0);
  });
});
