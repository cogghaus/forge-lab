import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, desc, asc, inArray, isNull, lt, or, count, gte } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  CreateTaskInputSchema,
  TaskIdSchema,
  formatTaskId,
  parseTaskId,
  schema,
} from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireDevice, getDevice, requireWorkspaceMember, getWorkspace, getUser } from '../auth/middleware.js';
import type { EventBus } from '../events/bus.js';

const CompleteTaskBodySchema = z.object({
  result: z.string().optional(),
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

/** Task statuses FM is allowed to route from. */
const FM_ASSIGNABLE_STATUSES = ['pending_dispatcher_action', 'pending_agent'] as const;

const USER_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending_agent: ['cancelled'],
  pending_design: ['cancelled'],
  design_review: ['cancelled'],
  assigned: ['cancelled'],
  in_progress: ['cancelled'],
  failed: ['pending_agent'],
  cancelled: ['pending_agent'],
};

function maybeRunId(req: FastifyRequest): Record<string, string> {
  return req.runId ? { runId: req.runId } : {};
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
    const existing = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.projectPrefix, body.projectPrefix));
    let maxSeq = 0;
    for (const row of existing) {
      const { sequence } = parseTaskId(row.id);
      if (sequence > maxSeq) maxSeq = sequence;
    }
    const id = formatTaskId(body.projectPrefix, maxSeq + 1);
    const createdBy = user ? `user:${user.id}` : `device:${device!.id}`;

    await db.insert(schema.tasks).values({
      id,
      projectPrefix: body.projectPrefix,
      title: body.title,
      description: body.description ?? null,
      priority: body.priority ?? 'normal',
      goalId: body.goalId || null,
      createdBy,
    });
    await db.insert(schema.taskHistory).values({
      id: nanoid(),
      taskId: id,
      eventName: 'task.created',
      source: createdBy,
      payload: { title: body.title, ...maybeRunId(req) },
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
    const scopeFilter =
      memberWorkspaceIds.length > 0
        ? or(
            inArray(schema.tasks.workspaceId, memberWorkspaceIds),
            and(isNull(schema.tasks.workspaceId), eq(schema.tasks.createdBy, createdByKey)),
          )
        : and(isNull(schema.tasks.workspaceId), eq(schema.tasks.createdBy, createdByKey));

    // Count tasks grouped by status in a single query
    const rows = await db
      .select({ status: schema.tasks.status, n: count() })
      .from(schema.tasks)
      .where(scopeFilter)
      .groupBy(schema.tasks.status);

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byStatus[row.status] = row.n;
      total += row.n;
    }

    const completed = byStatus['completed'] ?? 0;
    const failed = byStatus['failed'] ?? 0;
    const inProgress = byStatus['in_progress'] ?? 0;
    const pending = byStatus['pending_agent'] ?? 0;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Tasks completed in the last 7 days (within scope)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentRow = await db
      .select({ n: count() })
      .from(schema.tasks)
      .where(
        and(
          scopeFilter,
          eq(schema.tasks.status, 'completed'),
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
  // FM orchestrator: assign a task to a specific agent
  // Only orchestrator-type devices may call this endpoint.
  // ---------------------------------------------------------------------------

  fastify.patch<{ Params: { workspaceId: string; taskId: string } }>(
    '/workspaces/:workspaceId/tasks/:taskId/assign',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      if (device.deviceType !== 'orchestrator') {
        await reply.code(403).send({ error: 'orchestrator_required' });
        return;
      }
      const workspaceId = req.params.workspaceId;
      const taskId = TaskIdSchema.parse(req.params.taskId);
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
    },
  );

  fastify.post<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/tasks',
    { preHandler: requireWorkspaceMember(db, 'collaborator') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const body = CreateTaskInputSchema.parse(req.body);
      const existing = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.projectPrefix, body.projectPrefix));
      let maxSeq = 0;
      for (const row of existing) {
        const { sequence } = parseTaskId(row.id);
        if (sequence > maxSeq) maxSeq = sequence;
      }
      const id = formatTaskId(body.projectPrefix, maxSeq + 1);
      const createdBy = `user:${getUser(req).id}`;
      const goalId = body.goalId || null;

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

      await db.insert(schema.tasks).values({
        id,
        projectPrefix: body.projectPrefix,
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? 'normal',
        goalId,
        workspaceId,
        createdBy,
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

  fastify.get<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/tasks',
    { preHandler: requireWorkspaceMember(db) },
    async (req) => {
      const { id: workspaceId } = getWorkspace(req);
      const tasks = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.workspaceId, workspaceId))
        .orderBy(desc(schema.tasks.createdAt));
      return { tasks };
    },
  );

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
      if (task.assignedDeviceId !== device.id) {
        await reply.code(403).send({ error: 'not_assigned_to_you' });
        return;
      }
      await db
        .update(schema.tasks)
        .set({
          status: 'completed',
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.tasks.id, id));
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
        payload: { taskId: id },
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
        .select({ id: schema.tasks.id, status: schema.tasks.status, assignedDeviceId: schema.tasks.assignedDeviceId })
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
      await reply.send({ ok: true });
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
          ),
        )
        .orderBy(asc(schema.tasks.assignedAt));

      return { tasks, ttlMinutes, cutoff };
    },
  );

  // ---------------------------------------------------------------------------
  // Bulk requeue stale assigned tasks back to pending_dispatcher_action.
  // Orchestrator-only. Writes task.requeued history event for each task.
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
        .where(inArray(schema.tasks.id, staleIds));

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
