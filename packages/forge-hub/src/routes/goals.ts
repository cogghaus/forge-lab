'use strict';

import type { FastifyInstance } from 'fastify';
import { and, eq, desc, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireWorkspaceMember, getUser, getWorkspace } from '../auth/middleware.js';

const CreateGoalSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  parentId: z.string().optional(),
});

const UpdateGoalSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'completed', 'cancelled']).optional(),
  parentId: z.string().nullable().optional(),
});

async function getAncestors(db: Db, goalId: string, workspaceId: string): Promise<{ id: string; title: string; parentId: string | null }[]> {
  const rows = await db.all<{ id: string; title: string; parent_id: string | null }>(sql`
    WITH RECURSIVE ancestors(id, title, parent_id) AS (
      SELECT id, title, parent_id FROM goals WHERE id = ${goalId} AND workspace_id = ${workspaceId}
      UNION ALL
      SELECT g.id, g.title, g.parent_id
      FROM goals g
      INNER JOIN ancestors a ON g.id = a.parent_id
      WHERE g.workspace_id = ${workspaceId}
    )
    SELECT id, title, parent_id FROM ancestors
  `);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    parentId: r.parent_id,
  }));
}

async function wouldCreateCycle(db: Db, goalId: string, newParentId: string, workspaceId: string): Promise<boolean> {
  const ancestors = await getAncestors(db, newParentId, workspaceId);
  return ancestors.some((a) => a.id === goalId);
}

export function registerGoalRoutes(fastify: FastifyInstance, db: Db): void {
  fastify.post<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/goals',
    { preHandler: requireWorkspaceMember(db, 'collaborator') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const body = CreateGoalSchema.parse(req.body);

      if (body.parentId) {
        const parent = await db
          .select({ id: schema.goals.id })
          .from(schema.goals)
          .where(and(eq(schema.goals.id, body.parentId), eq(schema.goals.workspaceId, workspaceId)))
          .get();
        if (!parent) {
          await reply.code(404).send({ error: 'parent_not_found' });
          return;
        }
      }

      const id = nanoid();
      const createdBy = `user:${getUser(req).id}`;
      await db.insert(schema.goals).values({
        id,
        workspaceId,
        parentId: body.parentId ?? null,
        title: body.title,
        description: body.description ?? null,
        createdBy,
      });

      await reply.code(201).send({ id });
    },
  );

  fastify.get<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/goals',
    { preHandler: requireWorkspaceMember(db) },
    async (req) => {
      const { id: workspaceId } = getWorkspace(req);
      const goals = await db
        .select()
        .from(schema.goals)
        .where(eq(schema.goals.workspaceId, workspaceId))
        .orderBy(desc(schema.goals.createdAt));
      return { goals };
    },
  );

  fastify.get<{ Params: { workspaceId: string; goalId: string } }>(
    '/workspaces/:workspaceId/goals/:goalId',
    { preHandler: requireWorkspaceMember(db) },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const { goalId } = req.params;

      const goal = await db
        .select()
        .from(schema.goals)
        .where(and(eq(schema.goals.id, goalId), eq(schema.goals.workspaceId, workspaceId)))
        .get();

      if (!goal) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      const ancestors = await getAncestors(db, goalId, workspaceId);
      return { ...goal, ancestors };
    },
  );

  fastify.get<{ Params: { workspaceId: string; goalId: string } }>(
    '/workspaces/:workspaceId/goals/:goalId/ancestors',
    { preHandler: requireWorkspaceMember(db) },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const { goalId } = req.params;

      const goal = await db
        .select({ id: schema.goals.id })
        .from(schema.goals)
        .where(and(eq(schema.goals.id, goalId), eq(schema.goals.workspaceId, workspaceId)))
        .get();

      if (!goal) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      const ancestors = await getAncestors(db, goalId, workspaceId);
      return { ancestors };
    },
  );

  fastify.patch<{ Params: { workspaceId: string; goalId: string } }>(
    '/workspaces/:workspaceId/goals/:goalId',
    { preHandler: requireWorkspaceMember(db, 'collaborator') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const { goalId } = req.params;
      const body = UpdateGoalSchema.parse(req.body);

      const goal = await db
        .select({ id: schema.goals.id })
        .from(schema.goals)
        .where(and(eq(schema.goals.id, goalId), eq(schema.goals.workspaceId, workspaceId)))
        .get();

      if (!goal) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      if (body.parentId !== undefined && body.parentId !== null) {
        if (body.parentId === goalId) {
          await reply.code(422).send({ error: 'self_parent' });
          return;
        }
      }

      let errorCode: number | null = null;
      let errorBody: { error: string } | null = null;

      await db.transaction(async (tx) => {
        if (body.parentId !== undefined && body.parentId !== null) {
          const parentInWs = await tx
            .select({ id: schema.goals.id })
            .from(schema.goals)
            .where(and(eq(schema.goals.id, body.parentId), eq(schema.goals.workspaceId, workspaceId)))
            .get();
          if (!parentInWs) {
            errorCode = 404;
            errorBody = { error: 'parent_not_found' };
            return;
          }
          const cycle = await wouldCreateCycle(tx, goalId, body.parentId, workspaceId);
          if (cycle) {
            errorCode = 422;
            errorBody = { error: 'cycle_detected' };
            return;
          }
        }

        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (body.title !== undefined) updates['title'] = body.title;
        if (body.description !== undefined) updates['description'] = body.description;
        if (body.status !== undefined) updates['status'] = body.status;
        if (body.parentId !== undefined) updates['parentId'] = body.parentId;

        const updated = await tx
          .update(schema.goals)
          .set(updates)
          .where(and(eq(schema.goals.id, goalId), eq(schema.goals.workspaceId, workspaceId)))
          .returning({ id: schema.goals.id });
        if (updated.length === 0) {
          errorCode = 404;
          errorBody = { error: 'not_found' };
        }
      });

      if (errorCode !== null) {
        await reply.code(errorCode).send(errorBody);
        return;
      }
      return { ok: true };
    },
  );
}
