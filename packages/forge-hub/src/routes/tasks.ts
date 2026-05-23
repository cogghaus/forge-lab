import type { FastifyInstance } from 'fastify';
import { and, eq, desc, asc, inArray, isNull, or } from 'drizzle-orm';
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
import { requireDevice, getDevice, requireWorkspaceMember, getWorkspace } from '../auth/middleware.js';
import type { EventBus } from '../events/bus.js';

const CompleteTaskBodySchema = z.object({
  result: z.string().optional(),
});

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
      createdBy,
    });
    await db.insert(schema.taskHistory).values({
      id: nanoid(),
      taskId: id,
      eventName: 'task.created',
      source: createdBy,
      payload: { title: body.title },
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
        payload: { deviceId: device.id },
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
      const createdBy = `user:${req.authUser!.id}`;
      await db.insert(schema.tasks).values({
        id,
        projectPrefix: body.projectPrefix,
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? 'normal',
        workspaceId,
        createdBy,
      });
      await db.insert(schema.taskHistory).values({
        id: nanoid(),
        taskId: id,
        eventName: 'task.created',
        source: createdBy,
        payload: { title: body.title },
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
        payload: { result: body.result ?? null },
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
}
