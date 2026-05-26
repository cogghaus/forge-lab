import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import type { EventEnvelope, RuntimeInstance } from '@forge-lab/core';
import { composeSystemPrompt } from '@forge-lab/agents';
import type { PersonalityRegistry } from '@forge-lab/agents';
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
  personalityRegistry?: PersonalityRegistry;
  /** How often the worker loop polls for pending tasks (ms). Default: 5000 */
  pollIntervalMs?: number;
  /** If set, daemon only processes tasks belonging to this workspace. */
  workspaceId?: string;
  logger?: DaemonLogger;
  /**
   * When true, daemon operates as an FM orchestrator: on each poll cycle it
   * fetches the Tier 0 context bundle, requeues stale assignments, then spawns
   * the FM agent if there are pending_dispatcher_action tasks in the inbox.
   * Requires workspaceId to be set.
   */
  dispatcherMode?: boolean;
  /**
   * agentId for the FM agent spawned in dispatcher mode.
   * Defaults to 'forge-master'.
   */
  fmAgentId?: string;
  /**
   * Stale assignment TTL in minutes used when requeueing in dispatcher mode.
   * Defaults to 30.
   */
  staleTtlMinutes?: number;
}

export interface DaemonLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const noopLogger: DaemonLogger = {
  info: () => {},
  error: () => {},
};

interface ActiveInstance {
  instance: RuntimeInstance;
  runtimeId: string;
}

export class Daemon {
  private readonly client: HubClient;
  private readonly runtimes: RuntimeRegistry;
  private readonly opts: DaemonOptions;
  private readonly logger: DaemonLogger;
  private watcher: FSWatcher | null = null;
  private running = false;
  private loopController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private readonly activeInstances = new Map<string, ActiveInstance>();
  /** True while an FM agent is running in dispatcher mode. Prevents double-spawn. */
  private fmRunning = false;

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
    // task.created / task.assigned / task.requeued all funnel through
    // handleIncomingTask. The hub's claim endpoint is an atomic SQL UPDATE
    // guarded by status IN ('pending_agent', 'assigned'), so concurrent
    // daemon instances racing on the same event will produce at most one
    // successful claim — the loser gets a 409 and logs a non-fatal error.
    this.client.on('task.created', (env: EventEnvelope) => {
      void this.handleIncomingTask(env);
    });
    this.client.on('task.assigned', (env: EventEnvelope) => {
      void this.handleIncomingTask(env);
    });
    this.client.on('task.requeued', (env: EventEnvelope) => {
      void this.handleIncomingTask(env);
    });
    const doneListener: DoneListener = (taskId, result) => this.handleTaskDone(taskId, result);
    this.watcher = await watchDoneFiles(this.opts.workdir, doneListener);

    this.loopController = new AbortController();
    this.loopPromise = runWorkerLoop({
      signal: this.loopController.signal,
      pollIntervalMs: this.opts.pollIntervalMs ?? 5000,
      poll: () => this.pollForPendingTasks(),
      logger: this.logger,
    }).catch((err) => {
      this.logger.error('worker loop crashed unexpectedly', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.logger.info('daemon started', { hubUrl: this.opts.hubUrl, workdir: this.opts.workdir });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.loopController?.abort();
    this.loopController = null;
    await this.loopPromise;
    this.loopPromise = null;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    await this.client.close();
    this.logger.info('daemon stopped');
  }

  private async pollForPendingTasks(): Promise<void> {
    for (const [taskId, active] of this.activeInstances) {
      const runtime = this.runtimes.get(active.runtimeId);
      const alive = await runtime.isAlive(active.instance);
      if (!alive) {
        this.logger.error('agent instance appears dead', {
          taskId,
          runtimeId: active.runtimeId,
        });
        this.activeInstances.delete(taskId);
      }
    }

    if (this.opts.dispatcherMode) {
      await this.pollDispatcher();
      return;
    }

    const { tasks } = await this.client.listTasks(this.opts.workspaceId);
    for (const task of tasks) {
      if (task.status === 'pending_agent') {
        await this.handleIncomingTask({
          id: 'poll-synthetic',
          name: 'task.created',
          occurredAt: new Date(),
          source: 'worker-loop',
          payload: { taskId: task.id },
        });
      }
    }
  }

  /**
   * Dispatcher poll cycle (FM orchestrator mode).
   * 1. Requeue stale assigned tasks.
   * 2. Fetch Tier 0 context bundle.
   * 3. Spawn FM agent if inbox is non-empty and FM is not already running.
   */
  private async pollDispatcher(): Promise<void> {
    const workspaceId = this.opts.workspaceId;
    if (!workspaceId) {
      this.logger.error('dispatcherMode requires workspaceId');
      return;
    }
    if (this.fmRunning) {
      this.logger.info('fm agent already running, skipping dispatcher poll');
      return;
    }

    try {
      const staleTtl = this.opts.staleTtlMinutes ?? 30;
      const { requeued } = await this.client.requeueStaleAssigned(workspaceId, staleTtl);
      if (requeued > 0) {
        this.logger.info('requeued stale assigned tasks', { requeued });
      }
    } catch (err) {
      this.logger.error('stale requeue failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let ctx: Awaited<ReturnType<typeof this.client.getWorkspaceContext>>;
    try {
      ctx = await this.client.getWorkspaceContext(workspaceId);
    } catch (err) {
      this.logger.error('failed to fetch workspace context', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (ctx.inboxTasks.length === 0) {
      return;
    }

    this.logger.info('inbox non-empty, spawning FM agent', { count: ctx.inboxTasks.length });

    const fmAgentId = this.opts.fmAgentId ?? 'forge-master';
    const syntheticTaskId = `_fm_${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const runtime = this.runtimes.get(this.opts.defaultRuntimeId);

    const contextJson = JSON.stringify(ctx, null, 2);
    const doneInstruction =
      `\n\n---\nWhen you have finished triaging, write the done file to signal completion:\n` +
      `Create \`.forge/tasks/${syntheticTaskId}.done\` with:\n` +
      `{"result":"<summary of assignments made>","completedAt":"<ISO 8601 timestamp>"}\n` +
      `Write the file with a tool call (Bash, Write, or shell command).`;
    const initialPrompt = `You are the Forge Master orchestrator. Triage the following workspace inbox.\n\n${contextJson}${doneInstruction}`;

    try {
      this.fmRunning = true;
      const instance = await runtime.spawn(
        {
          agentId: fmAgentId,
          personality: this.opts.defaultPersonality ?? 'default',
          workdir: this.opts.workdir,
          taskId: syntheticTaskId,
          config: {},
        },
        initialPrompt,
      );
      this.activeInstances.set(syntheticTaskId, { instance, runtimeId: this.opts.defaultRuntimeId });
      this.logger.info('fm agent spawned', { syntheticTaskId, fmAgentId });
    } catch (err) {
      this.fmRunning = false;
      this.logger.error('failed to spawn FM agent', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleIncomingTask(env: EventEnvelope): Promise<void> {
    const taskId = (env.payload as { taskId?: string }).taskId;
    if (!taskId) return;
    if (this.activeInstances.has(taskId)) return;

    // Pre-claim checks — safe to fail silently.
    try {
      const task = await this.client.getTask(taskId);
      if (task.status !== 'pending_agent' && task.status !== 'assigned') {
        return;
      }
      // Scope guard: when workspaceId is configured this daemon only claims
      // tasks belonging to that workspace. When undefined (no scope), the
      // daemon acts as a global worker and claims tasks from all workspaces —
      // this is intentional for single-machine setups. Production deployments
      // with multiple workspaces should configure FORGE_DAEMON_WORKSPACE_ID.
      if (this.opts.workspaceId !== undefined && task.workspaceId !== this.opts.workspaceId) {
        return;
      }
      await this.client.claimTask(taskId);
    } catch (err) {
      this.logger.error('failed to claim task', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Task is now claimed. Any failure past this point leaves it stuck in_progress.
    // A future failTask() hub endpoint would allow recovery.
    try {
      const claimed = await this.client.getTask(taskId);
      await writeTaskFile(this.opts.workdir, claimed);
      const runtime = this.runtimes.get(this.opts.defaultRuntimeId);
      const agentId = this.opts.defaultAgentId ?? 'default';

      let personalityStr = this.opts.defaultPersonality || 'default';
      const registry = this.opts.personalityRegistry;
      if (registry) {
        const personality = registry.get(agentId);
        if (personality) {
          personalityStr = await composeSystemPrompt({
            personality,
            projectContextPath: path.join(this.opts.workdir, 'context', 'project-context.md'),
            agentOverridesDir: path.join(this.opts.workdir, 'context', 'agent-overrides'),
            handoffDir: path.join(this.opts.workdir, 'context', 'handoffs'),
            taskContext: {
              taskId: claimed.id,
              title: claimed.title,
              description: claimed.description ?? null,
            },
          });
        }
      }

      const MAX_DESC_CHARS = 8_000;
      const desc = claimed.description != null
        ? claimed.description.slice(0, MAX_DESC_CHARS)
        : null;
      // Append mandatory done-file write instruction so agents actually write the
      // marker file rather than just describing it in text output. The instruction
      // names the exact path so agents don't have to infer it from the protocol docs.
      const doneInstruction =
        `\n\n---\nWhen you have completed the task above, you MUST write the done file using ` +
        `a tool (Bash, Write, or shell command). Create \`.forge/tasks/${claimed.id}.done\` with:\n` +
        `{"result":"<one sentence summary of what you did>","completedAt":"<current ISO 8601 timestamp>"}\n` +
        `Do not just describe writing the file — actually write it with a tool call.`;
      const initialPrompt = desc != null
        ? `${claimed.title}\n\n${desc}${doneInstruction}`
        : `${claimed.title}${doneInstruction}`;
      const instance = await runtime.spawn(
        {
          agentId,
          personality: personalityStr,
          workdir: this.opts.workdir,
          taskId: claimed.id,
          config: {},
        },
        initialPrompt,
      );
      this.activeInstances.set(claimed.id, { instance, runtimeId: this.opts.defaultRuntimeId });
      this.logger.info('task spawned', { taskId: claimed.id, runtime: this.opts.defaultRuntimeId });
    } catch (err) {
      this.logger.error('task claimed but spawn failed — task stuck in_progress', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleTaskDone(taskId: string, result: DoneResult): Promise<void> {
    // Synthetic FM tasks (prefixed with _fm_) are not tracked in the hub.
    if (taskId.startsWith('_fm_')) {
      try {
        await cleanupTaskFiles(this.opts.workdir, taskId);
      } catch (err) {
        this.logger.error('failed to cleanup FM task files', {
          taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.activeInstances.delete(taskId);
      this.fmRunning = false;
      this.logger.info('fm agent completed', { taskId, result: result.result });
      return;
    }

    try {
      await this.client.completeTask(taskId, result.result);
      await cleanupTaskFiles(this.opts.workdir, taskId);
      this.activeInstances.delete(taskId);
      this.logger.info('task completed', { taskId });
    } catch (err) {
      this.logger.error('failed to complete task', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
