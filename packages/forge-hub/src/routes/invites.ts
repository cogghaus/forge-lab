'use strict';

import type { FastifyInstance } from 'fastify';
import { eq, and, gt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import type { HubConfig } from '../config.js';
import { requireUser, getUser } from '../auth/middleware.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { hashPassword } from '../auth/password.js';
import { createSession } from '../auth/sessions.js';

const CreateInviteSchema = z.object({
  email: z.string().email().optional(),
  workspaceId: z.string().optional(),
  workspaceRole: z.enum(['owner', 'admin', 'collaborator', 'viewer']).optional(),
  expiresInHours: z.number().int().min(1).max(720).default(48),
});

const AcceptInviteSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

export function registerInviteRoutes(
  fastify: FastifyInstance,
  db: Db,
  config: HubConfig,
): void {
  fastify.post(
    '/admin/invites',
    { preHandler: requireUser },
    async (req, reply) => {
      const actor = getUser(req);
      if (actor.role !== 'admin') {
        await reply.code(403).send({ error: 'forbidden' });
        return;
      }

      const body = CreateInviteSchema.parse(req.body);

      if (body.workspaceId) {
        const ws = await db
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, body.workspaceId))
          .get();
        if (!ws) {
          await reply.code(404).send({ error: 'workspace_not_found' });
          return;
        }
      }

      const token = generateToken();
      const tokenHash = hashToken(token);
      const id = nanoid();
      const expiresAt = new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000);

      await db.insert(schema.invites).values({
        id,
        tokenHash,
        email: body.email ?? null,
        createdBy: actor.id,
        workspaceId: body.workspaceId ?? null,
        workspaceRole: body.workspaceRole ?? null,
        expiresAt,
      });

      await reply.code(201).send({
        id,
        token,
        email: body.email ?? null,
        expiresAt: expiresAt.getTime(),
      });
    },
  );

  fastify.get<{ Params: { token: string } }>(
    '/invites/:token',
    async (req, reply) => {
      const tokenHash = hashToken(req.params.token);
      const invite = await db
        .select()
        .from(schema.invites)
        .where(
          and(
            eq(schema.invites.tokenHash, tokenHash),
            gt(schema.invites.expiresAt, new Date()),
          ),
        )
        .get();

      if (!invite) {
        await reply.code(404).send({ error: 'invite_not_found' });
        return;
      }
      if (invite.acceptedAt) {
        await reply.code(410).send({ error: 'invite_already_accepted' });
        return;
      }

      await reply.code(200).send({
        id: invite.id,
        email: invite.email,
        workspaceId: invite.workspaceId,
        workspaceRole: invite.workspaceRole,
        expiresAt: invite.expiresAt instanceof Date ? invite.expiresAt.getTime() : invite.expiresAt,
      });
    },
  );

  fastify.post<{ Params: { token: string } }>(
    '/invites/:token/accept',
    async (req, reply) => {
      const tokenHash = hashToken(req.params.token);
      const invite = await db
        .select()
        .from(schema.invites)
        .where(
          and(
            eq(schema.invites.tokenHash, tokenHash),
            gt(schema.invites.expiresAt, new Date()),
          ),
        )
        .get();

      if (!invite) {
        await reply.code(404).send({ error: 'invite_not_found' });
        return;
      }
      if (invite.acceptedAt) {
        await reply.code(410).send({ error: 'invite_already_accepted' });
        return;
      }

      const body = AcceptInviteSchema.parse(req.body);

      if (invite.email && invite.email.toLowerCase() !== body.email.toLowerCase()) {
        await reply.code(403).send({ error: 'email_mismatch' });
        return;
      }

      const existing = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, body.email))
        .get();
      if (existing) {
        await reply.code(409).send({ error: 'email_taken' });
        return;
      }

      const userId = nanoid();
      const passwordHash = await hashPassword(body.password, config.bcryptCost);
      await db.insert(schema.users).values({
        id: userId,
        email: body.email,
        passwordHash,
        role: 'user',
      });

      if (invite.workspaceId && invite.workspaceRole) {
        await db.insert(schema.workspaceMembers).values({
          workspaceId: invite.workspaceId,
          userId,
          role: invite.workspaceRole,
        });
      }

      await db
        .update(schema.invites)
        .set({ acceptedAt: new Date(), acceptedBy: userId })
        .where(eq(schema.invites.id, invite.id));

      const session = await createSession(db, userId, config.sessionTtlHours);
      await reply
        .setCookie('session', session.token, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: config.cookieSecure,
          expires: session.expiresAt,
        })
        .code(201)
        .send({ id: userId, email: body.email, role: 'user' });
    },
  );
}
