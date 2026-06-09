import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import type { Task } from '@forge-lab/core';
import { PersonalityRegistry } from '@forge-lab/agents';
import { ReviewRunner, type ReviewProcess, type ReviewSpawner } from './review-runner.js';
import type { HubClient } from './hub-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeProcess extends ReviewProcess {
  _stdout: PassThrough;
  _stderr: PassThrough;
  triggerExit(code: number | null): void;
  triggerError(err: Error): void;
}

function makeFakeProcess(): FakeProcess {
  const closeListeners: Array<(code: number | null) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    stdout,
    stderr,
    kill: () => true,
    on(event: 'close' | 'error', listener: ((code: number | null) => void) & ((err: Error) => void)) {
      if (event === 'close') closeListeners.push(listener as (code: number | null) => void);
      else errorListeners.push(listener as (err: Error) => void);
    },
    get _stdout() {
      return stdout;
    },
    get _stderr() {
      return stderr;
    },
    triggerExit(code: number | null) {
      for (const l of closeListeners) l(code);
    },
    triggerError(err: Error) {
      for (const l of errorListeners) l(err);
    },
  };
}

interface SpawnRecord {
  command: string;
  args: string[];
}

function makeFakeSpawner(proc?: FakeProcess): {
  spawner: ReviewSpawner;
  calls: SpawnRecord[];
  proc: FakeProcess;
  /** Resolves once spawn() has been called — safe to trigger exit/data after awaiting. */
  spawned: Promise<void>;
} {
  const p = proc ?? makeFakeProcess();
  const calls: SpawnRecord[] = [];
  let resolveSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => {
    resolveSpawned = resolve;
  });
  const spawner: ReviewSpawner = {
    spawn(command, args) {
      calls.push({ command, args });
      resolveSpawned();
      return p;
    },
  };
  return { spawner, calls, proc: p, spawned };
}

function makeRegistry(ids: string[] = ['temper', 'loki', 'crucible']): PersonalityRegistry {
  const reg = new PersonalityRegistry();
  for (const id of ids) {
    reg.register({
      id,
      name: id,
      description: `${id} reviewer`,
      systemPrompt: `You are ${id}.`,
      tags: [],
      preferredTools: [],
      runtimeHints: {},
    });
  }
  return reg;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'rv-001',
    workspaceId: null,
    projectPrefix: 'rv',
    title: 'Review: some diff',
    description: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new',
    status: 'in_progress',
    priority: 'normal',
    assignedDeviceId: null,
    assignedAgentId: null,
    assignedAt: null,
    parentId: null,
    goalId: null,
    createdBy: 'user:u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    taskKind: 'review',
    reviewConfig: JSON.stringify({ reviewer: 'temper', targetType: 'diff' }),
    ...overrides,
  };
}

function makeMockClient(): HubClient {
  return {
    postComment: vi.fn().mockResolvedValue({ id: 'cmt-001' }),
    completeTask: vi.fn().mockResolvedValue(undefined),
    failTask: vi.fn().mockResolvedValue(undefined),
  } as unknown as HubClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewRunner', () => {
  let registry: PersonalityRegistry;
  let client: HubClient;

  beforeEach(() => {
    registry = makeRegistry();
    client = makeMockClient();
  });

  it('spawns claude --print with reviewer system prompt and posts findings as comment', async () => {
    const { spawner, calls, proc, spawned } = makeFakeSpawner();
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
    });

    const task = makeTask();
    const runPromise = runner.run(task);
    // Wait until spawn() is called before feeding data — composeSystemPrompt has async I/O
    await spawned;
    proc._stdout.push('Findings: looks good.\n');
    proc._stdout.end();
    proc.triggerExit(0);
    await runPromise;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain('--print');
    expect(calls[0]!.args).toContain('--system-prompt');
    expect(calls[0]!.args).toContain('You are temper.');

    expect(client.postComment).toHaveBeenCalledOnce();
    const [taskId, body, authorType, authorId] = (client.postComment as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(taskId).toBe('rv-001');
    expect(body).toContain('Findings: looks good.');
    expect(authorType).toBe('agent');
    // authorId is intentionally omitted — hub validates it against agentInstances,
    // which don't contain personality names; the hub falls back to device.id.
    expect(authorId).toBeUndefined();

    expect(client.completeTask).toHaveBeenCalledWith('rv-001', 'Review by temper complete');
    expect(client.failTask).not.toHaveBeenCalled();
  });

  it('resolves diff via git for branch target type and posts findings', async () => {
    const { spawner, calls, proc, spawned } = makeFakeSpawner();
    const fakeDiff = '--- a/auth.ts\n+++ b/auth.ts\n@@ -1 +1 @@\n-old\n+new';
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
      defaultRepoPath: '/repo',
      commandRunner: async (cmd, args) => {
        if (cmd === 'git' && args[0] === 'diff') return fakeDiff;
        throw new Error(`unexpected command: ${cmd}`);
      },
    });

    const task = makeTask({
      reviewConfig: JSON.stringify({ reviewer: 'loki', targetType: 'branch', targetValue: 'feature/auth' }),
      description: null,
    });
    const runPromise = runner.run(task);
    await spawned;
    proc._stdout.push('Auth issue found.\n');
    proc._stdout.end();
    proc.triggerExit(0);
    await runPromise;

    const promptArg = calls[0]!.args.at(-1)!;
    expect(promptArg).toContain('--- a/auth.ts');
    expect(client.postComment).toHaveBeenCalledOnce();
    expect(client.completeTask).toHaveBeenCalledWith('rv-001', 'Review by loki complete');
  });

  it('prepends description as context for branch type review', async () => {
    const fakeDiff = '--- a/auth.ts\n+++ b/auth.ts\n@@ -1 +1 @@\n-old\n+new';
    const proc = makeFakeProcess();
    const calls: SpawnRecord[] = [];
    // Self-feeding spawner: queues data+exit in a microtask so listeners are set up first
    const spawner: ReviewSpawner = {
      spawn(command, args) {
        calls.push({ command, args });
        queueMicrotask(() => {
          proc._stdout.push('Auth issue found.\n');
          proc._stdout.end();
          proc.triggerExit(0);
        });
        return proc;
      },
    };
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
      commandRunner: async () => fakeDiff,
    });

    const task = makeTask({
      reviewConfig: JSON.stringify({ reviewer: 'loki', targetType: 'branch', targetValue: 'feature/auth', repoPath: '/repo' }),
      description: 'Focus on auth logic',
    });
    await runner.run(task);

    const promptArg = calls[0]!.args.at(-1)!;
    expect(promptArg).toMatch(/^Focus on auth logic/);
    expect(promptArg).toContain('--- a/auth.ts');
    expect(client.postComment).toHaveBeenCalledOnce();
    expect(client.completeTask).toHaveBeenCalledWith('rv-001', 'Review by loki complete');
  });

  it('resolves diff via gh pr diff for PR target type', async () => {
    const { spawner, calls, proc, spawned } = makeFakeSpawner();
    const fakeDiff = '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-x\n+y';
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
      commandRunner: async (cmd, args) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'diff') return fakeDiff;
        throw new Error(`unexpected command: ${cmd}`);
      },
    });

    const task = makeTask({
      reviewConfig: JSON.stringify({ reviewer: 'temper', targetType: 'pr', targetValue: '42' }),
      description: null,
    });
    const runPromise = runner.run(task);
    await spawned;
    proc._stdout.push('Looks clean.\n');
    proc._stdout.end();
    proc.triggerExit(0);
    await runPromise;

    const promptArg = calls[0]!.args.at(-1)!;
    expect(promptArg).toContain('--- a/foo.ts');
    expect(client.completeTask).toHaveBeenCalledWith('rv-001', 'Review by temper complete');
  });

  it('fails when branch targetType has no repoPath configured', async () => {
    const { spawner } = makeFakeSpawner();
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
      // no defaultRepoPath, no repoPath in config
    });

    const task = makeTask({
      reviewConfig: JSON.stringify({ reviewer: 'temper', targetType: 'branch', targetValue: 'feature/x' }),
    });
    await runner.run(task);

    expect(client.failTask).toHaveBeenCalledWith('rv-001', expect.stringContaining('failed to resolve diff'));
    expect(client.postComment).not.toHaveBeenCalled();
  });

  it('fails the task when reviewConfig is missing', async () => {
    const { spawner } = makeFakeSpawner();
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
    });

    const task = makeTask({ reviewConfig: null });
    await runner.run(task);

    expect(client.failTask).toHaveBeenCalledWith('rv-001', expect.stringContaining('invalid or missing reviewConfig'));
    expect(client.postComment).not.toHaveBeenCalled();
    expect(client.completeTask).not.toHaveBeenCalled();
  });

  it('fails the task when reviewer is not in registry', async () => {
    const { spawner } = makeFakeSpawner();
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
    });

    const task = makeTask({
      reviewConfig: JSON.stringify({ reviewer: 'nonexistent', targetType: 'diff' }),
    });
    await runner.run(task);

    expect(client.failTask).toHaveBeenCalledWith('rv-001', expect.stringContaining('unknown reviewer: nonexistent'));
    expect(client.postComment).not.toHaveBeenCalled();
  });

  it('fails the task when description (diff) is empty', async () => {
    const { spawner } = makeFakeSpawner();
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
    });

    const task = makeTask({ description: '   ' });
    await runner.run(task);

    expect(client.failTask).toHaveBeenCalledWith('rv-001', expect.stringContaining('no diff in description'));
    expect(client.postComment).not.toHaveBeenCalled();
  });

  it('fails the task when claude exits non-zero', async () => {
    const { spawner, proc, spawned } = makeFakeSpawner();
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
    });

    const task = makeTask();
    const runPromise = runner.run(task);
    await spawned;
    proc._stdout.end();
    proc.triggerExit(1);
    await runPromise;

    expect(client.failTask).toHaveBeenCalledWith('rv-001', expect.stringContaining('review process failed'));
    expect(client.postComment).not.toHaveBeenCalled();
  });

  it('truncates findings exceeding 48 000 chars and appends notice', async () => {
    const { spawner, proc, spawned } = makeFakeSpawner();
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
    });

    const task = makeTask();
    const runPromise = runner.run(task);
    await spawned;
    // Push a 50 000-char string
    proc._stdout.push('x'.repeat(50_000));
    proc._stdout.end();
    proc.triggerExit(0);
    await runPromise;

    const [, body] = (client.postComment as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(body.length).toBeLessThanOrEqual(48_000 + 200); // 200 = truncation notice
    expect(body).toContain('truncated');
  });

  it('passes --dangerously-skip-permissions when option is set', async () => {
    const { spawner, calls, proc, spawned } = makeFakeSpawner();
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
      dangerouslySkipPermissions: true,
    });

    const task = makeTask();
    const runPromise = runner.run(task);
    await spawned;
    proc._stdout.push('ok');
    proc._stdout.end();
    proc.triggerExit(0);
    await runPromise;

    expect(calls[0]!.args).toContain('--dangerously-skip-permissions');
  });

  it('fails the task when claude binary is not found (ENOENT)', async () => {
    const { spawner, proc, spawned } = makeFakeSpawner();
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
      claudePath: '/nonexistent/claude',
    });

    const task = makeTask();
    const runPromise = runner.run(task);
    await spawned;
    const enoent = Object.assign(new Error('spawn /nonexistent/claude ENOENT'), { code: 'ENOENT' });
    proc.triggerError(enoent);
    await runPromise;

    expect(client.failTask).toHaveBeenCalledWith('rv-001', expect.stringContaining('review process failed'));
    expect(client.postComment).not.toHaveBeenCalled();
  });
});
