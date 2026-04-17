import type { FastifyInstance } from 'fastify';
import { eq, and, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { TaskIdSchema, schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireUserOrDevice } from '../auth/middleware.js';

const CreateCommentInputSchema = z.object({
  body: z.string().min(1).max(50_000),
  // Devices may optionally attribute the comment to an agent or the dispatcher
  authorType: z.enum(['agent', 'dispatcher', 'system']).optional(),
  authorId: z.string().optional(),
});

async function getTask(db: Db, taskId: string) {
  return db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get();
}

export function registerCommentRoutes(fastify: FastifyInstance, db: Db): void {
  // User or device can list comments for a task
  fastify.get<{ Params: { taskId: string } }>(
    '/tasks/:taskId/comments',
    { preHandler: requireUserOrDevice },
    async (req, reply) => {
      const parsedId = TaskIdSchema.safeParse(req.params.taskId);
      if (!parsedId.success) {
        await reply.code(400).send({ error: 'invalid_task_id' });
        return;
      }
      const taskId = parsedId.data;
      const task = await getTask(db, taskId);
      if (!task) {
        await reply.code(404).send({ error: 'task_not_found' });
        return;
      }
      const comments = await db
        .select()
        .from(schema.taskComments)
        .where(eq(schema.taskComments.taskId, taskId))
        .orderBy(asc(schema.taskComments.createdAt));
      return { comments };
    },
  );

  // User or device can post a comment
  fastify.post<{ Params: { taskId: string } }>(
    '/tasks/:taskId/comments',
    { preHandler: requireUserOrDevice },
    async (req, reply) => {
      const parsedId = TaskIdSchema.safeParse(req.params.taskId);
      if (!parsedId.success) {
        await reply.code(400).send({ error: 'invalid_task_id' });
        return;
      }
      const taskId = parsedId.data;
      const task = await getTask(db, taskId);
      if (!task) {
        await reply.code(404).send({ error: 'task_not_found' });
        return;
      }
      const input = CreateCommentInputSchema.parse(req.body);
      const id = nanoid();

      let authorType: 'user' | 'agent' | 'dispatcher' | 'system';
      let authorId: string;

      if (req.authUser) {
        authorType = 'user';
        authorId = req.authUser.id;
      } else {
        // Device auth — validate authorId if it differs from the device's own ID
        const device = req.authDevice!;
        const providedAuthorId = input.authorId;
        if (providedAuthorId && providedAuthorId !== device.id) {
          const instance = await db
            .select({ id: schema.agentInstances.id })
            .from(schema.agentInstances)
            .where(
              and(
                eq(schema.agentInstances.id, providedAuthorId),
                eq(schema.agentInstances.deviceId, device.id),
              ),
            )
            .get();
          if (!instance) {
            await reply.code(403).send({ error: 'invalid_author_id' });
            return;
          }
        }
        authorType = input.authorType ?? 'system';
        authorId = providedAuthorId ?? device.id;
      }

      await db.insert(schema.taskComments).values({
        id,
        taskId,
        authorType,
        authorId,
        body: input.body,
      });
      await reply.code(201).send({ id });
    },
  );
}
