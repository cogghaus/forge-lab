import type { FastifyInstance } from 'fastify';
import { eq, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { TaskIdSchema, schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireUser, getUser, requireUserOrDevice } from '../auth/middleware.js';

const CreateInstructionInputSchema = z.object({
  priority: z.enum(['redirect', 'stop']),
  body: z.string().min(1).max(50_000),
});

async function getTask(db: Db, taskId: string) {
  return db
    .select({ id: schema.tasks.id, assignedDeviceId: schema.tasks.assignedDeviceId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get();
}

export function registerInstructionRoutes(fastify: FastifyInstance, db: Db): void {
  // User or device can list instructions for a task
  fastify.get<{ Params: { taskId: string } }>(
    '/tasks/:taskId/instructions',
    { preHandler: requireUserOrDevice },
    async (req, reply) => {
      const parsed = TaskIdSchema.safeParse(req.params.taskId);
      if (!parsed.success) {
        await reply.code(400).send({ error: 'invalid_task_id' });
        return;
      }
      const taskId = parsed.data;
      const task = await getTask(db, taskId);
      if (!task) {
        await reply.code(404).send({ error: 'task_not_found' });
        return;
      }
      if (
        !req.authUser &&
        req.authDevice &&
        task.assignedDeviceId !== null &&
        task.assignedDeviceId !== req.authDevice.id
      ) {
        await reply.code(403).send({ error: 'forbidden' });
        return;
      }
      const instructions = await db
        .select()
        .from(schema.taskInstructions)
        .where(eq(schema.taskInstructions.taskId, taskId))
        .orderBy(asc(schema.taskInstructions.createdAt));
      return { instructions };
    },
  );

  // Only users can create instructions
  fastify.post<{ Params: { taskId: string } }>(
    '/tasks/:taskId/instructions',
    { preHandler: requireUser },
    async (req, reply) => {
      const user = getUser(req);
      const parsed = TaskIdSchema.safeParse(req.params.taskId);
      if (!parsed.success) {
        await reply.code(400).send({ error: 'invalid_task_id' });
        return;
      }
      const taskId = parsed.data;
      const task = await getTask(db, taskId);
      if (!task) {
        await reply.code(404).send({ error: 'task_not_found' });
        return;
      }
      const body = CreateInstructionInputSchema.parse(req.body);
      const id = nanoid();
      await db.insert(schema.taskInstructions).values({
        id,
        taskId,
        priority: body.priority,
        body: body.body,
        createdBy: `user:${user.id}`,
      });
      await reply.code(201).send({ id });
    },
  );

  // Device or user acknowledges an instruction (idempotent)
  fastify.post<{ Params: { taskId: string; instrId: string } }>(
    '/tasks/:taskId/instructions/:instrId/ack',
    { preHandler: requireUserOrDevice },
    async (req, reply) => {
      const parsedAck = TaskIdSchema.safeParse(req.params.taskId);
      if (!parsedAck.success) {
        await reply.code(400).send({ error: 'invalid_task_id' });
        return;
      }
      const taskId = parsedAck.data;
      const task = await getTask(db, taskId);
      if (!task) {
        await reply.code(404).send({ error: 'task_not_found' });
        return;
      }
      if (
        !req.authUser &&
        req.authDevice &&
        task.assignedDeviceId !== null &&
        task.assignedDeviceId !== req.authDevice.id
      ) {
        await reply.code(403).send({ error: 'forbidden' });
        return;
      }
      const instr = await db
        .select()
        .from(schema.taskInstructions)
        .where(eq(schema.taskInstructions.id, req.params.instrId))
        .get();
      if (!instr || instr.taskId !== taskId) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (instr.acknowledgedAt) {
        return { ok: true };
      }
      await db
        .update(schema.taskInstructions)
        .set({ acknowledgedAt: new Date() })
        .where(eq(schema.taskInstructions.id, req.params.instrId));
      return { ok: true };
    },
  );
}
