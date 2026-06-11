import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, desc, asc, inArray, isNull, isNotNull, lt, or, count, gte, max, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CreateTaskInputSchema,
  TaskIdSchema,
  SequenceSpecSchema,
  formatTaskId,
  formatPhaseTaskId,
  rankAtLeast,
  schema,
} from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireDevice, getDevice, requireWorkspaceMember, getWorkspace, getUser } from '../auth/middleware.js';
import type { EventBus } from '../events/bus.js';
import { checkPolicy } from '../policy/engine.js';
import { buildDevicePrincipal } from '../policy/principals.js';

const CompleteTaskBodySchema = z.object({
  result: z.string().max(4000).optional(),
});

const FailTaskBodySchema = z.object({
  reason: z.string().max(500).optional(),
});

const PatchTaskBodySchema = z.object({
  status: z.enum(['cancelled', 'pending_agent']),
});

const AssignTaskBodySchema = z.object({
  /** The agentId (agents.name) to route this task to. */
  agentId: z.string().min(1).max(100),
});

/** User session path: agentId may be null to clear assignment. */
const UserAssignTaskBodySchema = z.object({
  agentId: z.string().min(1).max(100).nullable(),
});

const CancelTaskBodySchema = z.object({
  reason: z.string().max(500).optional(),
});

const RetryTaskBodySchema = z.object({
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
});

const CreateWorkspaceTaskBodySchema = CreateTaskInputSchema.extend({
  sequenceSpec: SequenceSpecSchema.optional(),
  // Cap dependsOn at 20 entries to prevent O(N) SQL inArray queries with hundreds of IDs.
  // Each entry is capped at 100 chars to match the task ID format limit (DEDUP-010).
  dependsOn: z.array(z.string().max(100)).max(20).default([]),
});

/** Task statuses FM is allowed to route from. */
const FM_ASSIGNABLE_STATUSES = ['pending_dispatcher_action', 'pending_agent'] as const;

/** Statuses a user may cancel via the dedicated cancel endpoint.
 * Includes sequenced_running and waiting_on_deps per design doc Section 4.1.
 * Type annotation enforces membership against the canonical TaskStatus enum at compile time.
 * 'stale_assigned' is NOT a valid TaskStatus and must NOT appear here (DEDUP-023).
 * The `satisfies ReadonlySet<TaskStatus>` constraint is verified by the TypeScript compiler
 * as part of the standard CI build — future enum additions that are missed in this set
 * will cause a compile error. */
const CANCELLABLE_STATUSES = new Set([
  'pending_dispatcher_action',
  'pending_design',
  'design_review',
  'pending_agent',
  'assigned',
  'in_progress',
  'sequenced_running',
  'waiting_on_deps',
] as const) satisfies ReadonlySet<import('@forge-lab/core').TaskStatus>;

/** Terminal statuses — no further transitions are possible.
 * Type annotation enforces membership against the canonical TaskStatus enum at compile time. */
const TERMINAL_STATUSES = new Set([
  'completed',
  'sequenced_complete',
  'failed',
  'cancelled',
] as const) satisfies ReadonlySet<import('@forge-lab/core').TaskStatus>;

/** Terminal-success statuses — deps are satisfied when all deps are in one of these.
 * Type annotation enforces membership against the canonical TaskStatus enum at compile time. */
const TERMINAL_SUCCESS_STATUSES = new Set([
  'completed',
  'sequenced_complete',
] as const) satisfies ReadonlySet<import('@forge-lab/core').TaskStatus>;

/** Statuses a user may reassign/clear via the user-session assign path. */
const USER_ASSIGNABLE_STATUSES = ['pending_agent', 'assigned'] as const;

const USER_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending_dispatcher_action: ['cancelled'],
  pending_agent: ['cancelled'],
  pending_design: ['cancelled'],
  design_review: ['cancelled'],
  assigned: ['cancelled'],
  in_progress: ['cancelled'],
  sequenced_running: ['cancelled'],
  waiting_on_deps: ['cancelled'],
  failed: ['pending_agent'],
  cancelled: ['pending_agent'],
};

/** Stale TTL for device availability checks (5 minutes in ms). */
const STALE_TTL_MS = 5 * 60 * 1000;

function maybeRunId(req: FastifyRequest): Record<string, string> {
  return req.runId ? { runId: req.runId } : {};
}

/**
 * Shared helper: get the highest sequence number for root tasks (parent_id IS NULL)
 * in a given project prefix. Uses a SQL MAX aggregation over the numeric portion of
 * the task ID string (e.g. the "42" in "fl-042") rather than fetching all rows and
 * iterating in application code. The tasks_project_idx index on projectPrefix makes
 * this efficient even for large workspaces (DEDUP-022).
 *
 * Phase task IDs (e.g. "fl-042-p0") are excluded by parent_id IS NULL: phase tasks
 * always have a parentId set, so this filter is sufficient without regex parsing.
 *
 * TOCTOU note: a concurrent request for the same projectPrefix can read the same
 * max value between this query and the subsequent INSERT. In that case, one INSERT
 * succeeds and the other hits the UNIQUE constraint on id. SQLite serialises writes
 * by default (one writer at a time), making this race extremely unlikely in practice.
 * If it occurs, the error surfaces as a 500; callers should retry. A per-prefix
 * atomic sequence table is the correct long-term fix (DEDUP-011).
 */
async function getMaxRootSeq(db: Db, prefix: string): Promise<number> {
  // INSTR(id, '-') finds the first dash; SUBSTR extracts everything after it;
  // CAST to INTEGER drops any '-pN' suffix and returns only the leading digits.
  const row = await db
    .select({
      maxSeq: max(sql<number>`CAST(SUBSTR(${schema.tasks.id}, INSTR(${schema.tasks.id}, '-') + 1) AS INTEGER)`),
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.projectPrefix, prefix),
        isNull(schema.tasks.parentId),
      ),
    )
    .get();
  const val = row?.maxSeq;
  if (val === null || val === undefined) return 0;
  const n = typeof val === 'number' ? val : Number(val);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build the next-phase description by injecting prior-phase output in a
 * sandboxed format. See design doc Section 6.4.
 *
 * Security scope:
 * - prior_phase_output XML tags are stripped from both the phase prompt and prior result
 *   to prevent re-injection attacks (breaking out of the sandbox wrapper).
 * - Structural XML tags that Claude treats as special (<system>, <instructions>, <assistant>,
 *   <human>) are also stripped from the prior result to reduce prompt injection surface
 *   (DEDUP-021). Note: blockquote sandboxing alone is not a complete mitigation for all
 *   model versions — this is defense-in-depth, not a guarantee.
 */
function buildNextPhaseDescription(
  nextPhasePrompt: string,
  priorResult: string,
  completingPhaseIndex: number,
): string {
  // 0. Sanitize the phase prompt: strip any closing prior_phase_output tags
  //    that a malicious caller could use to break out of the sandbox wrapper
  //    that will surround the prior result in the assembled description.
  const sanitizedPrompt = nextPhasePrompt.replace(/<\/?prior_phase_output[^>]*>/gi, '[xml-tag-removed]');

  // 1. Cap the prior result
  const capped = priorResult.slice(0, 2000);

  // 2. Normalize CRLF to LF
  const normalized = capped.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 3. Strip XML tags that could escape the sandbox or influence the receiving agent.
  //    Covers prior_phase_output re-injection AND structural Claude XML tags (DEDUP-021).
  const escaped = normalized
    .replace(/<\/?prior_phase_output[^>]*>/gi, '[xml-tag-removed]')
    .replace(/<\/?system[^>]*>/gi, '[xml-tag-removed]')
    .replace(/<\/?instructions[^>]*>/gi, '[xml-tag-removed]')
    .replace(/<\/?assistant[^>]*>/gi, '[xml-tag-removed]')
    .replace(/<\/?human[^>]*>/gi, '[xml-tag-removed]');

  // 4. Prefix every line with '> '
  const blockquoted = escaped.split('\n').map((line) => `> ${line}`).join('\n');

  // 5. Wrap in XML-attributed tags with trust annotation
  const sandboxed = `<prior_phase_output source="phase-${completingPhaseIndex}" trust="untrusted">
${blockquoted}
</prior_phase_output>`;

  return `${sanitizedPrompt}\n\n${sandboxed}`;
}

/**
 * DAG cycle detection for dependsOn validation. Returns the cycle path if found,
 * or null if the graph is acyclic.
 */
function detectCycle(
  newTaskId: string,
  newDependsOn: string[],
  existingEdges: Map<string, string[]>,
): string[] | null {
  const graph = new Map(existingEdges);
  graph.set(newTaskId, newDependsOn);

  const visited = new Set<string>();
  const stack = new Set<string>();
  const stackPath: string[] = [];

  function dfs(node: string): string[] | null {
    if (stack.has(node)) {
      const cycleStart = stackPath.indexOf(node);
      return [...stackPath.slice(cycleStart), node];
    }
    if (visited.has(node)) return null;
    visited.add(node);
    stack.add(node);
    stackPath.push(node);

    for (const neighbor of graph.get(node) ?? []) {
      const cycle = dfs(neighbor);
      if (cycle) return cycle;
    }

    stack.delete(node);
    stackPath.pop();
    return null;
  }

  return dfs(newTaskId);
}

/**
 * Dep-unblocking pass: scan all waiting_on_deps tasks in the workspace and
 * unblock those whose all deps have reached terminal-success.
 * Returns Drizzle batch statements to be included in the caller's batch,
 * or executes them directly if no batch is being built.
 *
 * This function runs the unblocking logic and executes directly.
 */
async function runDepUnblockingPass(
  db: Db,
  workspaceId: string,
): Promise<void> {
  const waitingTasks = await db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.workspaceId, workspaceId),
        eq(schema.tasks.status, 'waiting_on_deps'),
        isNull(schema.tasks.phaseIndex),
      ),
    )
    .limit(50);

  // If the cap was hit, schedule a follow-up pass so the remainder get unblocked.
  // This is not a performance optimisation — leaving tasks beyond the cap blocked is a correctness defect.
  // Promise.resolve().then() is used instead of setImmediate for cross-runtime portability
  // (setImmediate is Node.js-specific and absent in edge runtimes) (DEDUP-024).
  if (waitingTasks.length === 50) {
    console.warn('[unblocking-pass] cap hit (50) for workspace', workspaceId, '— scheduling follow-up sweep');
    Promise.resolve().then(() =>
      runDepUnblockingPass(db, workspaceId).catch((err) =>
        console.error('[unblocking-pass] follow-up sweep failed for workspace', workspaceId, err),
      ),
    );
  }

  for (const blocked of waitingTasks) {
    let deps: string[];
    try {
      deps = z.array(z.string()).parse(JSON.parse(blocked.dependsOn));
    } catch (err) {
      console.error('[unblocking-pass] corrupt depends_on on task', blocked.id, err);
      continue;
    }

    if (deps.length === 0) {
      // No deps — unblock immediately. Mirror the branched logic used below for the allMet case:
      // if the task has a sequenceSpec, run phase-0 creation via unblockSequencedTask instead of
      // setting status to pending_agent directly (which would bypass sequencing).
      if (blocked.sequenceSpec !== null && blocked.sequenceSpec !== undefined) {
        await unblockSequencedTask(db, blocked, workspaceId);
      } else {
        await db
          .update(schema.tasks)
          .set({ status: 'pending_agent', blockedReason: null, updatedAt: new Date() })
          .where(eq(schema.tasks.id, blocked.id));
        await db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId: blocked.id,
          eventName: 'task.deps_cleared',
          source: 'system',
          payload: { reason: 'no_deps' },
          workspaceId,
        });
      }
      continue;
    }

    const depStatuses = await db
      .select({ id: schema.tasks.id, status: schema.tasks.status })
      .from(schema.tasks)
      .where(
        and(
          inArray(schema.tasks.id, deps),
          eq(schema.tasks.workspaceId, workspaceId),
        ),
      );

    const depStatusMap = new Map(depStatuses.map((d) => [d.id, d.status]));

    // Check for cross-workspace or missing deps
    const invalidDeps = deps.filter((id) => !depStatusMap.has(id));
    if (invalidDeps.length > 0) {
      await db
        .update(schema.tasks)
        .set({ blockedReason: 'invalid_dep_workspace', updatedAt: new Date() })
        .where(eq(schema.tasks.id, blocked.id));
      continue;
    }

    // Check for cancelled/failed deps.
    // Use a flag so we emit history events for ALL failed/cancelled deps (not just the first),
    // then continue to the outer loop explicitly to avoid falling through to the allMet check.
    // Skip the UPDATE and history INSERT if blockedReason already reflects the dep's terminal
    // status — this prevents duplicate history events across repeated unblocking passes (DEDUP-005).
    let hasTerminalFailedDep = false;
    for (const [depId, depStatus] of depStatusMap.entries()) {
      if (depStatus === 'cancelled') {
        hasTerminalFailedDep = true;
        const sentinel = `dep_cancelled:${depId}`;
        if (blocked.blockedReason === sentinel) continue;
        await db
          .update(schema.tasks)
          .set({ blockedReason: sentinel, updatedAt: new Date() })
          .where(eq(schema.tasks.id, blocked.id));
        await db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId: blocked.id,
          eventName: 'task.dep_failed',
          source: 'system',
          payload: { depId, depStatus: 'cancelled' },
          workspaceId,
        });
      }
      if (depStatus === 'failed') {
        hasTerminalFailedDep = true;
        const sentinel = `dep_failed:${depId}`;
        if (blocked.blockedReason === sentinel) continue;
        await db
          .update(schema.tasks)
          .set({ blockedReason: sentinel, updatedAt: new Date() })
          .where(eq(schema.tasks.id, blocked.id));
        await db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId: blocked.id,
          eventName: 'task.dep_failed',
          source: 'system',
          payload: { depId, depStatus: 'failed' },
          workspaceId,
        });
      }
    }
    // Explicit continue to outer loop — do NOT fall through to the allMet check
    // if any cancelled/failed dep was found.
    if (hasTerminalFailedDep) continue;

    const allMet = deps.every((depId) => {
      const s = depStatusMap.get(depId);
      return s !== undefined && TERMINAL_SUCCESS_STATUSES.has(s as Parameters<typeof TERMINAL_SUCCESS_STATUSES.has>[0]);
    });
    if (!allMet) continue;

    // All deps satisfied — unblock
    if (blocked.sequenceSpec !== null && blocked.sequenceSpec !== undefined) {
      // Sequenced task: run phase-0 creation logic
      await unblockSequencedTask(db, blocked, workspaceId);
    } else {
      await db
        .update(schema.tasks)
        .set({ status: 'pending_agent', blockedReason: null, updatedAt: new Date() })
        .where(eq(schema.tasks.id, blocked.id));
      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId: blocked.id,
        eventName: 'task.deps_cleared',
        source: 'system',
        payload: {},
        workspaceId,
      });
    }
  }
}

/**
 * Create phase-0 task for a sequenced task that was previously waiting_on_deps
 * and has now been unblocked.
 *
 * All writes (phase-0 INSERT, root UPDATE, history INSERTs) are executed in a
 * single db.batch() call for atomicity. A crash between writes would leave the
 * root in waiting_on_deps with a phase-0 task already created; the UNIQUE constraint
 * on (parent_id, phase_index) would prevent double-creation on the next pass, and
 * the try/catch handles that case gracefully (DEDUP-007).
 *
 * On hash mismatch a sequence_integrity_failure history event is written and the
 * task's blockedReason is updated before returning, so operators can detect the
 * stuck task (DEDUP-007).
 */
async function unblockSequencedTask(
  db: Db,
  rootTask: { id: string; sequenceSpec: string | null; workspaceId: string | null; projectPrefix: string; priority: string; sequenceSpecHash: string | null; blockedReason: string | null },
  workspaceId: string,
): Promise<void> {
  if (!rootTask.sequenceSpec) return;

  // Verify sequence_spec_hash integrity before executing (design doc Section 4.6).
  const computedHash = createHash('sha256').update(rootTask.sequenceSpec).digest('hex');
  if (computedHash !== rootTask.sequenceSpecHash) {
    console.error('[unblocking-pass] sequence_spec_hash mismatch on task', rootTask.id, '— writing integrity failure event');
    // Update blockedReason and insert history event so operators can detect the stuck task (DEDUP-007).
    await db.batch([
      db
        .update(schema.tasks)
        .set({ blockedReason: 'sequence_integrity_failure', updatedAt: new Date() })
        .where(eq(schema.tasks.id, rootTask.id)),
      db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId: rootTask.id,
        eventName: 'task.sequence_integrity_failure',
        source: 'system',
        payload: { computedHash, storedHash: rootTask.sequenceSpecHash },
        workspaceId,
      }),
    ] as Parameters<typeof db.batch>[0]);
    return;
  }

  let spec: z.infer<typeof SequenceSpecSchema>;
  try {
    spec = SequenceSpecSchema.parse(JSON.parse(rootTask.sequenceSpec));
  } catch {
    console.error('[unblocking-pass] corrupt sequence_spec on task', rootTask.id);
    return;
  }

  const phase0 = spec.phases[0];
  if (!phase0) {
    console.error('[unblocking-pass] sequence_spec has 0 phases on task', rootTask.id);
    return;
  }
  const phase0Id = formatPhaseTaskId(rootTask.id, 0);
  const now = new Date();

  // Check device availability
  const cutoffMs = Date.now() - STALE_TTL_MS;
  const cutoff = new Date(cutoffMs);
  const activeDevices = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(
      and(
        eq(schema.devices.agentId, phase0.role),
        eq(schema.devices.status, 'active'),
        gte(schema.devices.lastSeen, cutoff),
      ),
    );

  const blockedReason = activeDevices.length === 0 ? `role_unavailable:${phase0.role}` : null;

  // Build all write statements before executing, then run as a single batch for atomicity (DEDUP-007).
  // Use projectPrefix from the DB column directly; do not rely on regex parsing of the task ID.
  const phase0Insert = db.insert(schema.tasks).values({
    id: phase0Id,
    workspaceId,
    projectPrefix: rootTask.projectPrefix,
    title: phase0.title,
    description: phase0.prompt,
    status: 'pending_agent',
    // Propagate root task priority to the phase task (do not hardcode 'normal').
    priority: rootTask.priority as 'low' | 'normal' | 'high' | 'urgent',
    parentId: rootTask.id,
    phaseIndex: 0,
    assignedAgentId: phase0.role,
    dependsOn: '[]',
    createdBy: 'system',
    createdAt: now,
    updatedAt: now,
  });

  const rootUpdate = db
    .update(schema.tasks)
    .set({
      status: 'sequenced_running',
      blockedReason,
      updatedAt: now,
    })
    .where(eq(schema.tasks.id, rootTask.id));

  const depsCleared = db.insert(schema.taskHistory).values({
    id: nanoid(),
    taskId: rootTask.id,
    eventName: 'task.deps_cleared',
    source: 'system',
    payload: { phaseTaskId: phase0Id },
    workspaceId,
  });

  const batchStatements: Parameters<typeof db.batch>[0] = blockedReason
    ? [
        phase0Insert,
        rootUpdate,
        depsCleared,
        db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId: rootTask.id,
          eventName: 'task.phase_blocked',
          source: 'system',
          payload: { phase: 0, reason: blockedReason },
          workspaceId,
        }),
      ]
    : [phase0Insert, rootUpdate, depsCleared];

  try {
    await db.batch(batchStatements);
  } catch (err: unknown) {
    // If the phase-0 task already exists (UNIQUE constraint on parent_id + phase_index),
    // a prior partial write succeeded for the INSERT but failed before the root UPDATE.
    // Log and skip — the next unblocking pass will re-attempt the root UPDATE.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE') || msg.includes('unique')) {
      console.warn('[unblocking-pass] phase-0 already exists for task', rootTask.id, '— skipping INSERT, root UPDATE will be retried');
      return;
    }
    throw err;
  }
}

export function registerTaskRoutes(
  fastify: FastifyInstance,
  db: Db,
  bus: EventBus,
): void {
  fastify.post('/tasks', async (req, reply) => {
    const user = req.authUser;
    const device = req.authDevice;
    if (!user && !device) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const body = CreateTaskInputSchema.parse(req.body);
    const maxSeq = await getMaxRootSeq(db, body.projectPrefix);
    const id = formatTaskId(body.projectPrefix, maxSeq + 1);
    const createdBy = user ? `user:${user.id}` : `device:${device!.id}`;

    // Validate parentId: parent must exist. When workspaceId is also provided
    // (FM device path), parent must belong to that workspace.
    const parentId = body.parentId ?? null;
    if (parentId !== null) {
      const whereParent =
        body.workspaceId != null
          ? and(eq(schema.tasks.id, parentId), eq(schema.tasks.workspaceId, body.workspaceId))
          : eq(schema.tasks.id, parentId);
      const parent = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(whereParent)
        .get();
      if (!parent) {
        await reply.code(404).send({ error: 'parent_task_not_found' });
        return;
      }
    }

    await db.insert(schema.tasks).values({
      id,
      projectPrefix: body.projectPrefix,
      title: body.title,
      description: body.description ?? null,
      priority: body.priority ?? 'normal',
      goalId: body.goalId || null,
      parentId,
      // Devices may supply workspaceId to associate subtasks with a workspace.
      // Device tokens are provisioned by workspace owners and are semi-trusted
      // (same rationale as GET /tasks?workspaceId= above).
      workspaceId: body.workspaceId ?? null,
      // Reactive agents (e.g. Scribe) self-create follow-up tasks pre-assigned
      // to themselves so only their daemon claims them.
      assignedAgentId: body.assignedAgentId ?? null,
      taskKind: body.taskKind ?? 'coding',
      reviewConfig: body.reviewConfig ?? null,
      createdBy,
    });
    await db.insert(schema.taskHistory).values({
      id: nanoid(),
      taskId: id,
      eventName: 'task.created',
      source: createdBy,
      payload: { title: body.title, ...maybeRunId(req) },
      // Mirror the task's workspaceId so audit events are workspace-scoped.
      workspaceId: body.workspaceId ?? null,
    });
    bus.emit({
      id: nanoid(),
      name: 'task.created',
      occurredAt: new Date(),
      source: createdBy,
      payload: { taskId: id, projectPrefix: body.projectPrefix },
    });
    await reply.code(201).send({ id });
  });

  // Device-accessible flat task list. Without workspaceId returns unscoped tasks (null); with
  // workspaceId returns that workspace's tasks. Intentionally does NOT verify workspace membership
  // because daemons authenticate as devices, not workspace members. Callers must supply the correct
  // workspaceId — a device that supplies an arbitrary workspaceId can read those task titles. This
  // is acceptable: device tokens are provisioned by workspace owners and are semi-trusted.
  //
  // Sequenced root tasks (sequenceSpec IS NOT NULL AND phaseIndex IS NULL) are excluded from this
  // endpoint to prevent FM from claiming them — sequenced roots advance only via phase completion,
  // never via FM assignment. Phase tasks (phaseIndex IS NOT NULL) are still returned (DEDUP-014).
  fastify.get<{ Querystring: { workspaceId?: string } }>('/tasks', async (req, reply) => {
    if (!req.authUser && !req.authDevice) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const { workspaceId } = req.query;
    const scopeClause = workspaceId
      ? eq(schema.tasks.workspaceId, workspaceId)
      : isNull(schema.tasks.workspaceId);
    // Exclude sequenced roots: only return tasks that have no sequenceSpec, OR are phase tasks.
    // This matches design doc Section 6.6: filter AND (sequence_spec IS NULL OR phase_index IS NOT NULL).
    const seqFilter = or(isNull(schema.tasks.sequenceSpec), isNotNull(schema.tasks.phaseIndex));
    const tasks = await db
      .select()
      .from(schema.tasks)
      .where(and(scopeClause, seqFilter))
      .orderBy(desc(schema.tasks.createdAt));
    return { tasks };
  });

  // User-facing task statistics. Returns per-status counts, completion rate, and recent velocity.
  // Scoped to workspaces the user is a member of (or un-scoped/null-workspace tasks they created).
  fastify.get('/tasks/stats', async (req, reply) => {
    if (!req.authUser) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const userId = req.authUser.id;

    // Collect workspace IDs the user belongs to
    const memberRows = await db
      .select({ workspaceId: schema.workspaceMembers.workspaceId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, userId));
    const memberWorkspaceIds = memberRows.map((r) => r.workspaceId);

    // createdBy stores "user:<id>" for user-created tasks (see POST /tasks handler)
    const createdByKey = `user:${userId}`;

    // Scope: tasks in the user's workspaces OR unscoped tasks created by the user
    // Exclude phase tasks (parent_id IS NULL = root tasks only)
    const scopeFilter =
      memberWorkspaceIds.length > 0
        ? or(
            inArray(schema.tasks.workspaceId, memberWorkspaceIds),
            and(isNull(schema.tasks.workspaceId), eq(schema.tasks.createdBy, createdByKey)),
          )
        : and(isNull(schema.tasks.workspaceId), eq(schema.tasks.createdBy, createdByKey));

    // Count tasks grouped by status in a single query; WHERE parent_id IS NULL excludes phase tasks
    const rows = await db
      .select({ status: schema.tasks.status, n: count() })
      .from(schema.tasks)
      .where(and(scopeFilter, isNull(schema.tasks.parentId)))
      .groupBy(schema.tasks.status);

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byStatus[row.status] = row.n;
      total += row.n;
    }

    const completed = (byStatus['completed'] ?? 0) + (byStatus['sequenced_complete'] ?? 0);
    const failed = byStatus['failed'] ?? 0;
    const inProgress = byStatus['in_progress'] ?? 0;
    const pending = byStatus['pending_agent'] ?? 0;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Tasks completed in the last 7 days (within scope, root tasks only)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentRow = await db
      .select({ n: count() })
      .from(schema.tasks)
      .where(
        and(
          scopeFilter,
          isNull(schema.tasks.parentId),
          or(
            eq(schema.tasks.status, 'completed'),
            eq(schema.tasks.status, 'sequenced_complete'),
          ),
          gte(schema.tasks.completedAt, sevenDaysAgo),
        ),
      )
      .get();

    return {
      total,
      byStatus,
      completionRate,
      completedLast7Days: recentRow?.n ?? 0,
      summary: { completed, failed, inProgress, pending },
    };
  });

  fastify.get<{ Params: { id: string } }>('/tasks/:id', async (req, reply) => {
    if (!req.authUser && !req.authDevice) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const id = TaskIdSchema.parse(req.params.id);
    const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
    if (!task) {
      await reply.code(404).send({ error: 'not_found' });
      return;
    }
    return task;
  });

  fastify.get<{ Params: { id: string } }>('/tasks/:id/history', async (req, reply) => {
    if (!req.authUser && !req.authDevice) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const id = TaskIdSchema.parse(req.params.id);
    const history = await db
      .select()
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, id))
      .orderBy(asc(schema.taskHistory.createdAt));
    return { history };
  });

  fastify.post<{ Params: { id: string } }>(
    '/tasks/:id/claim',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      const id = TaskIdSchema.parse(req.params.id);

      // Heimdall pre-flight: policy check for task:claim.
      // The SQL agentId filter below is defense-in-depth; this check is authoritative
      // and produces an audit log record for every claim attempt.
      const principal = buildDevicePrincipal(device);
      const claimDecision = await checkPolicy(
        principal,
        'task:claim',
        { type: 'task', id },
        { db },
      );
      if (!claimDecision.allowed) {
        await reply.code(403).send({
          error: 'policy_denied',
          action: 'task:claim',
          principal: claimDecision.principal,
        });
        return;
      }

      const existing = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, id))
        .get();
      if (!existing) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      // AgentId routing: if the device has a registered agentId, it can claim tasks
      // assigned to that agentId OR unrouted tasks (assignedAgentId IS NULL).
      // If the device has no agentId, it can only claim unrouted tasks.
      const agentIdFilter = device.agentId
        ? or(isNull(schema.tasks.assignedAgentId), eq(schema.tasks.assignedAgentId, device.agentId))
        : isNull(schema.tasks.assignedAgentId);

      const claimed = await db
        .update(schema.tasks)
        .set({
          status: 'in_progress',
          assignedDeviceId: device.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.tasks.id, id),
            inArray(schema.tasks.status, ['pending_agent', 'assigned']),
            or(isNull(schema.tasks.assignedDeviceId), eq(schema.tasks.assignedDeviceId, device.id)),
            agentIdFilter,
          ),
        )
        .returning({ id: schema.tasks.id });

      if (claimed.length === 0) {
        await reply.code(409).send({ error: 'not_claimable' });
        return;
      }
      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId: id,
        eventName: 'task.claimed',
        source: `device:${device.id}`,
        payload: { deviceId: device.id, ...maybeRunId(req) },
      });
      bus.emit({
        id: nanoid(),
        name: 'task.claimed',
        occurredAt: new Date(),
        source: `device:${device.id}`,
        payload: { taskId: id, deviceId: device.id },
      });
      await reply.send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // Assign task: accepts orchestrator device OR workspace member (user session).
  // Orchestrator path: non-nullable agentId, FM_ASSIGNABLE_STATUSES, 422 on guard fail.
  // User path: nullable agentId (null = clear -> pending_dispatcher_action),
  //            USER_ASSIGNABLE_STATUSES, 409 on guard fail.
  // ---------------------------------------------------------------------------

  fastify.patch<{ Params: { workspaceId: string; taskId: string } }>(
    '/workspaces/:workspaceId/tasks/:taskId/assign',
    async (req, reply) => {
      const workspaceId = req.params.workspaceId;
      const taskId = TaskIdSchema.parse(req.params.taskId);

      const isDevice = !!req.authDevice;
      const isUser = !!req.authUser;

      if (!isDevice && !isUser) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }

      if (isDevice) {
        // Device path — policy check replaces the hardcoded orchestrator gate.
        const device = req.authDevice!;
        const principal = buildDevicePrincipal(device);
        const decision = await checkPolicy(
          principal,
          'task:assign',
          { type: 'task', workspaceId },
          { db, workspaceId },
        );
        if (!decision.allowed) {
          await reply.code(403).send({
            error: 'policy_denied',
            action: 'task:assign',
            principal: decision.principal,
          });
          return;
        }

        const body = AssignTaskBodySchema.parse(req.body);

        const task = await db
          .select({ id: schema.tasks.id, status: schema.tasks.status })
          .from(schema.tasks)
          .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.workspaceId, workspaceId)))
          .get();
        if (!task) {
          await reply.code(404).send({ error: 'not_found' });
          return;
        }
        if (!(FM_ASSIGNABLE_STATUSES as readonly string[]).includes(task.status)) {
          await reply.code(422).send({ error: 'not_assignable', status: task.status });
          return;
        }

        const source = `device:${device.id}`;

        // Snapshot contextDocs at assignment time so the worker has them without a separate fetch.
        const contextDocsRows = await db
          .select({ name: schema.workspaceContext.name, content: schema.workspaceContext.content })
          .from(schema.workspaceContext)
          .where(eq(schema.workspaceContext.workspaceId, workspaceId))
          .orderBy(asc(schema.workspaceContext.updatedAt));

        await db
          .update(schema.tasks)
          .set({
            assignedAgentId: body.agentId,
            assignedAt: new Date(),
            status: 'assigned',
            updatedAt: new Date(),
            contextSnapshot: contextDocsRows.length > 0 ? JSON.stringify(contextDocsRows) : null,
          })
          .where(eq(schema.tasks.id, taskId));

        await db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId,
          eventName: 'task.assigned',
          source,
          payload: { agentId: body.agentId, ...maybeRunId(req) },
          workspaceId,
        });
        bus.emit({
          id: nanoid(),
          name: 'task.assigned',
          occurredAt: new Date(),
          source,
          payload: { taskId, workspaceId, agentId: body.agentId },
        });

        return { ok: true };
      }

      // User session path: verify workspace membership at collaborator level
      const user = req.authUser!;
      const membership = await db
        .select({
          role: schema.workspaceMembers.role,
          workspaceStatus: schema.workspaces.status,
        })
        .from(schema.workspaceMembers)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceMembers.workspaceId))
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, workspaceId),
            eq(schema.workspaceMembers.userId, user.id),
          ),
        )
        .get();
      if (!membership) {
        await reply.code(403).send({ error: 'forbidden' });
        return;
      }
      if (membership.workspaceStatus === 'deleted') {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (!rankAtLeast(membership.role, 'collaborator')) {
        await reply.code(403).send({ error: 'insufficient_role' });
        return;
      }

      const body = UserAssignTaskBodySchema.parse(req.body);

      const task = await db
        .select({ id: schema.tasks.id, status: schema.tasks.status })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.workspaceId, workspaceId)))
        .get();
      if (!task) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (!(USER_ASSIGNABLE_STATUSES as readonly string[]).includes(task.status)) {
        await reply.code(409).send({ error: 'not_assignable', status: task.status });
        return;
      }

      const source = `user:${user.id}`;

      if (body.agentId !== null) {
        // Reassign to a specific agent
        await db
          .update(schema.tasks)
          .set({
            assignedAgentId: body.agentId,
            assignedAt: new Date(),
            status: 'assigned',
            updatedAt: new Date(),
          })
          .where(eq(schema.tasks.id, taskId));

        await db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId,
          eventName: 'task.assigned',
          source,
          payload: { agentId: body.agentId, ...maybeRunId(req) },
          workspaceId,
        });
        bus.emit({
          id: nanoid(),
          name: 'task.assigned',
          occurredAt: new Date(),
          source,
          payload: { taskId, workspaceId, agentId: body.agentId },
        });

        return { ok: true };
      }

      // Clear assignment: return task to FM queue
      await db
        .update(schema.tasks)
        .set({
          assignedAgentId: null,
          assignedAt: null,
          status: 'pending_dispatcher_action',
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.id, taskId));

      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId,
        eventName: 'task.requeued',
        source,
        payload: { reason: 'manual_reassign_cleared' },
        workspaceId,
      });
      bus.emit({
        id: nanoid(),
        name: 'task.requeued',
        occurredAt: new Date(),
        source,
        payload: { taskId, workspaceId },
      });

      return { ok: true, status: 'pending_dispatcher_action' };
    },
  );

  // ---------------------------------------------------------------------------
  // Cancel: dedicated endpoint for cancelling tasks with optional reason and
  // in-progress stop signal. Covers pending_dispatcher_action (gap vs general
  // PATCH). Any workspace member at collaborator level or above may cancel.
  // Now also cancels non-terminal phase children atomically for sequenced roots.
  // ---------------------------------------------------------------------------

  fastify.post<{ Params: { workspaceId: string; taskId: string } }>(
    '/workspaces/:workspaceId/tasks/:taskId/cancel',
    { preHandler: requireWorkspaceMember(db, 'collaborator') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const user = getUser(req);
      const taskId = TaskIdSchema.parse(req.params.taskId);
      const body = CancelTaskBodySchema.parse(req.body ?? {});

      const task = await db
        .select({ id: schema.tasks.id, status: schema.tasks.status, phaseIndex: schema.tasks.phaseIndex })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.workspaceId, workspaceId)))
        .get();
      if (!task) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      if (TERMINAL_STATUSES.has(task.status as Parameters<typeof TERMINAL_STATUSES.has>[0])) {
        await reply.code(409).send({ error: 'already_terminal', status: task.status });
        return;
      }

      if (!CANCELLABLE_STATUSES.has(task.status as Parameters<typeof CANCELLABLE_STATUSES.has>[0])) {
        await reply.code(422).send({ error: 'invalid_transition', from: task.status, to: 'cancelled' });
        return;
      }

      const previousStatus = task.status;
      const source = `user:${user.id}`;
      const now = new Date();

      // Pre-fetch all non-terminal phase children BEFORE any writes (DEDUP-001, DEDUP-024).
      // The entire cascade (root UPDATE + all child UPDATEs + all history INSERTs) must be
      // assembled and executed atomically via db.batch() to prevent:
      //   1. Another request observing a cancelled root with live phase children
      //   2. Partial state on process crash between writes
      const phaseChildren = await db
        .select({ id: schema.tasks.id, phaseIndex: schema.tasks.phaseIndex, status: schema.tasks.status })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.parentId, taskId),
            isNotNull(schema.tasks.phaseIndex),
          ),
        );

      const nonTerminalChildren = phaseChildren.filter((c) => !TERMINAL_STATUSES.has(c.status as Parameters<typeof TERMINAL_STATUSES.has>[0]));

      // Assemble all cancel statements before any DB writes, then execute atomically
      // in a single db.batch() call (DEDUP-001). This prevents partial state on crash:
      // root UPDATE + each child UPDATE + each child history INSERT + root cancel history INSERT
      // + optional stop-instruction INSERTs all land in one atomic libsql transaction.
      //
      // Child UPDATEs use an optimistic lock on the pre-fetched status so a child that
      // transitions to terminal between pre-fetch and batch execution becomes a no-op UPDATE.
      // Child history events and stop instructions are included for all non-terminal children
      // unconditionally — a child that raced to terminal will produce a spurious history event,
      // but this is acceptable to achieve atomicity (the alternative is partial state on crash).

      const rootCancelUpdate = db
        .update(schema.tasks)
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(schema.tasks.id, taskId),
            eq(schema.tasks.workspaceId, workspaceId),
            eq(schema.tasks.status, previousStatus),
          ),
        )
        .returning({ id: schema.tasks.id });

      const rootHistoryInsert = db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId,
        eventName: 'task.cancelled',
        source,
        payload: { previousStatus, reason: body.reason ?? null },
        workspaceId,
      });

      // Build the full cascade: per child — [UPDATE, history INSERT, optional stop INSERT]
      const childStatements: Parameters<typeof db.batch>[0][number][] = [];
      for (const child of nonTerminalChildren) {
        childStatements.push(
          db
            .update(schema.tasks)
            .set({ status: 'cancelled', updatedAt: now })
            .where(
              and(
                eq(schema.tasks.id, child.id),
                eq(schema.tasks.status, child.status),
              ),
            ),
        );
        childStatements.push(
          db.insert(schema.taskHistory).values({
            id: nanoid(),
            taskId: child.id,
            eventName: 'task.phase_cancelled',
            source,
            payload: { phaseIndex: child.phaseIndex, reason: 'parent_cancelled' },
            workspaceId,
          }),
        );
        if (child.status === 'in_progress') {
          childStatements.push(
            db.insert(schema.taskInstructions).values({
              id: nanoid(),
              taskId: child.id,
              workspaceId,
              priority: 'stop',
              body: body.reason
                ? `Phase task cancelled by parent cancellation: ${body.reason}`
                : 'Phase task cancelled by parent cancellation.',
              createdBy: source,
            }),
          );
        }
      }

      // Stop instruction for root task if it was in_progress
      const rootStopStatements: Parameters<typeof db.batch>[0][number][] = previousStatus === 'in_progress'
        ? [
            db.insert(schema.taskInstructions).values({
              id: nanoid(),
              taskId,
              workspaceId,
              priority: 'stop',
              body: body.reason
                ? `Task cancelled by user: ${body.reason}`
                : 'Task cancelled by user.',
              createdBy: source,
            }),
          ]
        : [];

      // Execute all writes atomically
      const batchResults = await db.batch([
        rootCancelUpdate,
        rootHistoryInsert,
        ...childStatements,
        ...rootStopStatements,
      ] as Parameters<typeof db.batch>[0]);

      const rootResult = batchResults[0] as Array<{ id: string }>;
      if (rootResult.length === 0) {
        await reply.code(409).send({ error: 'status_changed' });
        return;
      }

      bus.emit({
        id: nanoid(),
        name: 'task.cancelled',
        occurredAt: new Date(),
        source,
        payload: { taskId, workspaceId },
      });

      // Run dep-unblocking pass so tasks waiting on this task get their blockedReason updated
      // to dep_cancelled:<id> and receive a task.dep_failed history event (DEDUP-023).
      await runDepUnblockingPass(db, workspaceId);

      await reply.send({ id: taskId, status: 'cancelled' });
    },
  );

  // ---------------------------------------------------------------------------
  // Retry: resets a failed task to pending_dispatcher_action so FM can
  // re-triage (rather than bypassing FM via pending_agent). Clears all
  // assignment fields. Any workspace member at collaborator level may retry.
  // Returns 409 for sequenced tasks — use the phase retry endpoint instead.
  // ---------------------------------------------------------------------------

  fastify.post<{ Params: { workspaceId: string; taskId: string } }>(
    '/workspaces/:workspaceId/tasks/:taskId/retry',
    { preHandler: requireWorkspaceMember(db, 'collaborator') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const user = getUser(req);
      const taskId = TaskIdSchema.parse(req.params.taskId);
      const body = RetryTaskBodySchema.parse(req.body ?? {});

      const task = await db
        .select({
          id: schema.tasks.id,
          status: schema.tasks.status,
          priority: schema.tasks.priority,
          sequenceSpec: schema.tasks.sequenceSpec,
        })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.workspaceId, workspaceId)))
        .get();
      if (!task) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      // Sequenced tasks must use the phase retry endpoint
      if (task.sequenceSpec !== null && task.sequenceSpec !== undefined) {
        await reply.code(409).send({
          error: 'use_phase_retry',
          message: 'Sequenced tasks must be retried via POST /workspaces/:id/tasks/:taskId/phases/:phaseIndex/retry',
        });
        return;
      }

      if (task.status !== 'failed') {
        await reply.code(409).send({ error: 'not_failed', status: task.status });
        return;
      }

      const updated = await db
        .update(schema.tasks)
        .set({
          status: 'pending_dispatcher_action',
          assignedAgentId: null,
          assignedAt: null,
          assignedDeviceId: null,
          priority: body.priority ?? task.priority,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.tasks.id, taskId),
            eq(schema.tasks.workspaceId, workspaceId),
            eq(schema.tasks.status, 'failed'),
          ),
        )
        .returning({ id: schema.tasks.id });

      if (updated.length === 0) {
        await reply.code(409).send({ error: 'status_changed' });
        return;
      }

      // Clear any stale agent memory so a fresh retry agent starts without
      // misleading prior-run context.
      await db.delete(schema.agentMemory).where(eq(schema.agentMemory.taskId, taskId));

      const source = `user:${user.id}`;
      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId,
        eventName: 'task.requeued',
        source,
        payload: { previousStatus: 'failed', priorityOverride: body.priority ?? null },
        workspaceId,
      });
      bus.emit({
        id: nanoid(),
        name: 'task.requeued',
        occurredAt: new Date(),
        source,
        payload: { taskId, workspaceId },
      });

      await reply.send({ id: taskId, status: 'pending_dispatcher_action' });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase retry: resets a specific failed phase task back to pending_agent
  // without resetting the entire sequence.
  // ---------------------------------------------------------------------------

  fastify.post<{ Params: { workspaceId: string; taskId: string; phaseIndex: string } }>(
    '/workspaces/:workspaceId/tasks/:taskId/phases/:phaseIndex/retry',
    { preHandler: requireWorkspaceMember(db, 'collaborator') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const user = getUser(req);
      const taskId = TaskIdSchema.parse(req.params.taskId);

      // Parse and validate phaseIndex
      const phaseIndexRaw = parseInt(req.params.phaseIndex, 10);
      if (!Number.isInteger(phaseIndexRaw) || phaseIndexRaw < 0) {
        await reply.code(400).send({ error: 'invalid_phase_index' });
        return;
      }

      // Fetch root task and validate it's a sequenced root task (not itself a phase task).
      // isNull(schema.tasks.phaseIndex) ensures taskId refers to a root, not a compound phase ID (DEDUP-026).
      // FORGE_SEQUENCES_ENABLED is NOT checked here: the flag gates only new sequence creation.
      // Existing in-flight sequences always complete via phase retry regardless of flag state (DEDUP-063).
      const rootTask = await db
        .select({
          id: schema.tasks.id,
          status: schema.tasks.status,
          sequenceSpec: schema.tasks.sequenceSpec,
        })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.id, taskId),
            eq(schema.tasks.workspaceId, workspaceId),
            isNull(schema.tasks.phaseIndex),
          ),
        )
        .get();

      if (!rootTask) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      if (!rootTask.sequenceSpec) {
        await reply.code(409).send({ error: 'not_sequenced' });
        return;
      }

      let spec: z.infer<typeof SequenceSpecSchema>;
      try {
        spec = SequenceSpecSchema.parse(JSON.parse(rootTask.sequenceSpec));
      } catch {
        await reply.code(500).send({ error: 'corrupt_sequence_spec' });
        return;
      }

      if (phaseIndexRaw >= spec.phases.length) {
        await reply.code(400).send({ error: 'invalid_phase_index' });
        return;
      }

      // Find the failed phase task
      const phaseTaskId = formatPhaseTaskId(taskId, phaseIndexRaw);
      const phaseTask = await db
        .select({ id: schema.tasks.id, status: schema.tasks.status })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.id, phaseTaskId),
            eq(schema.tasks.parentId, taskId),
            eq(schema.tasks.phaseIndex, phaseIndexRaw),
          ),
        )
        .get();

      if (!phaseTask) {
        await reply.code(404).send({ error: 'phase_task_not_found' });
        return;
      }

      if (phaseTask.status !== 'failed') {
        await reply.code(409).send({ error: 'phase_not_failed', status: phaseTask.status });
        return;
      }

      // Add null-guard for user session — preHandler guarantees a session, but defensive style (DEDUP-036).
      const source = user ? `user:${user.id}` : 'system';
      const now = new Date();

      // Optimistic lock on status='failed' to detect races where the phase task exits 'failed'
      // between our pre-check and this UPDATE (DEDUP-027). Also clear assignedDeviceId/assignedAt
      // so stale-assignment logic does not try to re-assign the old device.
      const phaseRetried = await db
        .update(schema.tasks)
        .set({
          status: 'pending_agent',
          result: null,
          assignedDeviceId: null,
          assignedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tasks.id, phaseTaskId),
            eq(schema.tasks.status, 'failed'),
          ),
        )
        .returning({ id: schema.tasks.id });

      if (phaseRetried.length === 0) {
        await reply.code(409).send({ error: 'phase_not_failed' });
        return;
      }

      // Clear stale agent memory for this phase task.
      await db.delete(schema.agentMemory).where(eq(schema.agentMemory.taskId, phaseTaskId));

      // Guard the root task UPDATE against races: if the root was cancelled between the phase
      // fetch and this UPDATE, the unguarded UPDATE would silently un-cancel it (DEDUP-003).
      // Only transition from sequenced_running or failed (the two valid states when a phase fails).
      const rootRetried = await db
        .update(schema.tasks)
        .set({ status: 'sequenced_running', blockedReason: null, updatedAt: now })
        .where(
          and(
            eq(schema.tasks.id, taskId),
            inArray(schema.tasks.status, ['sequenced_running', 'failed']),
          ),
        )
        .returning({ id: schema.tasks.id });

      if (rootRetried.length === 0) {
        // Root task is in a terminal status (e.g. cancelled) — cannot advance.
        await reply.code(409).send({ error: 'root_task_terminal' });
        return;
      }

      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId,
        eventName: 'task.phase_retried',
        source,
        payload: { phaseIndex: phaseIndexRaw },
        workspaceId,
      });

      await reply.send({ ok: true, phaseTaskId, status: 'pending_agent' });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /workspaces/:workspaceId/tasks — create a new task with optional
  // sequenceSpec (multi-phase) and dependsOn (dependency graph).
  // ---------------------------------------------------------------------------

  fastify.post<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/tasks',
    { preHandler: requireWorkspaceMember(db, 'collaborator') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const body = CreateWorkspaceTaskBodySchema.parse(req.body);
      const createdBy = `user:${getUser(req).id}`;
      const goalId = body.goalId || null;

      // Feature flag check for sequences (gates new sequence creation only, not ongoing execution).
      if (body.sequenceSpec) {
        if (!process.env['FORGE_SEQUENCES_ENABLED']) {
          await reply.code(422).send({ error: 'sequences_disabled' });
          return;
        }

        // Design doc Section 6.1: creating a sequenced task requires 'admin' role because
        // phase prompt content constitutes arbitrary agent command injection to privileged roles.
        // requireWorkspaceMember(db, 'collaborator') is used for the whole handler;
        // escalate to 'admin' here when sequenceSpec is present (DEDUP-019).
        const requester = getUser(req);
        const membership = await db
          .select({ role: schema.workspaceMembers.role })
          .from(schema.workspaceMembers)
          .where(
            and(
              eq(schema.workspaceMembers.workspaceId, workspaceId),
              eq(schema.workspaceMembers.userId, requester.id),
            ),
          )
          .get();
        if (!membership || !rankAtLeast(membership.role, 'admin')) {
          await reply.code(403).send({ error: 'admin_required_for_sequences' });
          return;
        }
      }

      if (goalId) {
        const goal = await db
          .select({ id: schema.goals.id })
          .from(schema.goals)
          .where(and(eq(schema.goals.id, goalId), eq(schema.goals.workspaceId, workspaceId)))
          .get();
        if (!goal) {
          await reply.code(404).send({ error: 'goal_not_found' });
          return;
        }
      }

      // Validate parentId: the parent task must exist in the same workspace.
      const parentId = body.parentId ?? null;
      if (parentId !== null) {
        const parent = await db
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(and(eq(schema.tasks.id, parentId), eq(schema.tasks.workspaceId, workspaceId)))
          .get();
        if (!parent) {
          await reply.code(404).send({ error: 'parent_task_not_found' });
          return;
        }
      }

      // Validate dependsOn
      const dependsOn = body.dependsOn ?? [];
      // maxSeqFromDeps is set when cycle detection runs (dependsOn non-empty), so it can be reused for
      // actual insertion without a second getMaxRootSeq call that could race and alias the same ID.
      let maxSeqFromDeps: number | undefined;
      if (dependsOn.length > 0) {
        // Fetch all referenced dep tasks in this workspace (add workspaceId filter at DB layer for safety)
        const depTasks = await db
          .select({ id: schema.tasks.id, phaseIndex: schema.tasks.phaseIndex, workspaceId: schema.tasks.workspaceId, dependsOn: schema.tasks.dependsOn })
          .from(schema.tasks)
          .where(and(inArray(schema.tasks.id, dependsOn), eq(schema.tasks.workspaceId, workspaceId)));

        const depTaskMap = new Map(depTasks.map((t) => [t.id, t]));

        // Check for unknown dep IDs
        const unknownIds = dependsOn.filter((id) => !depTaskMap.has(id));
        if (unknownIds.length > 0) {
          await reply.code(422).send({ error: 'unknown_dep_ids', ids: unknownIds });
          return;
        }

        // Check for phase task deps (invalid)
        const phaseDepIds = dependsOn.filter((id) => depTaskMap.get(id)?.phaseIndex !== null && depTaskMap.get(id)?.phaseIndex !== undefined);
        if (phaseDepIds.length > 0) {
          await reply.code(422).send({ error: 'invalid_dep_phase_task' });
          return;
        }

        // Check all deps belong to the same workspace
        const crossWorkspaceDeps = dependsOn.filter((id) => depTaskMap.get(id)?.workspaceId !== workspaceId);
        if (crossWorkspaceDeps.length > 0) {
          await reply.code(422).send({ error: 'invalid_dep_workspace' });
          return;
        }

        // Build adjacency map for cycle detection from the FULL workspace task graph,
        // not just the subgraph rooted at the new task's direct deps. Partial graphs miss
        // transitive cycles through intermediate nodes not in this request's dependsOn array.
        // Design doc Section 7: build the adjacency map from all existing tasks in workspace.
        const allWorkspaceTasks = await db
          .select({ id: schema.tasks.id, dependsOn: schema.tasks.dependsOn })
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.workspaceId, workspaceId),
              isNull(schema.tasks.parentId),
            ),
          );

        // Build adjacency map for cycle detection. The node set is all workspace task IDs.
        // First pass: collect all workspace task IDs so we can filter cross-workspace edges.
        // Second pass: parse each task's dependsOn and filter to only IDs present in the workspace
        // to prevent historical cross-workspace data corruption from causing false-positive cycles (DEDUP-019).
        const workspaceTaskIds = new Set(allWorkspaceTasks.map((t) => t.id));
        const existingEdges = new Map<string, string[]>();
        for (const wTask of allWorkspaceTasks) {
          try {
            const deps = z.array(z.string()).parse(JSON.parse(wTask.dependsOn));
            // Filter to only IDs within this workspace to avoid false-positive cycle detection
            // from cross-workspace or orphaned dep references (DEDUP-019).
            existingEdges.set(wTask.id, deps.filter((id) => workspaceTaskIds.has(id)));
          } catch {
            // Log corrupt dependsOn columns (consistent with unblocking pass pattern) (DEDUP-019).
            console.warn('[cycle-detection] corrupt depends_on on task', wTask.id, '— treating as no deps');
            existingEdges.set(wTask.id, []);
          }
        }

        // Get the new task ID to use for cycle detection (we need to compute it first)
        // Store in outer-scope variable so it can be reused for actual insertion (DEDUP-004).
        maxSeqFromDeps = await getMaxRootSeq(db, body.projectPrefix);
        const tentativeId = formatTaskId(body.projectPrefix, maxSeqFromDeps + 1);

        // Check self-dependency
        if (dependsOn.includes(tentativeId)) {
          await reply.code(422).send({ error: 'dep_cycle', cycle: [tentativeId] });
          return;
        }

        const cycle = detectCycle(tentativeId, dependsOn, existingEdges);
        if (cycle) {
          await reply.code(422).send({ error: 'dep_cycle', cycle });
          return;
        }
      }

      // Use maxSeqFromDeps if it was computed during cycle detection (dependsOn non-empty),
      // otherwise call getMaxRootSeq once here. Do NOT call getMaxRootSeq again when deps were present,
      // as a second call could race and alias the same ID (DEDUP-004).
      const maxSeq = maxSeqFromDeps !== undefined ? maxSeqFromDeps : await getMaxRootSeq(db, body.projectPrefix);
      const id = formatTaskId(body.projectPrefix, maxSeq + 1);

      // Determine initial status based on deps
      // workspaceId filter is added at the DB layer as defense-in-depth (DEDUP-030).
      const allDepsDone =
        dependsOn.length === 0 ||
        (await (async () => {
          const depStatuses = await db
            .select({ id: schema.tasks.id, status: schema.tasks.status })
            .from(schema.tasks)
            .where(and(inArray(schema.tasks.id, dependsOn), eq(schema.tasks.workspaceId, workspaceId)));
          return depStatuses.every((d) => TERMINAL_SUCCESS_STATUSES.has(d.status as Parameters<typeof TERMINAL_SUCCESS_STATUSES.has>[0]));
        })());

      const assignedAgentId = body.assignedAgentId ?? null;
      const now = new Date();

      if (body.sequenceSpec) {
        // Sequenced task creation
        const specJson = JSON.stringify(body.sequenceSpec);
        const specHash = createHash('sha256').update(specJson).digest('hex');

        if (!allDepsDone) {
          // Task must wait for deps before phase-0 can start.
          // blockedReason is left null (matching plain dep-blocked tasks) — use the status
          // 'waiting_on_deps' as the display signal rather than duplicating it in blockedReason (DEDUP-012).
          await db.insert(schema.tasks).values({
            id,
            projectPrefix: body.projectPrefix,
            title: body.title,
            description: body.description ?? null,
            priority: body.priority ?? 'normal',
            goalId,
            parentId,
            workspaceId,
            assignedAgentId,
            status: 'waiting_on_deps',
            blockedReason: null,
            taskKind: body.taskKind ?? 'coding',
            reviewConfig: body.reviewConfig ?? null,
            sequenceSpec: specJson,
            sequenceSpecHash: specHash,
            dependsOn: JSON.stringify(dependsOn),
            createdBy,
            createdAt: now,
            updatedAt: now,
          });
          await db.insert(schema.taskHistory).values({
            id: nanoid(),
            taskId: id,
            eventName: 'task.created',
            source: createdBy,
            payload: { title: body.title, sequenced: true, waitingOnDeps: true, ...maybeRunId(req) },
            workspaceId,
          });
          bus.emit({
            id: nanoid(),
            name: 'task.created',
            occurredAt: new Date(),
            source: createdBy,
            payload: { taskId: id, projectPrefix: body.projectPrefix, workspaceId },
          });
          await reply.code(201).send({ id });
          return;
        }

        // Deps satisfied — create phase-0 immediately
        const phase0 = body.sequenceSpec.phases[0];
        if (!phase0) {
          await reply.code(422).send({ error: 'sequence_spec_empty' });
          return;
        }
        const phase0Id = formatPhaseTaskId(id, 0);

        // Check device availability for phase-0 role
        const cutoff = new Date(Date.now() - STALE_TTL_MS);
        const activeDevices = await db
          .select({ id: schema.devices.id })
          .from(schema.devices)
          .where(
            and(
              eq(schema.devices.agentId, phase0.role),
              eq(schema.devices.status, 'active'),
              gte(schema.devices.lastSeen, cutoff),
            ),
          );

        const blockedReason = activeDevices.length === 0 ? `role_unavailable:${phase0.role}` : null;

        // Atomically insert root task + phase-0 task + history in a single libsql batch (DEDUP-002).
        // A crash between two separate awaits would leave root created but phase-0 missing.
        const rootInsert = db.insert(schema.tasks).values({
          id,
          projectPrefix: body.projectPrefix,
          title: body.title,
          description: body.description ?? null,
          priority: body.priority ?? 'normal',
          goalId,
          parentId,
          workspaceId,
          assignedAgentId,
          status: 'sequenced_running',
          blockedReason,
          taskKind: body.taskKind ?? 'coding',
          reviewConfig: body.reviewConfig ?? null,
          sequenceSpec: specJson,
          sequenceSpecHash: specHash,
          dependsOn: JSON.stringify(dependsOn),
          createdBy,
          createdAt: now,
          updatedAt: now,
        });
        const phase0Insert = db.insert(schema.tasks).values({
          id: phase0Id,
          projectPrefix: body.projectPrefix,
          title: phase0.title,
          description: phase0.prompt,
          priority: body.priority ?? 'normal',
          workspaceId,
          parentId: id,
          phaseIndex: 0,
          assignedAgentId: phase0.role,
          status: 'pending_agent',
          dependsOn: '[]',
          taskKind: 'coding',
          createdBy,
          createdAt: now,
          updatedAt: now,
        });
        const createdHistoryInsert = db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId: id,
          eventName: 'task.created',
          source: createdBy,
          payload: { title: body.title, sequenced: true, phaseTaskId: phase0Id, ...maybeRunId(req) },
          workspaceId,
        });

        // Atomically insert root task + phase-0 task + history in a single libsql batch (DEDUP-002).
        // A crash between two separate awaits would leave root created but phase-0 missing.
        if (blockedReason) {
          await db.batch([
            rootInsert,
            phase0Insert,
            createdHistoryInsert,
            db.insert(schema.taskHistory).values({
              id: nanoid(),
              taskId: id,
              eventName: 'task.phase_blocked',
              source: 'system',
              payload: { phase: 0, reason: blockedReason },
              workspaceId,
            }),
          ] as Parameters<typeof db.batch>[0]);
        } else {
          await db.batch([rootInsert, phase0Insert, createdHistoryInsert] as Parameters<typeof db.batch>[0]);
        }

        bus.emit({
          id: nanoid(),
          name: 'task.created',
          occurredAt: new Date(),
          source: createdBy,
          payload: { taskId: id, projectPrefix: body.projectPrefix, workspaceId },
        });
        await reply.code(201).send({ id });
        return;
      }

      // Plain (non-sequenced) task creation
      // FM-as-front-door routing for the user-facing workspace endpoint: a task
      // created without an explicit agent goes to the dispatcher inbox so Forge
      // Master triages it, rather than defaulting to pending_agent where any
      // worker would race to claim it (bypassing triage entirely). A caller that
      // pre-assigns an agent keeps the direct pending_agent path so the target
      // worker picks it up. (The flat device endpoint POST /tasks keeps its own
      // default — it is the automation path and routes explicitly.)
      const initialStatus = !allDepsDone ? 'waiting_on_deps' : 'pending_agent';
      // blockedReason is left null initially; the unblocking pass will set a specific reason
      // (e.g. dep_cancelled:<id>, dep_failed:<id>) if a dep is cancelled or failed.
      // Using the status name 'waiting_on_deps' as the reason is redundant and provides no
      // actionable information beyond the status itself (DEDUP-037).
      const initialBlockedReason = null;

      await db.insert(schema.tasks).values({
        id,
        projectPrefix: body.projectPrefix,
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? 'normal',
        goalId,
        parentId,
        workspaceId,
        assignedAgentId,
        status: initialStatus,
        blockedReason: initialBlockedReason,
        taskKind: body.taskKind ?? 'coding',
        reviewConfig: body.reviewConfig ?? null,
        dependsOn: JSON.stringify(dependsOn),
        createdBy,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId: id,
        eventName: 'task.created',
        source: createdBy,
        payload: { title: body.title, ...maybeRunId(req) },
        workspaceId,
      });
      bus.emit({
        id: nanoid(),
        name: 'task.created',
        occurredAt: new Date(),
        source: createdBy,
        payload: { taskId: id, projectPrefix: body.projectPrefix, workspaceId },
      });
      await reply.code(201).send({ id });
    },
  );

  fastify.get<{ Params: { workspaceId: string }; Querystring: { includePhaseTasks?: string } }>(
    '/workspaces/:workspaceId/tasks',
    { preHandler: requireWorkspaceMember(db) },
    async (req) => {
      const { id: workspaceId } = getWorkspace(req);
      const includePhaseTasks = req.query.includePhaseTasks === 'true';

      // parentId IS NULL excludes both phase tasks (which have parentId = root task ID) AND
      // FM subtasks (which may also have a parentId from FM decomposition). This is intentional
      // per design doc Section 6.7 (DEDUP-015). Do NOT change to phaseIndex IS NULL — that would
      // include FM subtasks in the list response (DEDUP-062).
      //
      // Behavioral note (DEDUP-015): FM subtasks (tasks with parentId set via FM decomposition)
      // are excluded from the default workspace task list. This is a deliberate design choice:
      // the list shows root tasks only; FM subtasks are implementation details of FM triage.
      // A test asserting this behavior exists in tasks.test.ts (T-FM-subtask-hidden).
      const whereClause = includePhaseTasks
        ? eq(schema.tasks.workspaceId, workspaceId)
        : and(eq(schema.tasks.workspaceId, workspaceId), isNull(schema.tasks.parentId));

      const tasks = await db
        .select()
        .from(schema.tasks)
        .where(whereClause)
        .orderBy(desc(schema.tasks.createdAt));
      return { tasks };
    },
  );

  // ---------------------------------------------------------------------------
  // Flat complete endpoint (device-side, for non-sequenced root tasks).
  // Returns 409 if the task is a phase task (must use workspace-scoped endpoint).
  // Returns 409 if the task has a sequenceSpec (must not complete root directly).
  // ---------------------------------------------------------------------------

  fastify.post<{ Params: { id: string } }>(
    '/tasks/:id/complete',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      const id = TaskIdSchema.parse(req.params.id);
      const body = CompleteTaskBodySchema.parse(req.body ?? {});
      const task = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
      if (!task) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      // Phase tasks must use the workspace-scoped complete endpoint
      if (task.phaseIndex !== null && task.phaseIndex !== undefined) {
        await reply.code(409).send({
          error: 'use_phase_complete',
          message: 'Phase tasks must be completed via the workspace-scoped endpoint POST /workspaces/:id/tasks/:taskId/complete',
        });
        return;
      }

      // Sequenced root tasks must not be completed via the flat endpoint — they advance automatically
      // via phase completion. Error code matches design doc Section 6.2 (DEDUP-009).
      if (task.sequenceSpec !== null && task.sequenceSpec !== undefined) {
        await reply.code(409).send({
          error: 'use_phase_complete',
          message: 'Sequenced root tasks advance automatically via phase completion. Complete individual phases via the workspace-scoped phases endpoint.',
        });
        return;
      }

      if (task.assignedDeviceId !== device.id) {
        await reply.code(403).send({ error: 'not_assigned_to_you' });
        return;
      }

      // Cap the result before using it in both the DB update and the bus payload
      // so the bus never receives the uncapped string (DEDUP-031).
      const truncatedResultFlat = body.result ? body.result.slice(0, 4000) : null;

      // Optimistic lock: only complete if still in_progress
      const completedRows = await db
        .update(schema.tasks)
        .set({
          status: 'completed',
          result: truncatedResultFlat,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress')))
        .returning({ id: schema.tasks.id });

      if (completedRows.length === 0) {
        // Optimistic lock failed — check current status for discriminated error
        const current = await db
          .select({ status: schema.tasks.status })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, id))
          .get();
        if (!current) {
          await reply.code(404).send({ error: 'task_not_found' });
          return;
        }
        if (current.status === 'completed' || current.status === 'sequenced_complete') {
          await reply.code(409).send({ error: 'already_completed' });
          return;
        }
        if (current.status === 'cancelled') {
          await reply.code(409).send({ error: 'task_cancelled' });
          return;
        }
        if (current.status === 'failed') {
          await reply.code(409).send({ error: 'task_failed' });
          return;
        }
        await reply.code(409).send({ error: 'invalid_transition', currentStatus: current.status });
        return;
      }

      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId: id,
        eventName: 'task.completed',
        source: `device:${device.id}`,
        payload: { result: truncatedResultFlat, ...maybeRunId(req) },
      });

      // Run dep-unblocking pass BEFORE bus.emit so newly-unblocked tasks are visible
      // to any subscriber that fires on task.completed (DEDUP-006).
      if (task.workspaceId) {
        await runDepUnblockingPass(db, task.workspaceId);
      }

      bus.emit({
        id: nanoid(),
        name: 'task.completed',
        occurredAt: new Date(),
        source: `device:${device.id}`,
        // Include result and workspaceId so reactive listeners (e.g. Scribe)
        // can evaluate significance without extra round-trips.
        // Use truncatedResultFlat — never emit the uncapped body.result (DEDUP-031).
        payload: { taskId: id, result: truncatedResultFlat, workspaceId: task.workspaceId ?? null },
      });

      await reply.send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // Workspace-scoped complete endpoint — used by phase tasks and any workspace
  // task completing via the workspace-scoped path. Handles phase transitions,
  // dep unblocking, and the sequence_spec_hash integrity check.
  // ---------------------------------------------------------------------------

  fastify.post<{ Params: { workspaceId: string; taskId: string } }>(
    '/workspaces/:workspaceId/tasks/:taskId/complete',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      const { workspaceId } = req.params;
      const taskId = TaskIdSchema.parse(req.params.taskId);
      const body = CompleteTaskBodySchema.parse(req.body ?? {});

      // Validate workspace existence before device auth check to avoid leaking task existence
      // to unauthenticated devices via 403 vs 404 discrimination (DEDUP-028).
      const workspace = await db
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .get();
      if (!workspace) {
        await reply.code(404).send({ error: 'workspace_not_found' });
        return;
      }

      const task = await db
        .select()
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.id, taskId),
            eq(schema.tasks.workspaceId, workspaceId),
          ),
        )
        .get();

      if (!task) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      // Auth: only the assigned device may complete this task.
      // Phase tasks are created with assignedDeviceId=NULL; after claim the claim endpoint sets assignedDeviceId.
      // Authorization uses a two-tier check (DEDUP-002):
      //   1. Null guard: if either agentId is missing, reject immediately to prevent null==null false-pass.
      //   2. Device-level: if the task has been claimed (assignedDeviceId set), check device.id matches.
      //   3. Role-level fallback: if not yet claimed, check device.agentId matches task.assignedAgentId.
      // Plain (non-phase) tasks use assignedDeviceId exclusively.
      const isPhaseTask = task.phaseIndex !== null && task.phaseIndex !== undefined;
      if (isPhaseTask) {
        // Null guard: both agentIds must be non-null to prevent null !== null from evaluating false (DEDUP-002).
        if (!device.agentId || !task.assignedAgentId) {
          await reply.code(403).send({ error: 'device_not_assigned' });
          return;
        }
        // If task has been claimed by a specific device, use device-level auth as the authoritative check.
        // Fall back to role-level only for pre-claim state (assignedDeviceId is null).
        if (task.assignedDeviceId !== null) {
          if (task.assignedDeviceId !== device.id) {
            await reply.code(403).send({ error: 'device_not_assigned' });
            return;
          }
        } else {
          if (device.agentId !== task.assignedAgentId) {
            await reply.code(403).send({ error: 'device_not_assigned' });
            return;
          }
        }
      } else {
        if (task.assignedDeviceId !== device.id) {
          await reply.code(403).send({ error: 'device_not_assigned' });
          return;
        }
      }

      const truncatedResult = body.result ? body.result.slice(0, 4000) : null;
      // 'task' is the pre-update snapshot. Decisions made after the optimistic UPDATE
      // use fields read from this snapshot; they must not depend on post-write DB state.
      const now = new Date();
      const source = `device:${device.id}`;

      // Phase transition logic.
      // FORGE_SEQUENCES_ENABLED gates only new sequence CREATION, not ongoing execution.
      // Phase transitions must fire whenever phaseIndex IS NOT NULL AND parentId IS NOT NULL,
      // regardless of the flag state. Removing the flag check here fixes split-brain where
      // unblocking creates phase-0 tasks but completions don't advance them (DEDUP-006, DEDUP-032).
      //
      // Precondition validation (hash check + spec parse) runs BEFORE the optimistic UPDATE,
      // so a validation failure never leaves the phase task permanently in 'completed' while
      // the root task is not advanced (DEDUP-003).
      let phaseParent: typeof schema.tasks.$inferSelect | null = null;
      let phaseSpec: z.infer<typeof SequenceSpecSchema> | null = null;

      if (
        task.phaseIndex !== null &&
        task.phaseIndex !== undefined &&
        task.parentId !== null
      ) {
        // Fetch parent task
        const parentRow = await db
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.id, task.parentId))
          .get();

        if (parentRow?.sequenceSpec) {
          // Verify sequence_spec_hash integrity BEFORE any writes (DEDUP-003).
          const computedHash = createHash('sha256').update(parentRow.sequenceSpec).digest('hex');
          if (computedHash !== parentRow.sequenceSpecHash) {
            await db.insert(schema.taskHistory).values({
              id: nanoid(),
              taskId: parentRow.id,
              eventName: 'task.sequence_integrity_failure',
              source: 'system',
              payload: { computedHash, storedHash: parentRow.sequenceSpecHash },
              workspaceId,
            });
            await reply.code(500).send({ error: 'sequence_integrity_failure' });
            return;
          }

          // Parse spec BEFORE any writes (DEDUP-003).
          try {
            phaseSpec = SequenceSpecSchema.parse(JSON.parse(parentRow.sequenceSpec));
          } catch {
            await reply.code(500).send({ error: 'corrupt_sequence_spec' });
            return;
          }

          phaseParent = parentRow;
        }
      }

      // Optimistic lock: only complete if still in_progress
      const completedRows = await db
        .update(schema.tasks)
        .set({
          status: 'completed',
          result: truncatedResult,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tasks.id, taskId),
            eq(schema.tasks.status, 'in_progress'),
          ),
        )
        .returning({ id: schema.tasks.id });

      if (completedRows.length === 0) {
        const current = await db
          .select({ status: schema.tasks.status })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId))
          .get();
        if (!current) {
          await reply.code(404).send({ error: 'task_not_found' });
          return;
        }
        if (current.status === 'completed' || current.status === 'sequenced_complete') {
          await reply.code(409).send({ error: 'already_completed' });
          return;
        }
        if (current.status === 'cancelled') {
          await reply.code(409).send({ error: 'task_cancelled' });
          return;
        }
        if (current.status === 'failed') {
          await reply.code(409).send({ error: 'task_failed' });
          return;
        }
        await reply.code(409).send({ error: 'invalid_transition', currentStatus: current.status });
        return;
      }

      if (
        phaseParent !== null &&
        phaseSpec !== null &&
        task.phaseIndex !== null &&
        task.phaseIndex !== undefined
      ) {
        const parent = phaseParent;
        const spec = phaseSpec;

        const completingPhaseIndex = task.phaseIndex;
        const nextPhaseIndex = completingPhaseIndex + 1;

        if (nextPhaseIndex < spec.phases.length) {
          // Advance to next phase
          const nextPhase = spec.phases[nextPhaseIndex];
          if (!nextPhase) {
            // Unreachable: guarded by nextPhaseIndex < spec.phases.length above
            await reply.code(500).send({ error: 'internal_error' });
            return;
          }
          const nextPhaseId = formatPhaseTaskId(parent.id, nextPhaseIndex);

          // Check device availability for next phase role
          const cutoff = new Date(Date.now() - STALE_TTL_MS);
          const activeDevices = await db
            .select({ id: schema.devices.id })
            .from(schema.devices)
            .where(
              and(
                eq(schema.devices.agentId, nextPhase.role),
                eq(schema.devices.status, 'active'),
                gte(schema.devices.lastSeen, cutoff),
              ),
            );

          const nextDesc = buildNextPhaseDescription(
            nextPhase.prompt,
            truncatedResult ?? '',
            completingPhaseIndex,
          );

          if (activeDevices.length === 0) {
            // Role unavailable — batch: next phase INSERT + root blocked_reason UPDATE + history INSERTs (DEDUP-002).
            await db.batch([
              db.insert(schema.tasks).values({
                id: nextPhaseId,
                workspaceId,
                projectPrefix: parent.projectPrefix,
                title: nextPhase.title,
                description: nextDesc,
                status: 'pending_agent',
                priority: parent.priority,
                parentId: parent.id,
                phaseIndex: nextPhaseIndex,
                assignedAgentId: nextPhase.role,
                dependsOn: '[]',
                taskKind: 'coding',
                createdBy: 'system',
                createdAt: now,
                updatedAt: now,
              }),
              db
                .update(schema.tasks)
                .set({
                  blockedReason: `role_unavailable:${nextPhase.role}`,
                  updatedAt: now,
                })
                .where(eq(schema.tasks.id, parent.id)),
              db.insert(schema.taskHistory).values({
                id: nanoid(),
                taskId,
                eventName: 'task.completed',
                source,
                payload: { result: truncatedResult, phaseIndex: completingPhaseIndex, ...maybeRunId(req) },
                workspaceId,
              }),
              db.insert(schema.taskHistory).values({
                id: nanoid(),
                taskId: parent.id,
                eventName: 'task.phase_blocked',
                source: 'system',
                payload: { phase: nextPhaseIndex, reason: `role_unavailable:${nextPhase.role}` },
                workspaceId,
              }),
            ] as Parameters<typeof db.batch>[0]);

            // Run dep-unblocking pass BEFORE bus.emit so newly-unblocked tasks are visible
            // to any subscriber that fires on task.completed (DEDUP-006).
            await runDepUnblockingPass(db, workspaceId);

            // Include phaseIndex in bus payload so daemon.ts can check p.phaseIndex !== null
            // instead of relying on regex matching on the task ID string (DEDUP-049).
            bus.emit({
              id: nanoid(),
              name: 'task.completed',
              occurredAt: new Date(),
              source,
              payload: { taskId, workspaceId, phaseIndex: completingPhaseIndex },
            });

            await reply.send({ status: 'phase_blocked', reason: 'role_unavailable' });
            return;
          }

          // Role available — batch: next phase INSERT + root status UPDATE + history INSERTs (DEDUP-002).
          await db.batch([
            db.insert(schema.tasks).values({
              id: nextPhaseId,
              workspaceId,
              projectPrefix: parent.projectPrefix,
              title: nextPhase.title,
              description: nextDesc,
              status: 'pending_agent',
              priority: parent.priority,
              parentId: parent.id,
              phaseIndex: nextPhaseIndex,
              assignedAgentId: nextPhase.role,
              dependsOn: '[]',
              taskKind: 'coding',
              createdBy: 'system',
              createdAt: now,
              updatedAt: now,
            }),
            db
              .update(schema.tasks)
              .set({ status: 'sequenced_running', updatedAt: now })
              .where(eq(schema.tasks.id, parent.id)),
            db.insert(schema.taskHistory).values({
              id: nanoid(),
              taskId,
              eventName: 'task.completed',
              source,
              payload: { result: truncatedResult, phaseIndex: completingPhaseIndex, ...maybeRunId(req) },
              workspaceId,
            }),
            db.insert(schema.taskHistory).values({
              id: nanoid(),
              taskId: parent.id,
              eventName: 'task.phase_advanced',
              source: 'system',
              payload: {
                fromPhase: completingPhaseIndex,
                toPhase: nextPhaseIndex,
                phaseTaskId: nextPhaseId,
              },
              workspaceId,
            }),
          ] as Parameters<typeof db.batch>[0]);

          // Run dep-unblocking pass BEFORE bus.emit so newly-unblocked tasks are visible
          // to any subscriber that fires on task.completed (DEDUP-006).
          await runDepUnblockingPass(db, workspaceId);

          // Include phaseIndex in bus payload so daemon.ts can check p.phaseIndex !== null
          // instead of relying on regex matching on the task ID string (DEDUP-049).
          bus.emit({
            id: nanoid(),
            name: 'task.completed',
            occurredAt: new Date(),
            source,
            payload: { taskId, workspaceId, phaseIndex: completingPhaseIndex },
          });

          await reply.send({ ok: true, nextPhaseId });
          return;
        }

        // All phases done — batch: root UPDATE to sequenced_complete + history INSERTs (DEDUP-002).
        await db.batch([
          db
            .update(schema.tasks)
            .set({
              status: 'sequenced_complete',
              result: truncatedResult,
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(schema.tasks.id, parent.id)),
          db.insert(schema.taskHistory).values({
            id: nanoid(),
            taskId,
            eventName: 'task.completed',
            source,
            payload: { result: truncatedResult, phaseIndex: completingPhaseIndex, ...maybeRunId(req) },
            workspaceId,
          }),
          db.insert(schema.taskHistory).values({
            id: nanoid(),
            taskId: parent.id,
            eventName: 'task.sequence_complete',
            source: 'system',
            payload: { result: truncatedResult },
            workspaceId,
          }),
        ] as Parameters<typeof db.batch>[0]);

        // Unblock tasks waiting on the root task (it just reached sequenced_complete).
        // Run BEFORE bus.emit so newly-unblocked tasks are visible to subscribers (DEDUP-006).
        await runDepUnblockingPass(db, workspaceId);

        // Include phaseIndex in bus payload so daemon.ts can check p.phaseIndex !== null
        // instead of relying on regex matching on the task ID string (DEDUP-049).
        bus.emit({
          id: nanoid(),
          name: 'task.completed',
          occurredAt: new Date(),
          source,
          payload: { taskId, workspaceId, phaseIndex: completingPhaseIndex },
        });

        await reply.send({ ok: true, sequenceComplete: true });
        return;
      }

      // Non-phase task completion
      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId,
        eventName: 'task.completed',
        source,
        payload: { result: truncatedResult, ...maybeRunId(req) },
        workspaceId,
      });

      // Run dep-unblocking pass BEFORE bus.emit so newly-unblocked tasks are visible
      // to any subscriber that fires on task.completed (DEDUP-006).
      await runDepUnblockingPass(db, workspaceId);

      bus.emit({
        id: nanoid(),
        name: 'task.completed',
        occurredAt: new Date(),
        source,
        payload: { taskId, result: truncatedResult, workspaceId },
      });

      await reply.send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // Device fail: marks an in_progress task as failed. Only the device that
  // claimed the task (assignedDeviceId) may call this. Allows recovery when
  // agent spawn fails after claim — without this the task is stuck in_progress.
  // ---------------------------------------------------------------------------
  fastify.post<{ Params: { id: string } }>(
    '/tasks/:id/fail',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      const id = TaskIdSchema.parse(req.params.id);
      const body = FailTaskBodySchema.parse(req.body ?? {});
      const task = await db
        .select({
          id: schema.tasks.id,
          status: schema.tasks.status,
          assignedDeviceId: schema.tasks.assignedDeviceId,
          workspaceId: schema.tasks.workspaceId,
          phaseIndex: schema.tasks.phaseIndex,
          parentId: schema.tasks.parentId,
        })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, id))
        .get();
      if (!task) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (task.status !== 'in_progress') {
        await reply.code(409).send({ error: 'not_in_progress' });
        return;
      }
      if (task.assignedDeviceId !== device.id) {
        await reply.code(403).send({ error: 'not_assigned_to_you' });
        return;
      }
      // Atomic UPDATE with status + device guard prevents concurrent fail requests
      // from the same device from both inserting duplicate task.failed history events.
      const failed = await db
        .update(schema.tasks)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(
          and(
            eq(schema.tasks.id, id),
            eq(schema.tasks.status, 'in_progress'),
            eq(schema.tasks.assignedDeviceId, device.id),
          ),
        )
        .returning({ id: schema.tasks.id });
      if (failed.length === 0) {
        // Lost race — another concurrent request already failed/changed this task
        await reply.code(409).send({ error: 'not_in_progress' });
        return;
      }
      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId: id,
        eventName: 'task.failed',
        source: `device:${device.id}`,
        payload: { reason: body.reason ?? null, ...maybeRunId(req) },
      });
      bus.emit({
        id: nanoid(),
        name: 'task.failed',
        occurredAt: new Date(),
        source: `device:${device.id}`,
        payload: { taskId: id },
      });

      // Propagate phase failure to root task so operators have a visible signal (DEDUP-015).
      // When a phase task fails, the root remains in 'sequenced_running' with no blocked_reason
      // unless we explicitly update it here.
      if (task.phaseIndex !== null && task.phaseIndex !== undefined && task.parentId !== null) {
        await db
          .update(schema.tasks)
          .set({
            blockedReason: `phase_failed:${task.phaseIndex}`,
            updatedAt: new Date(),
          })
          .where(eq(schema.tasks.id, task.parentId));
        if (task.workspaceId) {
          await db.insert(schema.taskHistory).values({
            id: nanoid(),
            taskId: task.parentId,
            eventName: 'task.phase_blocked',
            source: 'system',
            payload: { phase: task.phaseIndex, reason: `phase_failed:${task.phaseIndex}` },
            workspaceId: task.workspaceId,
          });
        }
      }

      // Run dep-unblocking pass to propagate failure status to waiting tasks
      if (task.workspaceId) {
        await runDepUnblockingPass(db, task.workspaceId);
      }

      await reply.send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /workspaces/:workspaceId/tasks/:taskId
  // Returns the task with all sequencing fields + assembled phases array.
  // TODO (v2): implement 'dependents' reverse-dep field via LIKE query on depends_on
  // column, per design doc Section 6.6. The HubTask type intentionally has no
  // 'dependents' field until it is populated by the server (DEDUP-038).
  // ---------------------------------------------------------------------------

  fastify.get<{ Params: { workspaceId: string; taskId: string } }>(
    '/workspaces/:workspaceId/tasks/:taskId',
    { preHandler: requireWorkspaceMember(db) },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const taskId = TaskIdSchema.parse(req.params.taskId);

      const task = await db
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.workspaceId, workspaceId)))
        .get();
      if (!task) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      // Assemble phases array for sequenced root tasks
      let phases: Array<{
        phaseIndex: number;
        taskId: string | undefined;
        title: string;
        role: string;
        status: 'pending' | 'active' | 'complete' | 'failed';
        result: string | undefined;
      }> | undefined;

      if (task.sequenceSpec) {
        let spec: { phases: Array<{ title: string; role: string; prompt: string }> } | null = null;
        try {
          spec = SequenceSpecSchema.parse(JSON.parse(task.sequenceSpec));
        } catch {
          // malformed sequenceSpec — skip phases assembly
        }

        if (spec) {
          const phaseChildren = await db
            .select({
              id: schema.tasks.id,
              phaseIndex: schema.tasks.phaseIndex,
              status: schema.tasks.status,
              result: schema.tasks.result,
            })
            .from(schema.tasks)
            .where(and(eq(schema.tasks.parentId, taskId), isNotNull(schema.tasks.phaseIndex)));

          // Filter to only children with a non-null phaseIndex (isNotNull predicate is a runtime
          // guarantee but TypeScript cannot narrow through ORM query predicates — DEDUP-035).
          const childMap = new Map(
            phaseChildren
              .filter((c): c is typeof c & { phaseIndex: number } => c.phaseIndex !== null)
              .map((c) => [c.phaseIndex, c]),
          );

          phases = spec.phases.map((phaseSpec, i) => {
            const child = childMap.get(i);
            let phaseStatus: 'pending' | 'active' | 'complete' | 'failed' = 'pending';
            if (child) {
              if (child.status === 'completed' || child.status === 'sequenced_complete') phaseStatus = 'complete';
              else if (child.status === 'failed') phaseStatus = 'failed';
              else phaseStatus = 'active'; // pending_agent / assigned / in_progress = phase task exists, in flight
            }
            return {
              phaseIndex: i,
              taskId: child?.id,
              title: phaseSpec.title,
              role: phaseSpec.role,
              status: phaseStatus,
              result: child?.result ?? undefined,
            };
          });
        }
      }

      // Validate dependsOn with Zod (consistent with unblocking pass pattern) to avoid
      // unsafe casts if the column contains non-string values due to DB corruption (DEDUP-034).
      const dependsOn = (() => {
        try {
          return z.array(z.string()).parse(JSON.parse(task.dependsOn));
        } catch {
          return [] as string[];
        }
      })();

      // Parse sequenceSpec from raw JSON string to object so the wire format matches
      // HubTask.sequenceSpec: SequenceSpec | null (DEDUP-008). Spreading `...task` without
      // this parse would return a raw string while TypeScript reports SequenceSpec | null.
      const sequenceSpec = (() => {
        if (!task.sequenceSpec) return null;
        try {
          return SequenceSpecSchema.parse(JSON.parse(task.sequenceSpec));
        } catch {
          return null;
        }
      })();

      return {
        ...task,
        sequenceSpec,
        dependsOn,
        ...(phases !== undefined ? { phases } : {}),
      };
    },
  );

  fastify.patch<{ Params: { workspaceId: string; taskId: string } }>(
    '/workspaces/:workspaceId/tasks/:taskId',
    { preHandler: requireWorkspaceMember(db, 'collaborator') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const user = getUser(req);
      const taskId = TaskIdSchema.parse(req.params.taskId);
      const body = PatchTaskBodySchema.parse(req.body);

      const task = await db
        .select({ id: schema.tasks.id, status: schema.tasks.status })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.workspaceId, workspaceId)))
        .get();
      if (!task) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      const allowed = USER_ALLOWED_TRANSITIONS[task.status] ?? [];
      if (!allowed.includes(body.status)) {
        await reply.code(422).send({ error: 'invalid_transition', from: task.status, to: body.status });
        return;
      }

      const source = `user:${user.id}`;
      const updated = await db
        .update(schema.tasks)
        .set({ status: body.status, updatedAt: new Date() })
        .where(
          and(
            eq(schema.tasks.id, taskId),
            eq(schema.tasks.workspaceId, workspaceId),
            eq(schema.tasks.status, task.status),
          ),
        )
        .returning({ id: schema.tasks.id });

      if (updated.length === 0) {
        await reply.code(409).send({ error: 'status_changed' });
        return;
      }

      const eventName = body.status === 'cancelled' ? 'task.cancelled' : 'task.requeued';
      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId,
        eventName,
        source,
        payload: { previousStatus: task.status },
        workspaceId,
      });
      bus.emit({
        id: nanoid(),
        name: eventName,
        occurredAt: new Date(),
        source,
        payload: { taskId, workspaceId },
      });

      await reply.send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // Stale assignment detection — FM calls this to find tasks stuck in 'assigned'
  // longer than ttlMinutes (default 30). Orchestrator-only.
  // Excludes phase tasks (phase_index IS NOT NULL).
  // ---------------------------------------------------------------------------

  const StaleQuerySchema = z.object({
    ttlMinutes: z.coerce.number().int().min(1).max(1440).default(30),
  });

  fastify.get<{ Params: { workspaceId: string }; Querystring: Record<string, string> }>(
    '/workspaces/:workspaceId/tasks/stale-assigned',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      if (device.deviceType !== 'orchestrator') {
        await reply.code(403).send({ error: 'orchestrator_required' });
        return;
      }
      const { workspaceId } = req.params;
      const { ttlMinutes } = StaleQuerySchema.parse(req.query);

      const cutoff = new Date(Date.now() - ttlMinutes * 60 * 1000);

      const tasks = await db
        .select()
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.workspaceId, workspaceId),
            eq(schema.tasks.status, 'assigned'),
            lt(schema.tasks.assignedAt, cutoff),
            isNull(schema.tasks.phaseIndex),
          ),
        )
        .orderBy(asc(schema.tasks.assignedAt));

      return { tasks, ttlMinutes, cutoff };
    },
  );

  // ---------------------------------------------------------------------------
  // Bulk requeue stale assigned tasks back to pending_dispatcher_action.
  // Orchestrator-only. Writes task.requeued history event for each task.
  // Excludes phase tasks (phase_index IS NOT NULL).
  // ---------------------------------------------------------------------------

  fastify.post<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/tasks/stale-assigned/requeue',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      if (device.deviceType !== 'orchestrator') {
        await reply.code(403).send({ error: 'orchestrator_required' });
        return;
      }
      const { workspaceId } = req.params;
      const { ttlMinutes } = StaleQuerySchema.parse(req.query);

      const cutoff = new Date(Date.now() - ttlMinutes * 60 * 1000);
      const source = `device:${device.id}`;

      const stale = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.workspaceId, workspaceId),
            eq(schema.tasks.status, 'assigned'),
            lt(schema.tasks.assignedAt, cutoff),
            isNull(schema.tasks.phaseIndex),
          ),
        );

      if (stale.length === 0) {
        return { requeued: 0 };
      }

      const staleIds = stale.map((t) => t.id);

      await db
        .update(schema.tasks)
        .set({
          status: 'pending_dispatcher_action',
          assignedAgentId: null,
          assignedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(schema.tasks.id, staleIds),
            isNull(schema.tasks.phaseIndex),
          ),
        );

      const historyRows = staleIds.map((taskId) => ({
        id: nanoid(),
        taskId,
        eventName: 'task.requeued',
        source,
        payload: { reason: 'stale_assignment', ttlMinutes },
        workspaceId,
      }));
      await db.insert(schema.taskHistory).values(historyRows);

      for (const taskId of staleIds) {
        bus.emit({
          id: nanoid(),
          name: 'task.requeued',
          occurredAt: new Date(),
          source,
          payload: { taskId, workspaceId, reason: 'stale_assignment' },
        });
      }

      return { requeued: staleIds.length };
    },
  );

  // ---------------------------------------------------------------------------
  // Stale phase task recovery (DEDUP-013). Phase tasks stuck in 'assigned' after
  // their device goes offline are not covered by the plain stale-assigned requeue
  // (which filters out phase tasks). This endpoint resets them to pending_agent
  // and updates the root task's blocked_reason to 'stale_phase:<phaseIndex>'.
  // Orchestrator-only.
  // ---------------------------------------------------------------------------

  fastify.post<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/tasks/stale-phase/requeue',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      if (device.deviceType !== 'orchestrator') {
        await reply.code(403).send({ error: 'orchestrator_required' });
        return;
      }
      const { workspaceId } = req.params;
      const { ttlMinutes } = StaleQuerySchema.parse(req.query);

      const cutoff = new Date(Date.now() - ttlMinutes * 60 * 1000);
      const source = `device:${device.id}`;

      const stalePhase = await db
        .select({
          id: schema.tasks.id,
          phaseIndex: schema.tasks.phaseIndex,
          parentId: schema.tasks.parentId,
        })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.workspaceId, workspaceId),
            eq(schema.tasks.status, 'assigned'),
            isNotNull(schema.tasks.phaseIndex),
            lt(schema.tasks.assignedAt, cutoff),
          ),
        );

      if (stalePhase.length === 0) {
        return { requeued: 0 };
      }

      let requeued = 0;
      for (const phaseTask of stalePhase) {
        if (phaseTask.phaseIndex === null || phaseTask.parentId === null) continue;

        await db
          .update(schema.tasks)
          .set({ status: 'pending_agent', assignedDeviceId: null, assignedAt: null, updatedAt: new Date() })
          .where(and(eq(schema.tasks.id, phaseTask.id), eq(schema.tasks.status, 'assigned')));

        await db
          .update(schema.tasks)
          .set({ blockedReason: `stale_phase:${phaseTask.phaseIndex}`, updatedAt: new Date() })
          .where(eq(schema.tasks.id, phaseTask.parentId));

        await db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId: phaseTask.parentId,
          eventName: 'task.phase_blocked',
          source,
          payload: { phase: phaseTask.phaseIndex, reason: `stale_phase:${phaseTask.phaseIndex}` },
          workspaceId,
        });

        requeued++;
      }

      return { requeued };
    },
  );
}
