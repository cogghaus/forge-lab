import type { FastifyInstance } from 'fastify';
import { eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireUser, requireWorkspaceMember, getWorkspace } from '../auth/middleware.js';

const CreateAgentInputSchema = z.object({
  name: z.string().min(1).max(100),
  personality: z.string().min(1).max(10_000),
  runtimeId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

const UpdateAgentInputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  personality: z.string().min(1).max(10_000).optional(),
  runtimeId: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export function registerAgentRoutes(fastify: FastifyInstance, db: Db): void {
  fastify.get('/agents', { preHandler: requireUser }, async () => {
    const agents = await db
      .select()
      .from(schema.agents)
      .where(isNull(schema.agents.workspaceId))
      .orderBy(schema.agents.createdAt);
    return { agents };
  });

  fastify.post('/agents', { preHandler: requireUser }, async (req, reply) => {
    const body = CreateAgentInputSchema.parse(req.body);
    const id = nanoid();
    await db.insert(schema.agents).values({
      id,
      name: body.name,
      personality: body.personality,
      runtimeId: body.runtimeId,
      config: body.config ?? {},
    });
    await reply.code(201).send({ id });
  });

  fastify.get<{ Params: { id: string } }>(
    '/agents/:id',
    { preHandler: requireUser },
    async (req, reply) => {
      const agent = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, req.params.id))
        .get();
      if (!agent) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      return agent;
    },
  );

  fastify.patch<{ Params: { id: string } }>(
    '/agents/:id',
    { preHandler: requireUser },
    async (req, reply) => {
      const agent = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, req.params.id))
        .get();
      if (!agent) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      const body = UpdateAgentInputSchema.parse(req.body);
      const updates = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.personality !== undefined && { personality: body.personality }),
        ...(body.runtimeId !== undefined && { runtimeId: body.runtimeId }),
        ...(body.config !== undefined && { config: body.config }),
      };
      if (Object.keys(updates).length === 0) {
        await reply.code(400).send({ error: 'no_fields' });
        return;
      }
      await db.update(schema.agents).set(updates).where(eq(schema.agents.id, req.params.id));
      return { ok: true };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/agents/:id',
    { preHandler: requireUser },
    async (req, reply) => {
      const agent = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, req.params.id))
        .get();
      if (!agent) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      await db.delete(schema.agents).where(eq(schema.agents.id, req.params.id));
      return { ok: true };
    },
  );

  fastify.post<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/agents',
    { preHandler: requireWorkspaceMember(db, 'collaborator') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const body = CreateAgentInputSchema.parse(req.body);
      const id = nanoid();
      await db.insert(schema.agents).values({
        id,
        name: body.name,
        personality: body.personality,
        runtimeId: body.runtimeId,
        config: body.config ?? {},
        workspaceId,
      });
      await reply.code(201).send({ id });
    },
  );

  fastify.get<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/agents',
    { preHandler: requireWorkspaceMember(db) },
    async (req) => {
      const { id: workspaceId } = getWorkspace(req);
      const agents = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.workspaceId, workspaceId))
        .orderBy(schema.agents.createdAt);
      return { agents };
    },
  );
}
