import { promises as fs } from 'node:fs';
import { nanoid } from 'nanoid';
import type {
  AgentRuntime,
  AgentRuntimeSpawnConfig,
  RuntimeInstance,
} from '@forge-lab/core';
import { doneFilePath, taskFilePath } from '../sync/task-file.js';

export interface MockRuntimeOptions {
  /** Milliseconds to wait before writing the completion marker. */
  completionDelayMs?: number;
  /** Custom result factory for tests that want to assert on content. */
  resultFactory?: (ctx: {
    taskId: string;
    prompt: string;
    personality: string;
    taskFileContent: string;
  }) => string;
}

/**
 * Runtime that simulates an agent completing a task. Reads the task file the
 * daemon wrote and produces a completion marker so the daemon's file watcher
 * can report completion back to the hub. Drives the Phase 1 integration test.
 */
export class MockRuntime implements AgentRuntime {
  readonly id = 'mock';
  readonly displayName = 'Mock Runtime';
  readonly capabilities = { supportsStreaming: false, supportsTools: false } as const;

  private readonly opts: MockRuntimeOptions;

  constructor(opts: MockRuntimeOptions = {}) {
    this.opts = opts;
  }

  spawn(
    config: AgentRuntimeSpawnConfig,
    initialPrompt: string,
  ): Promise<RuntimeInstance> {
    const taskId = config.taskId;
    if (!taskId) throw new Error('MockRuntime requires a taskId');
    const delay = this.opts.completionDelayMs ?? 10;
    const workdir = config.workdir;
    const resultFactory = this.opts.resultFactory;

    setTimeout(() => {
      void (async () => {
        const taskFile = taskFilePath(workdir, taskId);
        let content = '';
        try {
          content = await fs.readFile(taskFile, 'utf8');
        } catch {
          // task file not present yet
        }
        const result = resultFactory
          ? resultFactory({ taskId, prompt: initialPrompt, personality: config.personality, taskFileContent: content })
          : `mock completed ${taskId}`;
        const payload = JSON.stringify({
          result,
          completedAt: new Date().toISOString(),
        });
        await fs.writeFile(doneFilePath(workdir, taskId), payload, 'utf8');
      })();
    }, delay);

    return Promise.resolve({
      id: nanoid(),
      runtimeId: this.id,
      agentId: config.agentId,
      pid: null,
      startedAt: new Date(),
      metadata: { prompt: initialPrompt, personality: config.personality, config },
    });
  }

  sendInstruction(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  async isAlive(instance: RuntimeInstance): Promise<boolean> {
    const spawnConfig = instance.metadata['config'] as AgentRuntimeSpawnConfig;
    if (!spawnConfig?.taskId) return false;
    const [hasTask, hasDone] = await Promise.all([
      fileExists(taskFilePath(spawnConfig.workdir, spawnConfig.taskId)),
      fileExists(doneFilePath(spawnConfig.workdir, spawnConfig.taskId)),
    ]);
    return hasTask && !hasDone;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
