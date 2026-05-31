import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import type { EventEnvelope, RuntimeInstance, Task } from '@forge-lab/core';
import { composeSystemPrompt } from '@forge-lab/agents';
import type { PersonalityRegistry } from '@forge-lab/agents';
import { HubClient } from './hub-client.js';
import { RuntimeRegistry } from './runtime/registry.js';
import {
  cleanupTaskFiles,
  readAgentLogTail,
  readDoneFile,
  resetAgentLog,
  watchDoneFiles,
  writeTaskFile,
  writeSyntheticTaskFile,
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
   * Personality ID used for the FM agent spawned in dispatcher mode.
   * Must be registered in `personalityRegistry`. When set and the registry
   * contains the ID, the full personality system prompt is composed and
   * passed to the runtime. When unset or missing from the registry, falls
   * back to a minimal system prompt string.
   * Defaults to 'forge-master'.
   */
  dispatcherPersonality?: string;
  /**
   * Stale assignment TTL in minutes used when requeueing in dispatcher mode.
   * Defaults to 30.
   */
  staleTtlMinutes?: number;
  /**
   * Maximum number of tasks running concurrently on this daemon instance.
   * When activeInstances reaches this limit, incoming task events are skipped
   * until a slot opens. Default: no limit (all tasks claimed immediately).
   */
  maxConcurrentTasks?: number;
  /**
   * When true, daemon subscribes to `task.completed` events and evaluates each
   * completion for documentation significance. If the task is deemed significant
   * (schema changes, new endpoints, architectural decisions, etc.), a new
   * doc-update task is created and assigned to `scribeAgentId` so the Scribe
   * daemon can pick it up automatically.
   *
   * Requires `workspaceId` to be set (Scribe tasks are workspace-scoped).
   */
  listenCompletions?: boolean;
  /**
   * Agent ID to assign auto-created documentation tasks when `listenCompletions`
   * is true. Defaults to 'scribe'.
   */
  scribeAgentId?: string;
  /**
   * Number of task completions (in the daemon's workspace scope) that trigger a
   * Scribe knowledge-base audit task. When this threshold is reached the counter
   * resets to zero and one `[Scribe Audit]` task is created pre-assigned to
   * `scribeAgentId`. Only meaningful when `listenCompletions` is true and
   * `workspaceId` is set. When unset, no audit task is ever created automatically.
   */
  auditThreshold?: number;
  /**
   * Max WebSocket reconnect attempts after an unexpected disconnect. A daemon is
   * long-lived, so it defaults to Infinity (never permanently give up): a hub
   * outage longer than a finite attempt budget previously left the daemon a
   * silent zombie with no event stream until manual restart.
   */
  reconnectMaxAttempts?: number;
  /** Per-request HTTP timeout in ms passed to the hub client. Default: 30000. */
  requestTimeoutMs?: number;
  /**
   * How many times to re-spawn a worker task whose agent died with a transient
   * auth-failure signature (e.g. the shared OAuth token rotating mid-run). The
   * winning daemon writes fresh credentials, so a retry reads a valid token.
   * After the limit the task is marked failed instead of stuck in_progress.
   * Default: 2.
   */
  authRetryLimit?: number;
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
  /**
   * Rolling count of task.completed events received within this daemon's workspace
   * scope since the last audit task was created (or since daemon start). When it
   * reaches `opts.auditThreshold`, a Scribe audit task is created and the counter
   * resets to zero.
   */
  private completionsSinceAudit = 0;
  /**
   * Per-task count of auth-failure re-spawns (see {@link DaemonOptions.authRetryLimit}).
   * Cleared on completion or when the task is failed.
   */
  private readonly taskRetries = new Map<string, number>();

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    this.runtimes = opts.runtimes;
    this.logger = opts.logger ?? noopLogger;
    this.client = new HubClient({
      hubUrl: opts.hubUrl,
      deviceToken: opts.deviceToken,
      reconnectMaxAttempts: opts.reconnectMaxAttempts ?? Number.POSITIVE_INFINITY,
      // Only forward when set: exactOptionalPropertyTypes forbids passing
      // `undefined`, and the client defaults requestTimeoutMs to 30s anyway.
      ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    });
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
    if (this.opts.listenCompletions) {
      this.client.on('task.completed', (env: EventEnvelope) => {
        void this.handleTaskCompleted(env);
      });
    }
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
    // Snapshot: the worker self-heal path below may re-spawn a task (mutating
    // activeInstances), which must not perturb this iteration.
    for (const [taskId, active] of [...this.activeInstances]) {
      const runtime = this.runtimes.get(active.runtimeId);
      const alive = await runtime.isAlive(active.instance);
      if (alive) continue;

      // isAlive() is false for two very different reasons: the agent finished
      // (its done file is present — the done-watcher will handle completion and
      // reset fmRunning), or it genuinely died. Only the latter is an error.
      const finished = (await readDoneFile(this.opts.workdir, taskId)) !== null;
      this.activeInstances.delete(taskId);
      if (finished) continue;

      this.logger.error('agent instance appears dead', {
        taskId,
        runtimeId: active.runtimeId,
      });
      // A dead FM agent that never wrote its done file would otherwise leave
      // fmRunning stuck true and wedge the dispatcher forever. Reset it so the
      // next poll can re-spawn FM, and remove the orphaned synthetic marker.
      if (taskId.startsWith('_fm_')) {
        this.fmRunning = false;
        await cleanupTaskFiles(this.opts.workdir, taskId).catch(() => {});
        continue;
      }
      // A dead worker task: self-heal a transient auth failure by re-spawning,
      // else fail it so it is not left stuck in_progress.
      await this.handleDeadWorkerTask(taskId);
    }

    if (this.opts.dispatcherMode) {
      await this.pollDispatcher();
      return;
    }

    const { tasks } = await this.client.listTasks(this.opts.workspaceId);
    const myAgentId = this.opts.defaultAgentId;
    for (const task of tasks) {
      // Pick up unrouted work (pending_agent) AND work the dispatcher routed to
      // this worker (status=assigned, assignedAgentId === ours). The poll used to
      // ignore 'assigned', so a worker that missed the live task.assigned event —
      // e.g. it was down when FM assigned — never discovered its own assigned task
      // and it stranded until the 30-minute stale-assigned requeue.
      const claimable =
        task.status === 'pending_agent' ||
        (task.status === 'assigned' &&
          myAgentId !== undefined &&
          task.assignedAgentId === myAgentId);
      if (claimable) {
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
   * Markers in a dead agent's log that indicate a transient auth failure (the
   * shared OAuth token rotating mid-run), as opposed to a real task failure.
   */
  // Anchored on the claude CLI's own auth prompts ("... · Please run /login")
  // and OAuth refresh failures — phrases unlikely to appear in normal task
  // output, to avoid misclassifying a real crash whose text mentions auth.
  private static readonly AUTH_FAILURE_RE =
    /please run \/login|invalid_grant|invalid api key|oauth[^\n]{0,40}(expired|invalid|error)/i;

  /**
   * A worker task whose agent died without writing its done file. If the agent
   * log shows a transient auth failure and we're under the retry limit, re-spawn
   * (by now the winning daemon has written fresh shared credentials). Otherwise
   * fail the task so it is not left stuck in_progress.
   */
  private async handleDeadWorkerTask(taskId: string): Promise<void> {
    const limit = this.opts.authRetryLimit ?? 2;
    const logTail = await readAgentLogTail(this.opts.workdir, taskId);
    const authFailed = Daemon.AUTH_FAILURE_RE.test(logTail);
    const used = this.taskRetries.get(taskId) ?? 0;

    if (authFailed && used < limit) {
      // Only re-spawn if this daemon still owns the task and it's still running;
      // a hub-side requeue/reassign/cancel must not trigger a duplicate agent.
      let task: Task;
      try {
        task = await this.client.getTask(taskId);
      } catch (err) {
        this.logger.error('failed to fetch task for auth retry', {
          taskId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      if (task.status !== 'in_progress') {
        this.logger.info('skipping auth retry — task no longer in_progress', {
          taskId,
          status: task.status,
        });
        this.taskRetries.delete(taskId);
        return;
      }
      this.taskRetries.set(taskId, used + 1);
      this.logger.info('retrying task after auth failure', { taskId, attempt: used + 1, limit });
      await this.spawnClaimedTask(task);
      return;
    }

    // Not a transient auth failure, or retries exhausted. Re-check for a done
    // file first: the agent may have finished in the gap between the isAlive
    // probe and now, in which case the done-watcher will complete it — failing
    // it here would race completeTask and emit a spurious task.failed.
    if ((await readDoneFile(this.opts.workdir, taskId)) !== null) {
      return;
    }
    this.taskRetries.delete(taskId);
    const reason = authFailed ? 'auth failure (retries exhausted)' : 'agent exited without completing';
    try {
      await this.client.failTask(taskId, reason);
      this.logger.error('marked dead task as failed', { taskId, reason });
    } catch (err) {
      this.logger.error('failed to mark dead task as failed', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
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
    const dispatcherPersonalityId = this.opts.dispatcherPersonality ?? 'forge-master';
    const syntheticTaskId = `_fm_${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const contextJson = JSON.stringify(ctx, null, 2);
    const doneInstruction =
      `\n\n---\nWhen you have finished triaging, write the done file to signal completion:\n` +
      `Create \`.forge/tasks/${syntheticTaskId}.done\` with:\n` +
      `{"result":"<summary of assignments made>","completedAt":"<ISO 8601 timestamp>"}\n` +
      `Write the file with a tool call (Bash, Write, or shell command).`;
    // The FM system prompt (personality) already establishes FM's identity and tools.
    // The initial prompt is the workspace state for FM to reason from.
    const initialPrompt = `Workspace context for triage:\n\n${contextJson}${doneInstruction}`;

    try {
      this.fmRunning = true;

      // Compose FM system prompt inside the try block so that a composeSystemPrompt
      // error triggers the catch and resets fmRunning — preventing a deadlock where
      // fmRunning stays true forever and the dispatcher never retries.
      let fmPersonality: string = this.opts.defaultPersonality || 'You are the Forge Master orchestrator.';
      const registry = this.opts.personalityRegistry;
      if (registry) {
        const personality = registry.get(dispatcherPersonalityId);
        if (personality) {
          fmPersonality = await composeSystemPrompt({
            personality,
            projectContextPath: path.join(this.opts.workdir, 'context', 'project-context.md'),
            agentOverridesDir: path.join(this.opts.workdir, 'context', 'agent-overrides'),
          });
          this.logger.info('fm personality loaded from registry', { id: dispatcherPersonalityId });
        } else {
          this.logger.info('fm personality not found in registry, using fallback', {
            id: dispatcherPersonalityId,
          });
        }
      }

      // Write a marker task file so the runtime's file-based isAlive() probe
      // recognizes the synthetic FM agent as live. Without it, isAlive() sees no
      // task file and the next poll's dead-check reports the running FM as dead.
      await writeSyntheticTaskFile(this.opts.workdir, syntheticTaskId, 'FM triage');

      // runtime.get() inside the try block so a missing runtime ID logs gracefully.
      const runtime = this.runtimes.get(this.opts.defaultRuntimeId);
      const instance = await runtime.spawn(
        {
          agentId: fmAgentId,
          personality: fmPersonality,
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
      // The synthetic marker is written before spawn(); remove it so a spawn
      // failure doesn't orphan it in .forge/tasks.
      await cleanupTaskFiles(this.opts.workdir, syntheticTaskId).catch(() => {});
      this.logger.error('failed to spawn FM agent', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleIncomingTask(env: EventEnvelope): Promise<void> {
    const taskId = (env.payload as { taskId?: string }).taskId;
    if (!taskId) return;
    if (this.activeInstances.has(taskId)) return;

    // Concurrency cap: when maxConcurrentTasks is set, skip the claim attempt
    // until a slot opens. The task remains in pending_agent and will be
    // re-delivered when another daemon (or this daemon after a slot frees)
    // picks it up via the poll loop.
    if (
      this.opts.maxConcurrentTasks !== undefined &&
      this.activeInstances.size >= this.opts.maxConcurrentTasks
    ) {
      this.logger.info('concurrency cap reached, skipping task', {
        taskId,
        activeCount: this.activeInstances.size,
        maxConcurrentTasks: this.opts.maxConcurrentTasks,
      });
      return;
    }

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

    // Task is now claimed — spawn the agent for it.
    const claimed = await this.client.getTask(taskId);
    await this.spawnClaimedTask(claimed);
  }

  /**
   * Spawn (or re-spawn) the agent for an already-claimed task. Writes the task
   * file, composes the personality, and starts the runtime. On spawn failure the
   * task is marked failed so it is not left stuck in_progress. Reused by the
   * initial claim path and the auth-failure retry path.
   */
  private async spawnClaimedTask(claimed: Task): Promise<void> {
    const taskId = claimed.id;
    try {
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
      // Reset the agent log so post-mortem classification (auth-failure
      // detection) reads only THIS run, not a prior attempt's appended output.
      await resetAgentLog(this.opts.workdir, claimed.id);
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
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error('task claimed but spawn failed', { taskId, error: reason });
      // Best-effort: mark the task as failed so it is not stuck in_progress
      // indefinitely. If failTask itself fails the task remains in_progress;
      // the stale-assigned requeue mechanism does not cover in_progress tasks.
      try {
        await this.client.failTask(taskId, `spawn failed: ${reason}`);
      } catch (failErr) {
        this.logger.error('failed to mark task as failed after spawn error', {
          taskId,
          error: failErr instanceof Error ? failErr.message : String(failErr),
        });
      }
      // Task is now terminal — drop any retry counter so it can't leak.
      this.taskRetries.delete(taskId);
    }
  }

  /**
   * Significance keywords: if any appear in the combined text of a completed
   * task's title, description, and completion result, we treat it as worth
   * documenting and create a Scribe follow-up task.
   */
  private static readonly SIGNIFICANCE_KEYWORDS = [
    'endpoint', 'api', 'route',
    'schema', 'migration', 'database', 'db', 'table', 'column', 'index',
    'component', 'page', 'view',
    'pattern', 'architecture', 'architectural',
    'auth', 'authentication', 'authorization',
    'agent', 'daemon', 'orchestrator',
    'deploy', 'deployment', 'infrastructure',
    'adr', 'decision',
  ] as const;

  /** Returns true if the combined task text suggests architectural significance. */
  static isArchitecturallySignificant(title: string, description: string | null, result: string | null): boolean {
    const text = [title, description, result].filter(Boolean).join(' ').toLowerCase();
    return Daemon.SIGNIFICANCE_KEYWORDS.some((kw) => text.includes(kw));
  }

  private async handleTaskCompleted(env: EventEnvelope): Promise<void> {
    // Guard: do not react to events after stop() is called.
    if (!this.running) return;

    const raw = env.payload;
    if (typeof raw !== 'object' || raw === null) return;
    const p = raw as Record<string, unknown>;
    const taskId = typeof p['taskId'] === 'string' ? p['taskId'] : undefined;
    if (!taskId) return;
    const result = typeof p['result'] === 'string' ? p['result'] : null;
    const payloadWorkspaceId = typeof p['workspaceId'] === 'string' ? p['workspaceId'] : null;

    // Only react to tasks in our workspace when workspaceId is configured.
    if (this.opts.workspaceId !== undefined && payloadWorkspaceId !== this.opts.workspaceId) {
      return;
    }

    const wsId = payloadWorkspaceId ?? this.opts.workspaceId ?? null;

    // Track completions for audit threshold. Every in-scope completion counts,
    // regardless of significance. Reset before creating the audit task to prevent
    // double-triggering if concurrent events arrive near the boundary.
    this.completionsSinceAudit++;
    const auditThreshold = this.opts.auditThreshold;
    if (auditThreshold !== undefined && this.completionsSinceAudit >= auditThreshold && wsId !== null) {
      this.completionsSinceAudit = 0;
      await this.createScribeAuditTask(wsId);
    }

    let task: { title: string; description: string | null; projectPrefix: string; workspaceId: string | null };
    try {
      task = await this.client.getTask(taskId);
    } catch {
      return; // best-effort; if we can't fetch the task, skip
    }

    if (!Daemon.isArchitecturallySignificant(task.title, task.description, result)) {
      return;
    }

    const scribeAgentId = this.opts.scribeAgentId ?? 'scribe';

    const descLines = [
      `Completed task: ${taskId}`,
      `Title: ${task.title}`,
    ];
    if (task.description) descLines.push(`Description: ${task.description}`);
    if (result) descLines.push(`Completion summary: ${result}`);
    descLines.push('');
    descLines.push('Evaluate whether this completion warrants workspace doc updates.');

    try {
      await this.client.createTask({
        projectPrefix: task.projectPrefix,
        title: `[Scribe] Document: ${task.title}`,
        description: descLines.join('\n'),
        assignedAgentId: scribeAgentId,
        ...(wsId !== null ? { workspaceId: wsId } : {}),
      });
      this.logger.info('scribe doc task created', { completedTaskId: taskId, scribeAgentId });
    } catch (err) {
      this.logger.error('failed to create scribe doc task', {
        completedTaskId: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Creates a Scribe audit task pre-assigned to the scribe agent.
   * Called automatically when `completionsSinceAudit` reaches `auditThreshold`.
   */
  private async createScribeAuditTask(workspaceId: string): Promise<void> {
    const scribeAgentId = this.opts.scribeAgentId ?? 'scribe';
    const description = [
      `Audit trigger: ${this.opts.auditThreshold ?? '?'} tasks completed since last audit.`,
      '',
      'Review the workspace knowledge base and:',
      '1. Identify docs that are stale, redundant, or superseded by newer decisions.',
      '2. Consolidate near-duplicate docs into a single authoritative doc.',
      '3. Update docs whose content no longer reflects the current codebase.',
      '4. Supersede any docs that have been replaced by newer decisions.',
      '',
      'This is a Scribe audit task. See your personality for audit mode instructions.',
    ].join('\n');

    try {
      await this.client.createTask({
        projectPrefix: 'scribe',
        title: '[Scribe Audit] Knowledge base audit',
        description,
        assignedAgentId: scribeAgentId,
        workspaceId,
      });
      this.logger.info('scribe audit task created', {
        workspaceId,
        scribeAgentId,
        auditThreshold: this.opts.auditThreshold,
      });
    } catch (err) {
      this.logger.error('failed to create scribe audit task', {
        workspaceId,
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
      this.taskRetries.delete(taskId);
      this.logger.info('task completed', { taskId });
    } catch (err) {
      this.logger.error('failed to complete task', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
