import { describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ClaudeCodeRuntime,
  type RuntimeSpawner,
  type SpawnOptions,
  type SpawnedProcess,
} from './claude-code.js';
import { doneFilePath, taskFilePath } from '../sync/task-file.js';

interface RecordedSpawn {
  command: string;
  args: string[];
  options: SpawnOptions;
}

function makeFakeSpawner(): {
  spawner: RuntimeSpawner;
  calls: RecordedSpawn[];
  fakeProc: SpawnedProcess & { _killed: boolean };
} {
  const calls: RecordedSpawn[] = [];
  const fakeProc = {
    pid: 42,
    _killed: false,
    get killed() {
      return this._killed;
    },
    kill(_signal?: NodeJS.Signals): boolean {
      this._killed = true;
      return true;
    },
  };
  const spawner: RuntimeSpawner = {
    spawn(command, args, options) {
      calls.push({ command, args: [...args], options });
      return fakeProc;
    },
  };
  return { spawner, calls, fakeProc };
}

describe('ClaudeCodeRuntime', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cc-'));
    await fs.mkdir(path.join(workdir, '.forge', 'tasks'), { recursive: true });
  });

  it('spawns Windows Terminal tab with wt.exe when useWindowsTerminal is true', async () => {
    const { spawner, calls } = makeFakeSpawner();
    const rt = new ClaudeCodeRuntime({
      useWindowsTerminal: true,
      claudePath: 'claude',
      tabColor: '#112233',
      spawner,
    });

    const instance = await rt.spawn(
      {
        agentId: 'anvil',
        personality: 'You are Anvil, the forge builder.',
        workdir,
        taskId: 'fl-001',
        config: {},
      },
      'begin',
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('wt.exe');
    expect(call.args).toContain('-w');
    expect(call.args).toContain('0');
    expect(call.args).toContain('new-tab');
    expect(call.args).toContain('--title');
    expect(call.args).toContain('--tabColor');
    expect(call.args).toContain('#112233');
    expect(call.args).toContain('-d');
    expect(call.args).toContain(workdir);
    expect(call.args).toContain('claude');
    expect(call.args).toContain('--system-prompt');
    expect(call.args).toContain('You are Anvil, the forge builder.');
    expect(call.args[call.args.length - 1]).toBe('begin');

    const titleIdx = call.args.indexOf('--title');
    expect(call.args[titleIdx + 1]).toContain('anvil');
    expect(call.args[titleIdx + 1]).toContain('fl-001');

    expect(instance.pid).toBe(42);
    expect(instance.runtimeId).toBe('claude-code');
    expect(instance.agentId).toBe('anvil');
  });

  it('spawns claude directly when useWindowsTerminal is false', async () => {
    const { spawner, calls } = makeFakeSpawner();
    const rt = new ClaudeCodeRuntime({
      useWindowsTerminal: false,
      claudePath: '/usr/local/bin/claude',
      spawner,
    });

    await rt.spawn(
      {
        agentId: 'scribe',
        personality: 'You are Scribe.',
        workdir,
        taskId: 'fl-002',
        config: {},
      },
      'startup',
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('/usr/local/bin/claude');
    expect(call.args).toEqual([
      '--system-prompt',
      'You are Scribe.',
      'startup',
    ]);
    expect(call.options.cwd).toBe(workdir);
    expect(call.options.detached).toBe(true);
  });

  it('isAlive reports true while task file exists and no done marker is present', async () => {
    const { spawner } = makeFakeSpawner();
    const rt = new ClaudeCodeRuntime({ useWindowsTerminal: false, spawner });

    await fs.writeFile(taskFilePath(workdir, 'fl-003'), '# fl-003\n', 'utf8');

    const instance = await rt.spawn(
      {
        agentId: 'a',
        personality: 'sys',
        workdir,
        taskId: 'fl-003',
        config: {},
      },
      'go',
    );

    expect(await rt.isAlive(instance)).toBe(true);

    await fs.writeFile(doneFilePath(workdir, 'fl-003'), '{"result":"done"}', 'utf8');
    expect(await rt.isAlive(instance)).toBe(false);
  });

  it('isAlive is false when task file is missing', async () => {
    const { spawner } = makeFakeSpawner();
    const rt = new ClaudeCodeRuntime({ useWindowsTerminal: false, spawner });
    const instance = await rt.spawn(
      { agentId: 'a', personality: 'sys', workdir, taskId: 'fl-004', config: {} },
      'go',
    );
    expect(await rt.isAlive(instance)).toBe(false);
  });

  it('stop deletes the task file and forgets the instance', async () => {
    const { spawner, fakeProc } = makeFakeSpawner();
    const rt = new ClaudeCodeRuntime({ useWindowsTerminal: false, spawner });

    await fs.writeFile(taskFilePath(workdir, 'fl-005'), '# fl-005\n', 'utf8');
    const instance = await rt.spawn(
      { agentId: 'a', personality: 'sys', workdir, taskId: 'fl-005', config: {} },
      'go',
    );
    expect(await rt.isAlive(instance)).toBe(true);

    await rt.stop(instance);

    expect(fakeProc.killed).toBe(true);
    expect(await rt.isAlive(instance)).toBe(false);
    await expect(fs.access(taskFilePath(workdir, 'fl-005'))).rejects.toThrow();
  });

  it('sendInstruction rejects as not-yet-implemented', async () => {
    const { spawner } = makeFakeSpawner();
    const rt = new ClaudeCodeRuntime({ useWindowsTerminal: false, spawner });
    const instance = await rt.spawn(
      { agentId: 'a', personality: 'sys', workdir, taskId: 'fl-006', config: {} },
      'go',
    );
    await expect(rt.sendInstruction(instance, 'stop what you are doing')).rejects.toThrow(
      /Phase 2/,
    );
  });
});
