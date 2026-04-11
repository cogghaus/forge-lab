import type { FSWatcher } from 'node:fs';
import type { EventEnvelope } from '@forge-lab/core';
import { HubClient } from './hub-client.js';
import { RuntimeRegistry } from './runtime/registry.js';
import {
  cleanupTaskFiles,
  watchDoneFiles,
  writeTaskFile,
  type DoneListener,
  type DoneResult,
} from './sync/task-file.js';
import { runWorkerLoop } from './worker-loop/loop.js';

export interface DaemonOptions {
  hubUrl: string;
  deviceToken: string;
  workdir: string;
  runtimes: RuntimeRegistry;
  defaultRuntimeId: string;
  defaultAgentId?: string;
  defaultPersonality?: string;
  logger?: DaemonLogger;
}

export interface DaemonLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const noopLogger: DaemonLogger = {
  info: () => {},
  error: () => {},
};

export class Daemon {
  private readonly client: HubClient;
  private readonly runtimes: RuntimeRegistry;
  private readonly opts: DaemonOptions;
  private readonly logger: DaemonLogger;
  private watcher: FSWatcher | null = null;
  private running = false;

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.runtimes = opts.runtimes;
    this.logger = opts.logger ?? noopLogger;
    this.client = new HubClient({ hubUrl: opts.hubUrl, deviceToken: opts.deviceToken });
  }

  get hubClient(): HubClient {
    return this.client;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.client.connect();
    this.client.on('task.created', (env: EventEnvelope) => {
      void this.handleIncomingTask(env);
    });
    this.client.on('task.assigned', (env: EventEnvelope) => {
      void this.handleIncomingTask(env);
    });
    const doneListener: DoneListener = (taskId, result) => this.handleTaskDone(taskId, result);
    this.watcher = await watchDoneFiles(this.opts.workdir, doneListener);
    this.logger.info('daemon started', { hubUrl: this.opts.hubUrl, workdir: this.opts.workdir });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    await this.client.close();
    this.logger.info('daemon stopped');
  }

  private async handleIncomingTask(env: EventEnvelope): Promise<void> {
    const taskId = (env.payload as { taskId?: string }).taskId;
    if (!taskId) return;
    try {
      const task = await this.client.getTask(taskId);
      if (task.status !== 'pending_agent' && task.status !== 'assigned') {
        return;
      }
      await this.client.claimTask(taskId);
      const claimed = await this.client.getTask(taskId);
      await writeTaskFile(this.opts.workdir, claimed);
      const runtime = this.runtimes.get(this.opts.defaultRuntimeId);
      await runtime.spawn(
        {
          agentId: this.opts.defaultAgentId ?? 'default',
          personality: this.opts.defaultPersonality ?? 'default',
          workdir: this.opts.workdir,
          taskId: claimed.id,
          config: {},
        },
        claimed.title,
      );
      this.logger.info('task spawned', { taskId: claimed.id, runtime: this.opts.defaultRuntimeId });
    } catch (err) {
      this.logger.error('failed to handle incoming task', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleTaskDone(taskId: string, result: DoneResult): Promise<void> {
    try {
      await this.client.completeTask(taskId, result.result);
      await cleanupTaskFiles(this.opts.workdir, taskId);
      this.logger.info('task completed', { taskId });
      await runWorkerLoop({
        hasMoreWork: async () => {
          const { tasks } = await this.client.listTasks();
          return tasks.some((t) => t.status === 'pending_agent');
        },
        onMoreWork: async () => {
          const { tasks } = await this.client.listTasks();
          const next = tasks.find((t) => t.status === 'pending_agent');
          if (next) {
            await this.handleIncomingTask({
              id: 'synthetic',
              name: 'task.created',
              occurredAt: new Date(),
              source: 'worker-loop',
              payload: { taskId: next.id },
            });
          }
        },
      });
    } catch (err) {
      this.logger.error('failed to complete task', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
