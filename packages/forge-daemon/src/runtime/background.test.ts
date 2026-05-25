import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  BackgroundRuntime,
  type BackgroundProcess,
  type BackgroundSpawner,
} from './background.js';
import { doneFilePath, taskFilePath } from '../sync/task-file.js';

// ---------------------------------------------------------------------------
// Fake process factory
// ---------------------------------------------------------------------------

interface FakeProcess extends BackgroundProcess {
  _killed: boolean;
  triggerExit(code: number | null): void;
}

function makeFakeProcess(pid: number | undefined = process.pid): FakeProcess {
  const exitListeners: Array<(code: number | null) => void> = [];
  let killed = false;
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  return {
    pid,
    get killed() {
      return killed;
    },
    get _killed() {
      return killed;
    },
    kill(_signal?: NodeJS.Signals): boolean {
      killed = true;
      return true;
    },
    stdout,
    stderr,
    on(_event: 'exit', listener: (code: number | null) => void): void {
      exitListeners.push(listener);
    },
    triggerExit(code: number | null): void {
      for (const l of exitListeners) l(code);
    },
  };
}

interface RecordedSpawn {
  command: string;
  args: string[];
  options: { cwd?: string; env?: NodeJS.ProcessEnv };
}

function makeFakeSpawner(proc?: FakeProcess): {
  spawner: BackgroundSpawner;
  calls: RecordedSpawn[];
  proc: FakeProcess;
} {
  const calls: RecordedSpawn[] = [];
  const fakeProc = proc ?? makeFakeProcess();
  const spawner: BackgroundSpawner = {
    spawn(command, args, options) {
      calls.push({ command, args: [...args], options });
      return fakeProc;
    },
  };
  return { spawner, calls, proc: fakeProc };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackgroundRuntime', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-bg-'));
    await fs.mkdir(path.join(workdir, '.forge', 'tasks'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('creates log dir and log file on spawn', async () => {
    const { spawner } = makeFakeSpawner();
    const rt = new BackgroundRuntime({ spawner });

    await rt.spawn(
      { agentId: 'furnace', personality: 'You are Furnace.', workdir, taskId: 'fl-010', config: {} },
      'start work',
    );

    const logPath = path.join(workdir, 'context', 'agent-logs', 'fl-010.log');
    await expect(fs.access(logPath)).resolves.toBeUndefined();
  });

  it('spawns claude with --system-prompt and initial prompt as trailing arg', async () => {
    const { spawner, calls } = makeFakeSpawner();
    const rt = new BackgroundRuntime({ claudePath: 'claude', spawner });

    await rt.spawn(
      { agentId: 'furnace', personality: 'sys-prompt', workdir, taskId: 'fl-011', config: {} },
      'do the thing',
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('claude');
    expect(call.args).toContain('--system-prompt');
    const sysIdx = call.args.indexOf('--system-prompt');
    expect(call.args[sysIdx + 1]).toBe('sys-prompt');
    expect(call.args[call.args.length - 1]).toBe('do the thing');
    expect(call.args).not.toContain('--dangerously-skip-permissions');
    expect(call.options.cwd).toBe(workdir);
  });

  it('includes --print flag for non-interactive mode', async () => {
    const { spawner, calls } = makeFakeSpawner();
    const rt = new BackgroundRuntime({ claudePath: 'claude', spawner });

    await rt.spawn(
      { agentId: 'a', personality: 'sys', workdir, taskId: 'task-1', config: {} },
      'do the thing',
    );

    const call = calls[0]!;
    expect(call.args[0]).toBe('--print');
  });

  it('includes --dangerously-skip-permissions when option is set', async () => {
    const { spawner, calls } = makeFakeSpawner();
    const rt = new BackgroundRuntime({ spawner, dangerouslySkipPermissions: true });

    await rt.spawn(
      { agentId: 'furnace', personality: 'sys', workdir, taskId: 'fl-012', config: {} },
      'go',
    );

    expect(calls[0]!.args).toContain('--dangerously-skip-permissions');
  });

  it('pipes stdout and stderr output to the log file', async () => {
    const proc = makeFakeProcess();
    const { spawner } = makeFakeSpawner(proc);
    const rt = new BackgroundRuntime({ spawner });

    await rt.spawn(
      { agentId: 'furnace', personality: 'sys', workdir, taskId: 'fl-013', config: {} },
      'go',
    );

    const logPath = path.join(workdir, 'context', 'agent-logs', 'fl-013.log');

    // Write to stdout and stderr streams, then close them
    (proc.stdout as PassThrough).write('stdout line\n');
    (proc.stderr as PassThrough).write('stderr line\n');
    (proc.stdout as PassThrough).end();
    (proc.stderr as PassThrough).end();

    // Wait for the write stream to flush
    await new Promise((r) => setTimeout(r, 50));

    const content = await fs.readFile(logPath, 'utf8');
    expect(content).toContain('stdout line');
    expect(content).toContain('stderr line');
  });

  it('removes instance from map when process exits', async () => {
    const proc = makeFakeProcess();
    const { spawner } = makeFakeSpawner(proc);
    const rt = new BackgroundRuntime({ spawner });

    await fs.writeFile(taskFilePath(workdir, 'fl-014'), '# fl-014\n', 'utf8');
    const instance = await rt.spawn(
      { agentId: 'furnace', personality: 'sys', workdir, taskId: 'fl-014', config: {} },
      'go',
    );

    // Before exit — alive based on task file
    expect(await rt.isAlive(instance)).toBe(true);

    // Trigger exit — instance removed from map
    proc.triggerExit(0);

    // After exit — instance no longer tracked, isAlive returns false
    expect(await rt.isAlive(instance)).toBe(false);
  });

  it('isAlive returns true while task file exists and no done marker present', async () => {
    const proc = makeFakeProcess();
    const { spawner } = makeFakeSpawner(proc);
    const rt = new BackgroundRuntime({ spawner });

    await fs.writeFile(taskFilePath(workdir, 'fl-015'), '# fl-015\n', 'utf8');
    const instance = await rt.spawn(
      { agentId: 'furnace', personality: 'sys', workdir, taskId: 'fl-015', config: {} },
      'go',
    );

    expect(await rt.isAlive(instance)).toBe(true);

    await fs.writeFile(doneFilePath(workdir, 'fl-015'), '{"result":"done"}', 'utf8');
    expect(await rt.isAlive(instance)).toBe(false);
  });

  it('isAlive returns false when task file is missing', async () => {
    const { spawner } = makeFakeSpawner();
    const rt = new BackgroundRuntime({ spawner });
    const instance = await rt.spawn(
      { agentId: 'furnace', personality: 'sys', workdir, taskId: 'fl-016', config: {} },
      'go',
    );
    // no task file written — isAlive should be false
    expect(await rt.isAlive(instance)).toBe(false);
  });

  it('isAlive returns false for unknown instance id', async () => {
    const { spawner } = makeFakeSpawner();
    const rt = new BackgroundRuntime({ spawner });
    const instance = await rt.spawn(
      { agentId: 'furnace', personality: 'sys', workdir, taskId: 'fl-017', config: {} },
      'go',
    );
    // Mutate id to simulate unknown instance
    const unknown = { ...instance, id: 'does-not-exist' };
    expect(await rt.isAlive(unknown)).toBe(false);
  });

  it('stop sends SIGTERM and removes instance from map', async () => {
    const proc = makeFakeProcess();
    const { spawner } = makeFakeSpawner(proc);
    const rt = new BackgroundRuntime({ spawner });

    await fs.writeFile(taskFilePath(workdir, 'fl-018'), '# fl-018\n', 'utf8');
    const instance = await rt.spawn(
      { agentId: 'furnace', personality: 'sys', workdir, taskId: 'fl-018', config: {} },
      'go',
    );

    await rt.stop(instance);

    expect(proc._killed).toBe(true);
    expect(await rt.isAlive(instance)).toBe(false);
    await expect(fs.access(taskFilePath(workdir, 'fl-018'))).rejects.toThrow();
  });

  it('stop on unknown instance id is a no-op', async () => {
    const { spawner } = makeFakeSpawner();
    const rt = new BackgroundRuntime({ spawner });
    const instance = await rt.spawn(
      { agentId: 'furnace', personality: 'sys', workdir, taskId: 'fl-019', config: {} },
      'go',
    );
    const unknown = { ...instance, id: 'does-not-exist' };
    await expect(rt.stop(unknown)).resolves.toBeUndefined();
  });

  it('sendInstruction throws with clear "not supported" message', async () => {
    const { spawner } = makeFakeSpawner();
    const rt = new BackgroundRuntime({ spawner });
    const instance = await rt.spawn(
      { agentId: 'furnace', personality: 'sys', workdir, taskId: 'fl-020', config: {} },
      'go',
    );
    await expect(rt.sendInstruction(instance, 'hello')).rejects.toThrow(
      /not support/i,
    );
  });

  it('log dir is created recursively if absent', async () => {
    const { spawner } = makeFakeSpawner();
    const rt = new BackgroundRuntime({ spawner });

    // Spawn into a deep workdir that has no context/agent-logs yet
    const deepWorkdir = path.join(workdir, 'nested', 'project');
    await fs.mkdir(path.join(deepWorkdir, '.forge', 'tasks'), { recursive: true });

    await rt.spawn(
      { agentId: 'furnace', personality: 'sys', workdir: deepWorkdir, taskId: 'fl-021', config: {} },
      'go',
    );

    const logDir = path.join(deepWorkdir, 'context', 'agent-logs');
    await expect(fs.access(logDir)).resolves.toBeUndefined();
  });

  it('exposes correct runtime metadata', async () => {
    const { spawner } = makeFakeSpawner();
    const rt = new BackgroundRuntime({ spawner });
    expect(rt.id).toBe('background');
    expect(rt.displayName).toContain('Background');
    expect(rt.capabilities.supportsTools).toBe(true);
  });

  it('throws immediately when taskId is null (C5: no silent ephemeral id generation)', async () => {
    const { spawner } = makeFakeSpawner();
    const rt = new BackgroundRuntime({ spawner });
    await expect(
      rt.spawn(
        { agentId: 'furnace', personality: 'sys', workdir, taskId: null, config: {} },
        'go',
      ),
    ).rejects.toThrow(/taskId/);
  });

  it('cleans up logStream fd if spawner.spawn() throws (C1: no fd leak)', async () => {
    const throwingSpawner: BackgroundSpawner = {
      spawn() {
        throw new Error('spawn failed');
      },
    };
    const rt = new BackgroundRuntime({ spawner: throwingSpawner });
    await expect(
      rt.spawn(
        { agentId: 'furnace', personality: 'sys', workdir, taskId: 'fl-022', config: {} },
        'go',
      ),
    ).rejects.toThrow('spawn failed');
    // Log file should have been created then destroyed — directory exists, file may exist
    // but the stream is closed (no open fd leak). We verify spawn threw cleanly.
  });

  it('empty personality falls back to non-empty default (guard against blank --system-prompt)', async () => {
    const { spawner, calls } = makeFakeSpawner();
    const rt = new BackgroundRuntime({ claudePath: 'claude', spawner });

    await rt.spawn(
      { agentId: 'a', personality: '', workdir, taskId: 'fl-023', config: {} },
      'do the thing',
    );

    const call = calls[0]!;
    const sysIdx = call.args.indexOf('--system-prompt');
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    const personalityArg = call.args[sysIdx + 1]!;
    expect(personalityArg.trim().length).toBeGreaterThan(0);
  });
});
