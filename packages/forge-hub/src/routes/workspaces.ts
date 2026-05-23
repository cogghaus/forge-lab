import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { CreateWorkspaceInputSchema, schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireUser, requireWorkspaceMember, getUser, getWorkspace } from '../auth/middleware.js';

const UpdateWorkspaceInputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
});

const AddMemberInputSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['admin', 'collaborator', 'viewer']),
});

export function registerWorkspaceRoutes(fastify: FastifyInstance, db: Db): void {
  fastify.post('/workspaces', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req);
    const body = CreateWorkspaceInputSchema.parse(req.body);
    const id = nanoid();
    try {
      await db.insert(schema.workspaces).values({
        id,
        name: body.name,
        slug: body.slug,
        description: body.description ?? null,
        ownerUserId: user.id,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed: workspaces.slug')) {
        await reply.code(409).send({ error: 'slug_taken' });
        return;
      }
      throw err;
    }
    await db.insert(schema.workspaceMembers).values({
      workspaceId: id,
      userId: user.id,
      role: 'owner',
    });
    await reply.code(201).send({ id });
  });

  fastify.get('/workspaces', { preHandler: requireUser }, async (req) => {
    const user = getUser(req);
    const workspaces = await db
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        slug: schema.workspaces.slug,
        description: schema.workspaces.description,
        ownerUserId: schema.workspaces.ownerUserId,
        status: schema.workspaces.status,
        budgetMonthlyCents: schema.workspaces.budgetMonthlyCents,
        createdAt: schema.workspaces.createdAt,
        updatedAt: schema.workspaces.updatedAt,
        role: schema.workspaceMembers.role,
      })
      .from(schema.workspaces)
      .innerJoin(
        schema.workspaceMembers,
        and(
          eq(schema.workspaceMembers.workspaceId, schema.workspaces.id),
          eq(schema.workspaceMembers.userId, user.id),
        ),
      )
      .where(ne(schema.workspaces.status, 'deleted'))
      .orderBy(desc(schema.workspaces.createdAt));
    return { workspaces };
  });

  fastify.get<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId',
    { preHandler: requireWorkspaceMember(db) },
    async (req) => {
      const { id } = getWorkspace(req);
      const workspace = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, id))
        .get();
      return workspace;
    },
  );

  fastify.patch<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId',
    { preHandler: requireWorkspaceMember(db, 'admin') },
    async (req, reply) => {
      const { id } = getWorkspace(req);
      const body = UpdateWorkspaceInputSchema.parse(req.body);
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates['name'] = body.name;
      if (body.description !== undefined) updates['description'] = body.description;
      if (Object.keys(updates).length === 0) {
        await reply.code(400).send({ error: 'no_fields' });
        return;
      }
      updates['updatedAt'] = new Date();
      await db.update(schema.workspaces).set(updates).where(eq(schema.workspaces.id, id));
      return { ok: true };
    },
  );

  fastify.delete<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId',
    { preHandler: requireWorkspaceMember(db, 'owner') },
    async (req) => {
      const { id } = getWorkspace(req);
      await db
        .update(schema.workspaces)
        .set({ status: 'deleted', updatedAt: new Date() })
        .where(eq(schema.workspaces.id, id));
      return { ok: true };
    },
  );

  fastify.get<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/members',
    { preHandler: requireWorkspaceMember(db) },
    async (req) => {
      const { id } = getWorkspace(req);
      const members = await db
        .select()
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.workspaceId, id))
        .orderBy(asc(schema.workspaceMembers.joinedAt));
      return { members };
    },
  );

  fastify.post<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/members',
    { preHandler: requireWorkspaceMember(db, 'admin') },
    async (req, reply) => {
      const { id } = getWorkspace(req);
      const body = AddMemberInputSchema.parse(req.body);

      const targetUser = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, body.userId))
        .get();
      if (!targetUser) {
        await reply.code(404).send({ error: 'user_not_found' });
        return;
      }

      const existingMember = await db
        .select({ role: schema.workspaceMembers.role })
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, id),
            eq(schema.workspaceMembers.userId, body.userId),
          ),
        )
        .get();
      if (existingMember) {
        await reply.code(409).send({ error: 'already_member' });
        return;
      }

      await db.insert(schema.workspaceMembers).values({
        workspaceId: id,
        userId: body.userId,
        role: body.role,
      });
      await reply.code(201).send({ ok: true });
    },
  );

  fastify.delete<{ Params: { workspaceId: string; userId: string } }>(
    '/workspaces/:workspaceId/members/:userId',
    { preHandler: requireWorkspaceMember(db, 'admin') },
    async (req, reply) => {
      const { id } = getWorkspace(req);
      const targetUserId = req.params.userId;

      const targetMember = await db
        .select({ role: schema.workspaceMembers.role })
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, id),
            eq(schema.workspaceMembers.userId, targetUserId),
          ),
        )
        .get();
      if (!targetMember) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (targetMember.role === 'owner') {
        await reply.code(422).send({ error: 'cannot_remove_owner' });
        return;
      }

      await db
        .delete(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, id),
            eq(schema.workspaceMembers.userId, targetUserId),
          ),
        );
      return { ok: true };
    },
  );
}
