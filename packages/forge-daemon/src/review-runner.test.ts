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
}

function makeFakeProcess(): FakeProcess {
  const exitListeners: Array<(code: number | null) => void> = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    stdout,
    stderr,
    kill: () => true,
    on(_event: 'exit', listener: (code: number | null) => void) {
      exitListeners.push(listener);
    },
    get _stdout() {
      return stdout;
    },
    get _stderr() {
      return stderr;
    },
    triggerExit(code: number | null) {
      for (const l of exitListeners) l(code);
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
    expect(authorId).toBe('temper');

    expect(client.completeTask).toHaveBeenCalledWith('rv-001', 'Review by temper complete');
    expect(client.failTask).not.toHaveBeenCalled();
  });

  it('prepends focus to the prompt when reviewConfig includes focus', async () => {
    const { spawner, calls, proc, spawned } = makeFakeSpawner();
    const runner = new ReviewRunner({
      hubClient: client,
      personalityRegistry: registry,
      workdir: '/tmp/workdir',
      spawner,
    });

    const task = makeTask({
      reviewConfig: JSON.stringify({
        reviewer: 'loki',
        targetType: 'diff',
        focus: 'Focus on auth logic',
      }),
    });
    const runPromise = runner.run(task);
    await spawned;
    proc._stdout.push('Auth issue found.\n');
    proc._stdout.end();
    proc.triggerExit(0);
    await runPromise;

    const promptArg = calls[0]!.args.at(-1)!;
    expect(promptArg).toMatch(/^Focus on auth logic/);
    expect(promptArg).toContain('--- a/foo.ts');
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
});
