import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireUser, getUser } from '../auth/middleware.js';

const CreateRuntimeConfigInputSchema = z.object({
  runtimeId: z.string().min(1),
  name: z.string().min(1).max(100),
  config: z.record(z.string(), z.unknown()),
});

const UpdateRuntimeConfigInputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export function registerRuntimeConfigRoutes(fastify: FastifyInstance, db: Db): void {
  fastify.get('/runtime-configs', { preHandler: requireUser }, async (req) => {
    const user = getUser(req);
    const configs = await db
      .select()
      .from(schema.runtimeConfigs)
      .where(eq(schema.runtimeConfigs.userId, user.id))
      .orderBy(schema.runtimeConfigs.createdAt);
    return { configs };
  });

  fastify.post('/runtime-configs', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req);
    const body = CreateRuntimeConfigInputSchema.parse(req.body);
    const id = nanoid();
    await db.insert(schema.runtimeConfigs).values({
      id,
      userId: user.id,
      runtimeId: body.runtimeId,
      name: body.name,
      config: body.config,
    });
    await reply.code(201).send({ id });
  });

  fastify.get<{ Params: { id: string } }>(
    '/runtime-configs/:id',
    { preHandler: requireUser },
    async (req, reply) => {
      const user = getUser(req);
      const config = await db
        .select()
        .from(schema.runtimeConfigs)
        .where(
          and(
            eq(schema.runtimeConfigs.id, req.params.id),
            eq(schema.runtimeConfigs.userId, user.id),
          ),
        )
        .get();
      if (!config) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      return config;
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/runtime-configs/:id',
    { preHandler: requireUser },
    async (req, reply) => {
      const user = getUser(req);
      const config = await db
        .select()
        .from(schema.runtimeConfigs)
        .where(
          and(
            eq(schema.runtimeConfigs.id, req.params.id),
            eq(schema.runtimeConfigs.userId, user.id),
          ),
        )
        .get();
      if (!config) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      const body = UpdateRuntimeConfigInputSchema.parse(req.body);
      const updates = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.config !== undefined && { config: body.config }),
      };
      if (Object.keys(updates).length === 0) {
        await reply.code(400).send({ error: 'no_fields' });
        return;
      }
      await db
        .update(schema.runtimeConfigs)
        .set(updates)
        .where(
          and(
            eq(schema.runtimeConfigs.id, req.params.id),
            eq(schema.runtimeConfigs.userId, user.id),
          ),
        );
      return { ok: true };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/runtime-configs/:id',
    { preHandler: requireUser },
    async (req, reply) => {
      const user = getUser(req);
      const config = await db
        .select()
        .from(schema.runtimeConfigs)
        .where(
          and(
            eq(schema.runtimeConfigs.id, req.params.id),
            eq(schema.runtimeConfigs.userId, user.id),
          ),
        )
        .get();
      if (!config) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      await db
        .delete(schema.runtimeConfigs)
        .where(
          and(
            eq(schema.runtimeConfigs.id, req.params.id),
            eq(schema.runtimeConfigs.userId, user.id),
          ),
        );
      return { ok: true };
    },
  );
}
