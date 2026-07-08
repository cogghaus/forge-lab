/**
 * M3 reliability: daemon side (issues 1, 4, 14). Unit tests against a
 * stubbed HubClient; the hub route for POST /tasks/:id/heartbeat is
 * implemented in parallel (docs/design/m3-reliability.md), so these tests
 * code against the documented contract instead of a live hub:
 *   success -> {ok:true, leaseExpiresAt}
 *   409/404 -> HttpError (lease lost / task gone)
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
import { HttpError } from './hub-client.js';
import { doneFilePath, taskDir, taskFilePath, memoryFilePath } from './sync/task-file.js';

/** Runtime double that records stop() calls and lets tests flip isAlive(). */
class RecordingRuntime implements AgentRuntime {
  readonly id = 'mock';
  readonly displayName = 'Recording (test)';
  readonly capabilities = { supportsStreaming: false, supportsTools: false } as const;
  readonly stopped: RuntimeInstance[] = [];
  aliveResult = true;
  private seq = 0;

  spawn(config: AgentRuntimeSpawnConfig): Promise<RuntimeInstance> {
    this.seq += 1;
    return Promise.resolve({
      id: `rec-${this.seq}`,
      runtimeId: this.id,
      agentId: config.agentId,
      pid: null,
      startedAt: new Date(),
      metadata: {},
    });
  }
  sendInstruction(): Promise<void> {
    return Promise.resolve();
  }
  stop(instance: RuntimeInstance): Promise<void> {
    this.stopped.push(instance);
    return Promise.resolve();
  }
  isAlive(): Promise<boolean> {
    return Promise.resolve(this.aliveResult);
  }
}

/** Runtime double whose spawn() always rejects (drives the spawn-failure path). */
class FailingSpawnRuntime implements AgentRuntime {
  readonly id = 'mock';
  readonly displayName = 'FailingSpawn (test)';
  readonly capabilities = { supportsStreaming: false, supportsTools: false } as const;
  spawn(): Promise<RuntimeInstance> {
    return Promise.reject(new Error('boom: spawn failed'));
  }
  sendInstruction(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  isAlive(): Promise<boolean> {
    return Promise.resolve(false);
  }
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

function fakeInstance(agentId: string): RuntimeInstance {
  return { id: 'i1', runtimeId: 'mock', agentId, pid: null, startedAt: new Date(), metadata: {} };
}

const NOOP_SLEEP = async (): Promise<void> => {};

describe('M3 issue 1: heartbeat loop', () => {
  let workdir: string;
  let logs: CapturedLog[];
  let daemon: Daemon;
  let runtime: RecordingRuntime;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-heartbeat-'));
    logs = [];
    runtime = new RecordingRuntime();
    const runtimes = new RuntimeRegistry();
    runtimes.register(runtime);
    daemon = new Daemon({
      hubUrl: 'http://127.0.0.1:1',
      deviceToken: 'tok',
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      defaultAgentId: 'furnace',
      logger: makeLogger(logs),
    });
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('beats every active real task and skips _fm_ synthetics', async () => {
    const heartbeatTask = vi
      .spyOn(daemon.hubClient, 'heartbeatTask')
      .mockResolvedValue({ ok: true, leaseExpiresAt: 123 });
    daemon['activeInstances'].set('task-real', {
      instance: fakeInstance('furnace'),
      runtimeId: 'mock',
      startedAt: Date.now(),
    });
    daemon['activeInstances'].set('_fm_abc', {
      instance: fakeInstance('forge-master'),
      runtimeId: 'mock',
      startedAt: Date.now(),
    });

    await daemon['beatActiveTasks']();

    expect(heartbeatTask).toHaveBeenCalledTimes(1);
    expect(heartbeatTask).toHaveBeenCalledWith('task-real');
  });

  it('on 409 lease_lost: kills the local instance, cleans up files, drops from the map, and does NOT call failTask', async () => {
    const instance = fakeInstance('furnace');
    daemon['activeInstances'].set('task-lost', { instance, runtimeId: 'mock', startedAt: Date.now() });
    await fs.mkdir(taskDir(workdir), { recursive: true });
    await fs.writeFile(taskFilePath(workdir, 'task-lost'), 'x', 'utf8');

    vi.spyOn(daemon.hubClient, 'heartbeatTask').mockRejectedValue(
      new HttpError(409, 'POST /tasks/task-lost/heartbeat 409: {"error":"lease_lost"}'),
    );
    const failTask = vi.spyOn(daemon.hubClient, 'failTask');

    await daemon['beatActiveTasks']();

    expect(runtime.stopped).toEqual([instance]);
    expect(daemon['activeInstances'].has('task-lost')).toBe(false);
    expect(failTask).not.toHaveBeenCalled();
    await expect(fs.access(taskFilePath(workdir, 'task-lost'))).rejects.toThrow();
    expect(
      logs.some((l) => l.level === 'error' && l.msg === 'task lease lost, killed local agent'),
    ).toBe(true);
  });

  it('on 404 (task gone): same as 409, kill, cleanup, drop, no failTask', async () => {
    const instance = fakeInstance('furnace');
    daemon['activeInstances'].set('task-gone', { instance, runtimeId: 'mock', startedAt: Date.now() });
    vi.spyOn(daemon.hubClient, 'heartbeatTask').mockRejectedValue(new HttpError(404, 'not found'));
    const failTask = vi.spyOn(daemon.hubClient, 'failTask');

    await daemon['beatActiveTasks']();

    expect(runtime.stopped).toEqual([instance]);
    expect(daemon['activeInstances'].has('task-gone')).toBe(false);
    expect(failTask).not.toHaveBeenCalled();
  });

  it('network errors: logs at info and keeps the instance active for the next beat', async () => {
    const instance = fakeInstance('furnace');
    daemon['activeInstances'].set('task-flaky', { instance, runtimeId: 'mock', startedAt: Date.now() });
    vi.spyOn(daemon.hubClient, 'heartbeatTask').mockRejectedValue(new Error('fetch failed'));

    await daemon['beatActiveTasks']();

    expect(daemon['activeInstances'].has('task-flaky')).toBe(true);
    expect(runtime.stopped).toHaveLength(0);
    expect(
      logs.some((l) => l.level === 'info' && l.msg === 'heartbeat failed, will retry next interval'),
    ).toBe(true);
    expect(logs.some((l) => l.level === 'error')).toBe(false);
  });

  it('wires the heartbeat interval from heartbeatMs at start()', async () => {
    vi.spyOn(daemon.hubClient, 'connect').mockResolvedValue(undefined);
    vi.spyOn(daemon.hubClient, 'close').mockResolvedValue(undefined);
    vi.spyOn(daemon.hubClient, 'listTasks').mockResolvedValue({ tasks: [] });
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    await daemon.start();
    await daemon.stop();

    const heartbeatCalls = setIntervalSpy.mock.calls.filter((c) => c[1] === 60_000);
    expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);
    setIntervalSpy.mockRestore();
  });

  it('heartbeatMs=0 disables the interval entirely', async () => {
    const runtimes2 = new RuntimeRegistry();
    runtimes2.register(new RecordingRuntime());
    const daemon2 = new Daemon({
      hubUrl: 'http://127.0.0.1:1',
      deviceToken: 'tok',
      workdir,
      runtimes: runtimes2,
      defaultRuntimeId: 'mock',
      heartbeatMs: 0,
      logger: makeLogger(logs),
    });
    vi.spyOn(daemon2.hubClient, 'connect').mockResolvedValue(undefined);
    vi.spyOn(daemon2.hubClient, 'close').mockResolvedValue(undefined);
    vi.spyOn(daemon2.hubClient, 'listTasks').mockResolvedValue({ tasks: [] });
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    await daemon2.start();
    await daemon2.stop();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});

describe('M3 issue 4: wall-clock timeout', () => {
  let workdir: string;
  let logs: CapturedLog[];
  let nowMs: number;
  let runtime: RecordingRuntime;
  let daemon: Daemon;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-timeout-'));
    logs = [];
    nowMs = 1_000_000;
    runtime = new RecordingRuntime();
    const runtimes = new RuntimeRegistry();
    runtimes.register(runtime);
    daemon = new Daemon({
      hubUrl: 'http://127.0.0.1:1',
      deviceToken: 'tok',
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      defaultAgentId: 'furnace',
      maxTaskRuntimeMs: 60_000,
      logger: makeLogger(logs),
      now: () => nowMs,
      retrySleep: NOOP_SLEEP,
    });
    vi.spyOn(daemon.hubClient, 'listTasks').mockResolvedValue({ tasks: [] });
    vi.spyOn(daemon.hubClient, 'listInstructions').mockResolvedValue({ instructions: [] });
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('stops the instance and fails the task through the retry helper when maxTaskRuntimeMs is exceeded', async () => {
    const instance = fakeInstance('furnace');
    daemon['activeInstances'].set('task-hung', { instance, runtimeId: 'mock', startedAt: nowMs - 61_000 });
    const failTask = vi.spyOn(daemon.hubClient, 'failTask').mockResolvedValue(undefined);

    await daemon['pollForPendingTasks']();

    expect(runtime.stopped).toEqual([instance]);
    expect(failTask).toHaveBeenCalledWith('task-hung', expect.stringContaining('max runtime exceeded'));
    expect(daemon['activeInstances'].has('task-hung')).toBe(false);
  });

  it('does not time out a task that already finished at the boundary: the done-file path completes it instead', async () => {
    const instance = fakeInstance('furnace');
    runtime.aliveResult = false; // let the poll loop fall through to the finished-instance branch
    daemon['activeInstances'].set('task-finished', { instance, runtimeId: 'mock', startedAt: nowMs - 61_000 });
    await fs.mkdir(taskDir(workdir), { recursive: true });
    await fs.writeFile(doneFilePath(workdir, 'task-finished'), JSON.stringify({ result: 'ok' }), 'utf8');
    const failTask = vi.spyOn(daemon.hubClient, 'failTask');
    const completeTask = vi.spyOn(daemon.hubClient, 'completeTask').mockResolvedValue(undefined);

    await daemon['pollForPendingTasks']();

    expect(failTask).not.toHaveBeenCalled();
    expect(completeTask).toHaveBeenCalledWith('task-finished', 'ok');
    expect(daemon['activeInstances'].has('task-finished')).toBe(false);
  });

  it('_fm_ synthetic exceeding maxTaskRuntimeMs: stop + cleanup + reset fmRunning/cooldown, no hub call', async () => {
    const instance = fakeInstance('forge-master');
    daemon['activeInstances'].set('_fm_hung', { instance, runtimeId: 'mock', startedAt: nowMs - 61_000 });
    daemon['fmRunning'] = true;
    daemon['fmTaskWorkspace'].set('_fm_hung', 'ws-1');
    daemon['lastFmSpawnAt'].set('ws-1', nowMs - 1_000);
    const failTask = vi.spyOn(daemon.hubClient, 'failTask');
    const completeTask = vi.spyOn(daemon.hubClient, 'completeTask');

    await daemon['pollForPendingTasks']();

    expect(runtime.stopped).toEqual([instance]);
    expect(daemon['activeInstances'].has('_fm_hung')).toBe(false);
    expect(daemon['fmRunning']).toBe(false);
    expect(daemon['fmTaskWorkspace'].has('_fm_hung')).toBe(false);
    expect(daemon['lastFmSpawnAt'].has('ws-1')).toBe(false);
    expect(failTask).not.toHaveBeenCalled();
    expect(completeTask).not.toHaveBeenCalled();
  });

  it('maxTaskRuntimeMs=0 disables the timeout check', async () => {
    const runtimes2 = new RuntimeRegistry();
    const runtime2 = new RecordingRuntime();
    runtimes2.register(runtime2);
    const daemon2 = new Daemon({
      hubUrl: 'http://127.0.0.1:1',
      deviceToken: 'tok',
      workdir,
      runtimes: runtimes2,
      defaultRuntimeId: 'mock',
      maxTaskRuntimeMs: 0,
      logger: makeLogger(logs),
      now: () => nowMs,
    });
    vi.spyOn(daemon2.hubClient, 'listTasks').mockResolvedValue({ tasks: [] });
    vi.spyOn(daemon2.hubClient, 'listInstructions').mockResolvedValue({ instructions: [] });
    const instance = fakeInstance('furnace');
    daemon2['activeInstances'].set('task-old', { instance, runtimeId: 'mock', startedAt: nowMs - 999_999_999 });

    await daemon2['pollForPendingTasks']();

    expect(runtime2.stopped).toHaveLength(0);
    expect(daemon2['activeInstances'].has('task-old')).toBe(true);
  });
});

describe('M3 issue 14: bounded terminal retry with deferred cleanup', () => {
  let workdir: string;
  let logs: CapturedLog[];
  let daemon: Daemon;
  let runtime: RecordingRuntime;
  let retrySleepCalls: number[];

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-retry-'));
    logs = [];
    retrySleepCalls = [];
    runtime = new RecordingRuntime();
    const runtimes = new RuntimeRegistry();
    runtimes.register(runtime);
    daemon = new Daemon({
      hubUrl: 'http://127.0.0.1:1',
      deviceToken: 'tok',
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      defaultAgentId: 'furnace',
      terminalRetryLimit: 4,
      logger: makeLogger(logs),
      retrySleep: async (ms: number) => {
        retrySleepCalls.push(ms);
      },
    });
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  async function seedDoneTask(taskId: string): Promise<void> {
    await fs.mkdir(taskDir(workdir), { recursive: true });
    await fs.writeFile(taskFilePath(workdir, taskId), 'x', 'utf8');
    await fs.writeFile(doneFilePath(workdir, taskId), JSON.stringify({ result: 'did the thing' }), 'utf8');
    daemon['activeInstances'].set(taskId, {
      instance: fakeInstance('furnace'),
      runtimeId: 'mock',
      startedAt: Date.now(),
    });
  }

  it('retries completeTask on network errors and cleans up only after a confirmed success', async () => {
    await seedDoneTask('task-flaky-complete');
    const completeTask = vi
      .spyOn(daemon.hubClient, 'completeTask')
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(undefined);

    await daemon['handleTaskDone']('task-flaky-complete', { result: 'did the thing' });

    expect(completeTask).toHaveBeenCalledTimes(3);
    expect(retrySleepCalls).toEqual([1_000, 5_000]);
    await expect(fs.access(doneFilePath(workdir, 'task-flaky-complete'))).rejects.toThrow();
    expect(daemon['activeInstances'].has('task-flaky-complete')).toBe(false);
    expect(logs.some((l) => l.level === 'info' && l.msg === 'task completed')).toBe(true);
  });

  it('a 4xx from completeTask stops retrying immediately and cleans up local state without a success log', async () => {
    await seedDoneTask('task-terminal-4xx');
    const completeTask = vi
      .spyOn(daemon.hubClient, 'completeTask')
      .mockRejectedValue(new HttpError(409, 'already terminal'));

    await daemon['handleTaskDone']('task-terminal-4xx', { result: 'did the thing' });

    expect(completeTask).toHaveBeenCalledTimes(1);
    await expect(fs.access(doneFilePath(workdir, 'task-terminal-4xx'))).rejects.toThrow();
    expect(daemon['activeInstances'].has('task-terminal-4xx')).toBe(false);
    expect(logs.some((l) => l.level === 'info' && l.msg === 'task completed')).toBe(false);
    expect(
      logs.some((l) => l.level === 'info' && l.msg.includes('completeTask returned a 4xx')),
    ).toBe(true);
  });

  it('retry exhaustion keeps the done file and the map entry; the poll loop re-attempts every tick until it succeeds', async () => {
    await seedDoneTask('task-exhausted');
    runtime.aliveResult = false; // let the poll loop reach the finished-instance branch
    vi.spyOn(daemon.hubClient, 'listTasks').mockResolvedValue({ tasks: [] });
    vi.spyOn(daemon.hubClient, 'listInstructions').mockResolvedValue({ instructions: [] });
    const completeTask = vi
      .spyOn(daemon.hubClient, 'completeTask')
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed')) // terminalRetryLimit(4) + 1 = 5 attempts, all fail
      .mockResolvedValueOnce(undefined); // succeeds on the poll loop's re-attempt

    // Tick 1: runs the full retry chain and exhausts it.
    await daemon['pollForPendingTasks']();

    expect(completeTask).toHaveBeenCalledTimes(5);
    expect(daemon['activeInstances'].has('task-exhausted')).toBe(true);
    await expect(fs.access(doneFilePath(workdir, 'task-exhausted'))).resolves.toBeUndefined();
    expect(
      logs.some((l) => l.level === 'error' && l.msg === 'completion unconfirmed, will re-attempt via poll'),
    ).toBe(true);

    // Tick 2: the poll loop's finished-instance branch re-enters handleTaskDone
    // (daemon.ts's old behaviour just deleted the map entry and skipped here).
    await daemon['pollForPendingTasks']();

    expect(completeTask).toHaveBeenCalledTimes(6);
    expect(daemon['activeInstances'].has('task-exhausted')).toBe(false);
    await expect(fs.access(doneFilePath(workdir, 'task-exhausted'))).rejects.toThrow();
  });

  it('R10: saves memory before attempting completeTask', async () => {
    await seedDoneTask('task-r10');
    await fs.writeFile(memoryFilePath(workdir, 'task-r10'), 'some prior session context', 'utf8');
    const callOrder: string[] = [];
    vi.spyOn(daemon.hubClient, 'putAgentMemory').mockImplementation(async () => {
      callOrder.push('memory');
    });
    vi.spyOn(daemon.hubClient, 'completeTask').mockImplementation(async () => {
      callOrder.push('complete');
    });

    await daemon['handleTaskDone']('task-r10', { result: 'did the thing' });

    expect(callOrder).toEqual(['memory', 'complete']);
  });

  it('spawn failure: failTask goes through the retry helper and a 4xx stops it immediately', async () => {
    const failingRuntimes = new RuntimeRegistry();
    failingRuntimes.register(new FailingSpawnRuntime());
    const spawnDaemon = new Daemon({
      hubUrl: 'http://127.0.0.1:1',
      deviceToken: 'tok',
      workdir,
      runtimes: failingRuntimes,
      defaultRuntimeId: 'mock',
      defaultAgentId: 'furnace',
      logger: makeLogger(logs),
      retrySleep: NOOP_SLEEP,
    });
    const failTask = vi
      .spyOn(spawnDaemon.hubClient, 'failTask')
      .mockRejectedValue(new HttpError(404, 'gone'));

    await spawnDaemon['spawnClaimedTask'](fakeTask({ id: 'task-spawn-fail' }));

    expect(failTask).toHaveBeenCalledTimes(1);
    expect(failTask).toHaveBeenCalledWith('task-spawn-fail', expect.stringContaining('spawn failed'));
    expect(
      logs.some((l) => l.level === 'info' && l.msg.includes('failTask returned a 4xx after spawn failure')),
    ).toBe(true);
  });

  it('dead worker: failTask retries on a network error before succeeding', async () => {
    const failTask = vi
      .spyOn(daemon.hubClient, 'failTask')
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(undefined);

    await daemon['handleDeadWorkerTask']('task-dead');

    expect(failTask).toHaveBeenCalledTimes(2);
    expect(retrySleepCalls).toEqual([1_000]);
    expect(logs.some((l) => l.level === 'error' && l.msg === 'marked dead task as failed')).toBe(true);
  });
});

describe('M3 issue 56: stale completion retry vs lease loss (scenario B)', () => {
  let workdir: string;
  let logs: CapturedLog[];
  let runtime: RecordingRuntime;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-scenb-'));
    logs = [];
    runtime = new RecordingRuntime();
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  function makeDaemon(retrySleep: (ms: number) => Promise<void>): Daemon {
    const runtimes = new RuntimeRegistry();
    runtimes.register(runtime);
    const daemon = new Daemon({
      hubUrl: 'http://127.0.0.1:1',
      deviceToken: 'tok',
      workdir,
      runtimes,
      defaultRuntimeId: 'mock',
      defaultAgentId: 'furnace',
      terminalRetryLimit: 4,
      logger: makeLogger(logs),
      retrySleep,
    });
    vi.spyOn(daemon.hubClient, 'listTasks').mockResolvedValue({ tasks: [] });
    vi.spyOn(daemon.hubClient, 'listInstructions').mockResolvedValue({ instructions: [] });
    return daemon;
  }

  async function seedDoneFile(taskId: string, resultText: string): Promise<void> {
    await fs.mkdir(taskDir(workdir), { recursive: true });
    await fs.writeFile(taskFilePath(workdir, taskId), 'x', 'utf8');
    await fs.writeFile(doneFilePath(workdir, taskId), JSON.stringify({ result: resultText }), 'utf8');
  }

  it('lease-lost abort cancels the stale run-1 chain; the hub receives the run-2 result exactly once', async () => {
    // Deterministic interleaving of the live incident: retry chain parks in
    // backoff on a manually-released sleep gate, lease loss fires mid-backoff,
    // a fresh run-2 done file arrives, then the gate opens.
    const parkedSleeps: Array<() => void> = [];
    const daemon = makeDaemon(
      (_ms: number) => new Promise<void>((resolve) => { parkedSleeps.push(resolve); }),
    );

    const attempted: string[] = [];
    const succeeded: string[] = [];
    let runOneAttempts = 0;
    vi.spyOn(daemon.hubClient, 'completeTask').mockImplementation(async (_id: string, res?: string) => {
      const text = res ?? '';
      attempted.push(text);
      if (text === 'run-1 result') {
        runOneAttempts += 1;
        // Hub is down for run-1's first attempt; back up afterwards. Without
        // the abort, the stale chain's second attempt would land and the hub
        // would permanently record run-1's text (the live incident).
        if (runOneAttempts === 1) throw new Error('fetch failed');
      }
      succeeded.push(text);
    });
    vi.spyOn(daemon.hubClient, 'heartbeatTask').mockRejectedValue(
      new HttpError(409, 'POST /tasks/task-b/heartbeat 409: {"error":"lease_lost"}'),
    );

    // Run 1 finishes against a dead hub; the chain enters backoff.
    await seedDoneFile('task-b', 'run-1 result');
    daemon['activeInstances'].set('task-b', {
      instance: fakeInstance('furnace'),
      runtimeId: 'mock',
      startedAt: Date.now(),
    });
    const chain = daemon['handleTaskDone']('task-b', { result: 'run-1 result' });
    await vi.waitFor(() => {
      expect(attempted).toEqual(['run-1 result']);
      expect(parkedSleeps).toHaveLength(1);
    });

    // Hub restarts; the sweep reclaims the lease; heartbeat gets 409. This
    // must abort the parked run-1 chain BEFORE cleanupTaskFiles.
    await daemon['beatActiveTasks']();

    // The task re-runs (re-claimed) and run-2 finishes with a fresh done file.
    await seedDoneFile('task-b', 'run-2 result');
    daemon['activeInstances'].set('task-b', {
      instance: fakeInstance('furnace'),
      runtimeId: 'mock',
      startedAt: Date.now(),
    });
    runtime.aliveResult = false;

    // Open the backoff gate: a pre-fix chain would now fire its second
    // (stale) attempt; the fixed chain has already been woken by the abort.
    for (const release of parkedSleeps) release();
    await chain;

    // Poll tick: the finished-instance branch re-enters handleTaskDone with
    // the run-2 done file (the guard must be clear after the abort).
    await daemon['pollForPendingTasks']();

    expect(succeeded).toEqual(['run-2 result']);
    expect(attempted).toEqual(['run-1 result', 'run-2 result']);
    expect(daemon['activeInstances'].has('task-b')).toBe(false);
    await expect(fs.access(doneFilePath(workdir, 'task-b'))).rejects.toThrow();
    expect(
      logs.some((l) => l.level === 'info' && l.msg === 'aborted in-flight terminal retry after lease loss'),
    ).toBe(true);
    expect(
      logs.some((l) => l.level === 'info' && l.msg === 'completion retry aborted, dropping stale result'),
    ).toBe(true);
  });

  it('re-reads the done file before each attempt and aborts when the content changed', async () => {
    // The sleep swaps the done file for run-2 content mid-backoff, simulating
    // a newer run finishing while the stale chain waits. No abort signal
    // fires here; the pre-attempt disk re-read alone must stop the chain.
    const daemon = makeDaemon(async () => {
      await fs.writeFile(
        doneFilePath(workdir, 'task-swap'),
        JSON.stringify({ result: 'run-2 result' }),
        'utf8',
      );
    });
    const completeTask = vi
      .spyOn(daemon.hubClient, 'completeTask')
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue(undefined);
    await seedDoneFile('task-swap', 'run-1 result');
    daemon['activeInstances'].set('task-swap', {
      instance: fakeInstance('furnace'),
      runtimeId: 'mock',
      startedAt: Date.now(),
    });

    await daemon['handleTaskDone']('task-swap', { result: 'run-1 result' });

    expect(completeTask).toHaveBeenCalledTimes(1);
    const abortLog = logs.find(
      (l) => l.level === 'info' && l.msg === 'completion retry aborted, dropping stale result',
    );
    expect(abortLog).toBeDefined();
    expect(abortLog!.meta).toMatchObject({ taskId: 'task-swap' });
    expect(String(abortLog!.meta?.['reason'])).toContain('changed');
    // An aborted chain touches nothing: the run-2 done file and the map entry survive.
    expect(daemon['activeInstances'].has('task-swap')).toBe(true);
    await expect(fs.access(doneFilePath(workdir, 'task-swap'))).resolves.toBeUndefined();
  });

  it('aborts before the first attempt when the done file is already missing', async () => {
    const daemon = makeDaemon(NOOP_SLEEP);
    const completeTask = vi.spyOn(daemon.hubClient, 'completeTask').mockResolvedValue(undefined);
    // No done file on disk at all (lease-lost cleanup already removed it).

    await daemon['handleTaskDone']('task-gone', { result: 'run-1 result' });

    expect(completeTask).not.toHaveBeenCalled();
    const abortLog = logs.find(
      (l) => l.level === 'info' && l.msg === 'completion retry aborted, dropping stale result',
    );
    expect(abortLog).toBeDefined();
    expect(abortLog!.meta).toMatchObject({ taskId: 'task-gone' });
    expect(String(abortLog!.meta?.['reason'])).toContain('missing');
  });

  it('logs at info when the completingTaskIds guard drops a duplicate done event', async () => {
    const daemon = makeDaemon(NOOP_SLEEP);
    let releaseComplete!: () => void;
    const gate = new Promise<void>((resolve) => { releaseComplete = resolve; });
    const completeTask = vi.spyOn(daemon.hubClient, 'completeTask').mockImplementation(() => gate);
    await seedDoneFile('task-dup', 'r');
    daemon['activeInstances'].set('task-dup', {
      instance: fakeInstance('furnace'),
      runtimeId: 'mock',
      startedAt: Date.now(),
    });

    const first = daemon['handleTaskDone']('task-dup', { result: 'r' });
    await vi.waitFor(() => expect(completeTask).toHaveBeenCalledTimes(1));

    // Duplicate re-entry while the first is in flight: dropped, but LOUDLY.
    await daemon['handleTaskDone']('task-dup', { result: 'r' });

    const dropLogs = logs.filter(
      (l) => l.level === 'info' && l.msg === 'completion already in flight, dropping duplicate done event',
    );
    expect(dropLogs).toHaveLength(1);
    expect(dropLogs[0]!.meta).toMatchObject({ taskId: 'task-dup' });

    releaseComplete();
    await first;
    expect(completeTask).toHaveBeenCalledTimes(1);
    // Guard cleared after the chain finished: not stuck for future done files.
    expect(daemon['completingTaskIds'].size).toBe(0);
  });
});
