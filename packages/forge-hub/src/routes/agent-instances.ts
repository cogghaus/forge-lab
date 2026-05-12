import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { AgentInstanceStatusSchema, schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireDevice, getDevice, requireUserOrDevice } from '../auth/middleware.js';

const TERMINAL_STATUSES = new Set(['stopped', 'crashed']);

const CreateAgentInstanceInputSchema = z.object({
  agentId: z.string().min(1),
  taskId: z.string().nullable().optional(),
  runtimeInstanceId: z.string().optional(),
  status: AgentInstanceStatusSchema.optional().default('spawning'),
});

const UpdateAgentInstanceInputSchema = z.object({
  status: AgentInstanceStatusSchema.optional(),
  taskId: z.string().nullable().optional(),
  runtimeInstanceId: z.string().nullable().optional(),
});

export function registerAgentInstanceRoutes(fastify: FastifyInstance, db: Db): void {
  // Devices create instances when they spawn an agent
  fastify.post(
    '/agent-instances',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      const body = CreateAgentInstanceInputSchema.parse(req.body);
      const agent = await db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(eq(schema.agents.id, body.agentId))
        .get();
      if (!agent) {
        await reply.code(404).send({ error: 'agent_not_found' });
        return;
      }
      const id = nanoid();
      await db.insert(schema.agentInstances).values({
        id,
        agentId: body.agentId,
        deviceId: device.id,
        taskId: body.taskId ?? null,
        runtimeInstanceId: body.runtimeInstanceId ?? null,
        status: body.status,
      });
      await reply.code(201).send({ id });
    },
  );

  // User sees all; device sees only its own
  fastify.get('/agent-instances', { preHandler: requireUserOrDevice }, async (req) => {
    if (req.authUser) {
      const instances = await db
        .select()
        .from(schema.agentInstances)
        .orderBy(schema.agentInstances.startedAt);
      return { instances };
    }
    const instances = await db
      .select()
      .from(schema.agentInstances)
      .where(eq(schema.agentInstances.deviceId, req.authDevice!.id))
      .orderBy(schema.agentInstances.startedAt);
    return { instances };
  });

  fastify.get<{ Params: { id: string } }>(
    '/agent-instances/:id',
    { preHandler: requireUserOrDevice },
    async (req, reply) => {
      const instance = await db
        .select()
        .from(schema.agentInstances)
        .where(eq(schema.agentInstances.id, req.params.id))
        .get();
      if (!instance) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (req.authUser) {
        return instance;
      }
      // Device can only see its own instances
      if (instance.deviceId !== req.authDevice!.id) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      return instance;
    },
  );

  // Device updates status of its own instance
  fastify.patch<{ Params: { id: string } }>(
    '/agent-instances/:id',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      const instance = await db
        .select()
        .from(schema.agentInstances)
        .where(eq(schema.agentInstances.id, req.params.id))
        .get();
      if (!instance) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (instance.deviceId !== device.id) {
        await reply.code(403).send({ error: 'not_your_instance' });
        return;
      }
      const body = UpdateAgentInstanceInputSchema.parse(req.body);
      if (body.status !== undefined && TERMINAL_STATUSES.has(instance.status)) {
        await reply.code(409).send({ error: 'instance_terminal' });
        return;
      }
      const updates: Partial<typeof schema.agentInstances.$inferInsert> = {};
      if (body.status !== undefined) updates.status = body.status;
      if (body.taskId !== undefined) updates.taskId = body.taskId;
      if (body.runtimeInstanceId !== undefined) updates.runtimeInstanceId = body.runtimeInstanceId;
      if (
        body.status !== undefined &&
        TERMINAL_STATUSES.has(body.status) &&
        !instance.endedAt
      ) {
        updates.endedAt = new Date();
      }
      if (Object.keys(updates).length === 0) {
        await reply.code(400).send({ error: 'no_fields' });
        return;
      }
      await db
        .update(schema.agentInstances)
        .set(updates)
        .where(eq(schema.agentInstances.id, req.params.id));
      return { ok: true };
    },
  );
}
