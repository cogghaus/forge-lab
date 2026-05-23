import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MockRuntime } from './mock.js';
import { doneFilePath, taskFilePath } from '../sync/task-file.js';

async function waitFor(
  fn: () => Promise<string | null>,
  timeoutMs = 1000,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

describe('MockRuntime', () => {
  it('writes a completion marker after spawn', async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mock-'));
    try {
      const taskId = 'fl-001';
      await fs.mkdir(path.join(workdir, '.forge', 'tasks'), { recursive: true });
      await fs.writeFile(taskFilePath(workdir, taskId), '# fl-001: test\n', 'utf8');

      const rt = new MockRuntime({ completionDelayMs: 5 });
      await rt.spawn(
        {
          agentId: 'a1',
          personality: 'default',
          workdir,
          taskId,
          config: {},
        },
        'run the test task',
      );

      const done = await waitFor(async () => {
        try {
          return await fs.readFile(doneFilePath(workdir, taskId), 'utf8');
        } catch {
          return null;
        }
      });
      expect(done).toBeTruthy();
      const parsed = JSON.parse(done!) as { result: string };
      expect(parsed.result).toContain('mock completed');
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it('isAlive returns true while task file exists and done marker is absent', async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mock-alive-'));
    try {
      const taskId = 'fl-003';
      await fs.mkdir(path.join(workdir, '.forge', 'tasks'), { recursive: true });
      await fs.writeFile(taskFilePath(workdir, taskId), '# fl-003\n', 'utf8');

      const rt = new MockRuntime({ completionDelayMs: 100000 });
      const instance = await rt.spawn(
        { agentId: 'a', personality: 'sys', workdir, taskId, config: {} },
        'work',
      );

      expect(await rt.isAlive(instance)).toBe(true);

      await fs.writeFile(doneFilePath(workdir, taskId), '{"result":"done"}', 'utf8');
      expect(await rt.isAlive(instance)).toBe(false);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it('isAlive returns false when task file is missing', async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mock-nofile-'));
    try {
      const rt = new MockRuntime({ completionDelayMs: 100000 });
      const instance = await rt.spawn(
        { agentId: 'a', personality: 'sys', workdir, taskId: 'fl-004', config: {} },
        'work',
      );
      expect(await rt.isAlive(instance)).toBe(false);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it('uses custom result factory when provided', async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mock-'));
    try {
      const taskId = 'fl-002';
      await fs.mkdir(path.join(workdir, '.forge', 'tasks'), { recursive: true });
      await fs.writeFile(taskFilePath(workdir, taskId), 'task body', 'utf8');

      const rt = new MockRuntime({
        completionDelayMs: 5,
        resultFactory: (ctx) => `processed: ${ctx.prompt}`,
      });
      await rt.spawn(
        { agentId: 'a1', personality: 'default', workdir, taskId, config: {} },
        'hello world',
      );

      const done = await waitFor(async () => {
        try {
          return await fs.readFile(doneFilePath(workdir, taskId), 'utf8');
        } catch {
          return null;
        }
      });
      const parsed = JSON.parse(done!) as { result: string };
      expect(parsed.result).toBe('processed: hello world');
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });
});
