import type { FastifyInstance } from 'fastify';
import { and, count, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireUser, requireWorkspaceMember, getWorkspace, getUser } from '../auth/middleware.js';

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

  // ---------------------------------------------------------------------------
  // Agent performance metrics — throughput, avg completion time, failure rate.
  // Groups tasks by assignedAgentId over a rolling window (default 30 days).
  // Scoped to workspaces the authenticated user is a member of.
  // NOTE: TokenBucketStore is in-memory per-process; in multi-process deployments
  // (PM2 cluster, Kubernetes), each replica has independent state.
  // ---------------------------------------------------------------------------

  const AgentPerformanceQuerySchema = z.object({
    workspaceId: z.string().optional(),
    window: z.coerce.number().int().min(1).max(365).default(30),
  });

  fastify.get('/agents/performance', { preHandler: requireUser }, async (req, reply) => {
    const query = AgentPerformanceQuerySchema.parse(req.query);
    const windowStart = new Date(Date.now() - query.window * 24 * 60 * 60 * 1000);
    const user = getUser(req);

    // Determine which workspaces this user is a member of.
    const memberships = await db
      .select({ workspaceId: schema.workspaceMembers.workspaceId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, user.id));
    const allowedIds = memberships.map((m) => m.workspaceId);

    // If a specific workspace was requested, verify the user is a member.
    if (query.workspaceId !== undefined && !allowedIds.includes(query.workspaceId)) {
      await reply.code(403).send({ error: 'forbidden' });
      return;
    }

    // Filter tasks to the requested workspace, or to all accessible workspaces.
    const workspaceFilter =
      query.workspaceId !== undefined
        ? eq(schema.tasks.workspaceId, query.workspaceId)
        : allowedIds.length > 0
          ? inArray(schema.tasks.workspaceId, allowedIds)
          : sql`1 = 0`; // user has no workspaces — return empty

    const baseWhere = and(
      isNotNull(schema.tasks.assignedAgentId),
      gte(schema.tasks.createdAt, windowStart),
      workspaceFilter,
    );

    const rows = await db
      .select({
        agentId: schema.tasks.assignedAgentId,
        total: count(),
        completed: sql<number>`cast(sum(case when ${schema.tasks.status} = 'completed' then 1 else 0 end) as integer)`,
        failed: sql<number>`cast(sum(case when ${schema.tasks.status} = 'failed' then 1 else 0 end) as integer)`,
        inProgress: sql<number>`cast(sum(case when ${schema.tasks.status} = 'in_progress' then 1 else 0 end) as integer)`,
        avgCompletionMs: sql<number | null>`avg(case when ${schema.tasks.status} = 'completed' and ${schema.tasks.completedAt} is not null and ${schema.tasks.assignedAt} is not null then ${schema.tasks.completedAt} - ${schema.tasks.assignedAt} else null end)`,
      })
      .from(schema.tasks)
      .where(baseWhere)
      .groupBy(schema.tasks.assignedAgentId);

    const agents = rows
      .filter((r): r is typeof r & { agentId: string } => r.agentId !== null)
      .map((row) => {
        const completed = Number(row.completed ?? 0);
        const failed = Number(row.failed ?? 0);
        const terminal = completed + failed;
        const failureRate = terminal > 0 ? Math.round((failed / terminal) * 10000) / 100 : 0;
        // window is validated >= 1 by schema, no zero-check needed
        const throughputPerDay = Math.round((completed / query.window) * 100) / 100;
        const rawAvg = row.avgCompletionMs;
        const avgCompletionTimeMs =
          rawAvg !== null && rawAvg !== undefined ? Math.round(Number(rawAvg)) : null;

        return {
          agentId: row.agentId,
          completedCount: completed,
          failedCount: failed,
          inProgressCount: Number(row.inProgress ?? 0),
          totalCount: Number(row.total),
          failureRate,
          avgCompletionTimeMs,
          throughputPerDay,
        };
      })
      .sort((a, b) => b.completedCount - a.completedCount);

    return {
      agents,
      windowDays: query.window,
      generatedAt: new Date().toISOString(),
    };
  });
}
