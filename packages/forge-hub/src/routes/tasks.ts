import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, desc, asc, inArray, isNull, isNotNull, lt, not, or, count, gte } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CreateTaskInputSchema,
  TaskIdSchema,
  SequenceSpecSchema,
  formatTaskId,
  formatPhaseTaskId,
  parseTaskId,
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
  dependsOn: z.array(z.string()).default([]),
});

/** Task statuses FM is allowed to route from. */
const FM_ASSIGNABLE_STATUSES = ['pending_dispatcher_action', 'pending_agent'] as const;

/** Statuses a user may cancel via the dedicated cancel endpoint.
 * Includes sequenced_running and waiting_on_deps per design doc Section 4.1. */
const CANCELLABLE_STATUSES = new Set([
  'pending_dispatcher_action',
  'pending_design',
  'design_review',
  'pending_agent',
  'assigned',
  'in_progress',
  'sequenced_running',
  'waiting_on_deps',
  'stale_assigned',
]);

/** Terminal statuses — no further transitions are possible. */
const TERMINAL_STATUSES = new Set(['completed', 'sequenced_complete', 'failed', 'cancelled']);

/** Terminal-success statuses — deps are satisfied when all deps are in one of these. */
const TERMINAL_SUCCESS_STATUSES = new Set(['completed', 'sequenced_complete']);

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
 * in a given project prefix. Excludes phase task IDs (which are compound and would
 * corrupt the counter). MUST be used in both task-creation paths.
 */
async function getMaxRootSeq(db: Db, prefix: string): Promise<number> {
  const existing = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.projectPrefix, prefix),
        isNull(schema.tasks.parentId),
      ),
    );
  let maxSeq = 0;
  for (const row of existing) {
    try {
      const { sequence } = parseTaskId(row.id);
      if (sequence > maxSeq) maxSeq = sequence;
    } catch {
      // compound phase ID or malformed — skip
    }
  }
  return maxSeq;
}

/**
 * Build the next-phase description by injecting prior-phase output in a
 * security-hardened, sandboxed format. See design doc Section 6.4.
 */
function buildNextPhaseDescription(
  nextPhasePrompt: string,
  priorResult: string,
  completingPhaseIndex: number,
): string {
  // 1. Cap the prior result
  const capped = priorResult.slice(0, 2000);

  // 2. Normalize CRLF to LF
  const normalized = capped.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 3. Strip XML tags that could escape the sandbox
  const escaped = normalized.replace(/<\/?prior_phase_output[^>]*>/gi, '[xml-tag-removed]');

  // 4. Prefix every line with '> '
  const blockquoted = escaped.split('\n').map((line) => `> ${line}`).join('\n');

  // 5. Wrap in XML-attributed tags with trust annotation
  const sandboxed = `<prior_phase_output source="phase-${completingPhaseIndex}" trust="untrusted">
${blockquoted}
</prior_phase_output>`;

  return `${nextPhasePrompt}\n\n${sandboxed}`;
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

  for (const blocked of waitingTasks) {
    let deps: string[];
    try {
      deps = z.array(z.string()).parse(JSON.parse(blocked.dependsOn));
    } catch (err) {
      console.error('[unblocking-pass] corrupt depends_on on task', blocked.id, err);
      continue;
    }

    if (deps.length === 0) {
      // No deps — unblock immediately
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

    // Check for cancelled/failed deps
    for (const [depId, depStatus] of depStatusMap.entries()) {
      if (depStatus === 'cancelled') {
        await db
          .update(schema.tasks)
          .set({ blockedReason: `dep_cancelled:${depId}`, updatedAt: new Date() })
          .where(eq(schema.tasks.id, blocked.id));
        await db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId: blocked.id,
          eventName: 'task.dep_failed',
          source: 'system',
          payload: { depId, depStatus: 'cancelled' },
          workspaceId,
        });
        break;
      }
      if (depStatus === 'failed') {
        await db
          .update(schema.tasks)
          .set({ blockedReason: `dep_failed:${depId}`, updatedAt: new Date() })
          .where(eq(schema.tasks.id, blocked.id));
        await db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId: blocked.id,
          eventName: 'task.dep_failed',
          source: 'system',
          payload: { depId, depStatus: 'failed' },
          workspaceId,
        });
        break;
      }
    }

    const allMet = deps.every((depId) => TERMINAL_SUCCESS_STATUSES.has(depStatusMap.get(depId) ?? ''));
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
 */
async function unblockSequencedTask(
  db: Db,
  rootTask: { id: string; sequenceSpec: string | null; workspaceId: string | null },
  workspaceId: string,
): Promise<void> {
  if (!rootTask.sequenceSpec) return;

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

  await db.insert(schema.tasks).values({
    id: phase0Id,
    workspaceId,
    projectPrefix: rootTask.id.replace(/-\d+$/, ''),
    title: phase0.title,
    description: phase0.prompt,
    status: 'pending_agent',
    priority: 'normal',
    parentId: rootTask.id,
    phaseIndex: 0,
    assignedAgentId: phase0.role,
    dependsOn: '[]',
    createdBy: 'system',
    createdAt: now,
    updatedAt: now,
  });

  await db
    .update(schema.tasks)
    .set({
      status: 'sequenced_running',
      blockedReason,
      updatedAt: now,
    })
    .where(eq(schema.tasks.id, rootTask.id));

  await db.insert(schema.taskHistory).values({
    id: nanoid(),
    taskId: rootTask.id,
    eventName: 'task.deps_cleared',
    source: 'system',
    payload: { phaseTaskId: phase0Id },
    workspaceId,
  });

  if (blockedReason) {
    await db.insert(schema.taskHistory).values({
      id: nanoid(),
      taskId: rootTask.id,
      eventName: 'task.phase_blocked',
      source: 'system',
      payload: { phase: 0, reason: blockedReason },
      workspaceId,
    });
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
  fastify.get<{ Querystring: { workspaceId?: string } }>('/tasks', async (req, reply) => {
    if (!req.authUser && !req.authDevice) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const { workspaceId } = req.query;
    const whereClause = workspaceId
      ? eq(schema.tasks.workspaceId, workspaceId)
      : isNull(schema.tasks.workspaceId);
    const tasks = await db
      .select()
      .from(schema.tasks)
      .where(whereClause)
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

      if (TERMINAL_STATUSES.has(task.status)) {
        await reply.code(409).send({ error: 'already_terminal', status: task.status });
        return;
      }

      if (!CANCELLABLE_STATUSES.has(task.status)) {
        await reply.code(422).send({ error: 'invalid_transition', from: task.status, to: 'cancelled' });
        return;
      }

      const previousStatus = task.status;
      const source = `user:${user.id}`;
      const now = new Date();

      // Find non-terminal phase children if this is a sequenced root
      const phaseChildren = await db
        .select({ id: schema.tasks.id, phaseIndex: schema.tasks.phaseIndex, status: schema.tasks.status })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.parentId, taskId),
            isNotNull(schema.tasks.phaseIndex),
          ),
        );

      const nonTerminalChildren = phaseChildren.filter((c) => !TERMINAL_STATUSES.has(c.status));

      const updated = await db
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

      if (updated.length === 0) {
        await reply.code(409).send({ error: 'status_changed' });
        return;
      }

      // Cancel non-terminal phase children
      for (const child of nonTerminalChildren) {
        await db
          .update(schema.tasks)
          .set({ status: 'cancelled', updatedAt: now })
          .where(
            and(
              eq(schema.tasks.id, child.id),
              not(inArray(schema.tasks.status, ['completed', 'sequenced_complete', 'failed', 'cancelled'])),
            ),
          );

        await db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId: child.id,
          eventName: 'task.phase_cancelled',
          source,
          payload: { phaseIndex: child.phaseIndex, reason: 'parent_cancelled' },
          workspaceId,
        });
      }

      // Insert stop instruction for in-progress tasks so daemon can abort
      if (previousStatus === 'in_progress') {
        await db.insert(schema.taskInstructions).values({
          id: nanoid(),
          taskId,
          workspaceId,
          priority: 'stop',
          body: body.reason
            ? `Task cancelled by user: ${body.reason}`
            : 'Task cancelled by user.',
          createdBy: source,
        });
      }

      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId,
        eventName: 'task.cancelled',
        source,
        payload: { previousStatus, reason: body.reason ?? null },
        workspaceId,
      });
      bus.emit({
        id: nanoid(),
        name: 'task.cancelled',
        occurredAt: new Date(),
        source,
        payload: { taskId, workspaceId },
      });

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

      // Fetch root task and validate it's a sequenced task
      const rootTask = await db
        .select({
          id: schema.tasks.id,
          status: schema.tasks.status,
          sequenceSpec: schema.tasks.sequenceSpec,
        })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.workspaceId, workspaceId)))
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

      const source = `user:${user.id}`;
      const now = new Date();

      await db
        .update(schema.tasks)
        .set({ status: 'pending_agent', result: null, updatedAt: now })
        .where(eq(schema.tasks.id, phaseTaskId));

      await db
        .update(schema.tasks)
        .set({ status: 'sequenced_running', blockedReason: null, updatedAt: now })
        .where(eq(schema.tasks.id, taskId));

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

      // Feature flag check for sequences
      if (body.sequenceSpec) {
        if (!process.env['FORGE_SEQUENCES_ENABLED']) {
          await reply.code(422).send({ error: 'sequences_disabled' });
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
      if (dependsOn.length > 0) {
        // Fetch all referenced dep tasks in this workspace
        const depTasks = await db
          .select({ id: schema.tasks.id, phaseIndex: schema.tasks.phaseIndex, workspaceId: schema.tasks.workspaceId, dependsOn: schema.tasks.dependsOn })
          .from(schema.tasks)
          .where(inArray(schema.tasks.id, dependsOn));

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

        // Build adjacency map for cycle detection
        const existingEdges = new Map<string, string[]>();
        for (const [, depTask] of depTaskMap.entries()) {
          try {
            const deps = z.array(z.string()).parse(JSON.parse(depTask.dependsOn));
            existingEdges.set(depTask.id, deps);
          } catch {
            existingEdges.set(depTask.id, []);
          }
        }

        // Get the new task ID to use for cycle detection (we need to compute it first)
        const maxSeqForCycle = await getMaxRootSeq(db, body.projectPrefix);
        const tentativeId = formatTaskId(body.projectPrefix, maxSeqForCycle + 1);

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

      const maxSeq = await getMaxRootSeq(db, body.projectPrefix);
      const id = formatTaskId(body.projectPrefix, maxSeq + 1);

      // Determine initial status based on deps
      const allDepsDone =
        dependsOn.length === 0 ||
        (await (async () => {
          const depStatuses = await db
            .select({ id: schema.tasks.id, status: schema.tasks.status })
            .from(schema.tasks)
            .where(inArray(schema.tasks.id, dependsOn));
          return depStatuses.every((d) => TERMINAL_SUCCESS_STATUSES.has(d.status));
        })());

      const assignedAgentId = body.assignedAgentId ?? null;
      const now = new Date();

      if (body.sequenceSpec) {
        // Sequenced task creation
        const specJson = JSON.stringify(body.sequenceSpec);
        const specHash = createHash('sha256').update(specJson).digest('hex');

        if (!allDepsDone) {
          // Task must wait for deps before phase-0 can start
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
            blockedReason: 'waiting_on_deps',
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

        // Insert root task
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

        // Insert phase-0 task
        await db.insert(schema.tasks).values({
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

        await db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId: id,
          eventName: 'task.created',
          source: createdBy,
          payload: { title: body.title, sequenced: true, phaseTaskId: phase0Id, ...maybeRunId(req) },
          workspaceId,
        });

        if (blockedReason) {
          await db.insert(schema.taskHistory).values({
            id: nanoid(),
            taskId: id,
            eventName: 'task.phase_blocked',
            source: 'system',
            payload: { phase: 0, reason: blockedReason },
            workspaceId,
          });
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
      const initialBlockedReason = !allDepsDone ? 'waiting_on_deps' : null;

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

      // Sequenced root tasks must not be completed via the flat endpoint
      if (task.sequenceSpec !== null && task.sequenceSpec !== undefined) {
        await reply.code(409).send({
          error: 'use_phase_complete',
          message: 'Phase tasks must be completed via the workspace-scoped endpoint POST /workspaces/:id/tasks/:taskId/complete',
        });
        return;
      }

      if (task.assignedDeviceId !== device.id) {
        await reply.code(403).send({ error: 'not_assigned_to_you' });
        return;
      }

      // Optimistic lock: only complete if still in_progress
      const completedRows = await db
        .update(schema.tasks)
        .set({
          status: 'completed',
          result: body.result ? body.result.slice(0, 4000) : null,
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
        payload: { result: body.result ?? null, ...maybeRunId(req) },
      });
      bus.emit({
        id: nanoid(),
        name: 'task.completed',
        occurredAt: new Date(),
        source: `device:${device.id}`,
        // Include result and workspaceId so reactive listeners (e.g. Scribe)
        // can evaluate significance without extra round-trips.
        payload: { taskId: id, result: body.result ?? null, workspaceId: task.workspaceId ?? null },
      });

      // Run dep-unblocking pass for workspace tasks waiting on this task
      if (task.workspaceId) {
        await runDepUnblockingPass(db, task.workspaceId);
      }

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

      // Auth: only the assigned device may complete this task
      if (task.assignedDeviceId !== device.id) {
        await reply.code(403).send({ error: 'device_not_assigned' });
        return;
      }

      const truncatedResult = body.result ? body.result.slice(0, 4000) : null;
      const now = new Date();

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

      const source = `device:${device.id}`;

      // Phase transition logic
      const sequencesEnabled = !!process.env['FORGE_SEQUENCES_ENABLED'];
      if (
        sequencesEnabled &&
        task.phaseIndex !== null &&
        task.phaseIndex !== undefined &&
        task.parentId !== null
      ) {
        // Fetch parent task
        const parent = await db
          .select()
          .from(schema.tasks)
          .where(eq(schema.tasks.id, task.parentId))
          .get();

        if (!parent || !parent.sequenceSpec) {
          // No parent or no sequence spec — fall through to regular completion
          await db.insert(schema.taskHistory).values({
            id: nanoid(),
            taskId,
            eventName: 'task.completed',
            source,
            payload: { result: truncatedResult, ...maybeRunId(req) },
            workspaceId,
          });
          bus.emit({
            id: nanoid(),
            name: 'task.completed',
            occurredAt: new Date(),
            source,
            payload: { taskId, result: truncatedResult, workspaceId },
          });
          await runDepUnblockingPass(db, workspaceId);
          await reply.send({ ok: true });
          return;
        }

        // Verify sequence_spec_hash integrity
        const computedHash = createHash('sha256').update(parent.sequenceSpec).digest('hex');
        if (computedHash !== parent.sequenceSpecHash) {
          await db.insert(schema.taskHistory).values({
            id: nanoid(),
            taskId: parent.id,
            eventName: 'task.sequence_integrity_failure',
            source: 'system',
            payload: { computedHash, storedHash: parent.sequenceSpecHash },
            workspaceId,
          });
          await reply.code(500).send({ error: 'sequence_integrity_failure' });
          return;
        }

        let spec: z.infer<typeof SequenceSpecSchema>;
        try {
          spec = SequenceSpecSchema.parse(JSON.parse(parent.sequenceSpec));
        } catch {
          await reply.code(500).send({ error: 'corrupt_sequence_spec' });
          return;
        }

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
            // Role unavailable — create phase task with pending_agent, update root blocked_reason
            await db.insert(schema.tasks).values({
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
            });

            await db
              .update(schema.tasks)
              .set({
                blockedReason: `role_unavailable:${nextPhase.role}`,
                updatedAt: now,
              })
              .where(eq(schema.tasks.id, parent.id));

            await db.insert(schema.taskHistory).values({
              id: nanoid(),
              taskId,
              eventName: 'task.completed',
              source,
              payload: { result: truncatedResult, phaseIndex: completingPhaseIndex, ...maybeRunId(req) },
              workspaceId,
            });

            await db.insert(schema.taskHistory).values({
              id: nanoid(),
              taskId: parent.id,
              eventName: 'task.phase_blocked',
              source: 'system',
              payload: { phase: nextPhaseIndex, reason: `role_unavailable:${nextPhase.role}` },
              workspaceId,
            });

            bus.emit({
              id: nanoid(),
              name: 'task.completed',
              occurredAt: new Date(),
              source,
              payload: { taskId, workspaceId },
            });

            await runDepUnblockingPass(db, workspaceId);
            await reply.send({ status: 'phase_blocked', reason: 'role_unavailable' });
            return;
          }

          // Insert next phase task
          await db.insert(schema.tasks).values({
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
          });

          await db
            .update(schema.tasks)
            .set({ status: 'sequenced_running', updatedAt: now })
            .where(eq(schema.tasks.id, parent.id));

          await db.insert(schema.taskHistory).values({
            id: nanoid(),
            taskId,
            eventName: 'task.completed',
            source,
            payload: { result: truncatedResult, phaseIndex: completingPhaseIndex, ...maybeRunId(req) },
            workspaceId,
          });

          await db.insert(schema.taskHistory).values({
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
          });

          bus.emit({
            id: nanoid(),
            name: 'task.completed',
            occurredAt: new Date(),
            source,
            payload: { taskId, workspaceId },
          });

          await runDepUnblockingPass(db, workspaceId);
          await reply.send({ ok: true, nextPhaseId });
          return;
        }

        // All phases done — complete the root task
        await db
          .update(schema.tasks)
          .set({
            status: 'sequenced_complete',
            result: truncatedResult,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.tasks.id, parent.id));

        await db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId,
          eventName: 'task.completed',
          source,
          payload: { result: truncatedResult, phaseIndex: completingPhaseIndex, ...maybeRunId(req) },
          workspaceId,
        });

        await db.insert(schema.taskHistory).values({
          id: nanoid(),
          taskId: parent.id,
          eventName: 'task.sequence_complete',
          source: 'system',
          payload: { result: truncatedResult },
          workspaceId,
        });

        bus.emit({
          id: nanoid(),
          name: 'task.completed',
          occurredAt: new Date(),
          source,
          payload: { taskId, workspaceId },
        });

        // Unblock tasks waiting on the root task (it just reached sequenced_complete)
        await runDepUnblockingPass(db, workspaceId);
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
      bus.emit({
        id: nanoid(),
        name: 'task.completed',
        occurredAt: new Date(),
        source,
        payload: { taskId, result: truncatedResult, workspaceId },
      });

      await runDepUnblockingPass(db, workspaceId);
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
        .select({ id: schema.tasks.id, status: schema.tasks.status, assignedDeviceId: schema.tasks.assignedDeviceId, workspaceId: schema.tasks.workspaceId })
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

          const childMap = new Map(phaseChildren.map((c) => [c.phaseIndex!, c]));

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

      const dependsOn = (() => {
        try {
          return JSON.parse(task.dependsOn) as string[];
        } catch {
          return [] as string[];
        }
      })();

      return {
        ...task,
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
}
