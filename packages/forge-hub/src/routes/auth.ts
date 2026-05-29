import type { FastifyInstance } from 'fastify';
import { eq, count } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { LoginInputSchema, schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import type { HubConfig } from '../config.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, deleteSession } from '../auth/sessions.js';
import { requireUser, getUser } from '../auth/middleware.js';
import { TokenBucketStore, createTokenBucketPreHandler } from '../rate-limit/index.js';

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

const ChangeEmailSchema = z.object({
  newEmail: z.string().email(),
});

const RegisterInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

/** Requests per minute cap applied to login and register. */
const AUTH_RATE_LIMIT_MAX = 10;
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;

export function registerAuthRoutes(
  fastify: FastifyInstance,
  db: Db,
  config: HubConfig,
  rateLimitStore?: TokenBucketStore,
): void {
  const authPreHandlers = rateLimitStore
    ? [createTokenBucketPreHandler(rateLimitStore, { max: AUTH_RATE_LIMIT_MAX, windowMs: AUTH_RATE_LIMIT_WINDOW_MS })]
    : [];

  fastify.post('/auth/register', { preHandler: authPreHandlers }, async (req, reply) => {
    const body = RegisterInputSchema.parse(req.body);
    const existing = await db.select({ c: count() }).from(schema.users).get();
    const isFirst = !existing || existing.c === 0;
    if (!isFirst) {
      await reply.code(403).send({ error: 'registration_disabled' });
      return;
    }
    const id = nanoid();
    const passwordHash = await hashPassword(body.password, config.bcryptCost);
    await db.insert(schema.users).values({
      id,
      email: body.email,
      passwordHash,
      role: 'admin',
    });
    await reply.code(201).send({ id, email: body.email, role: 'admin' });
  });

  fastify.post('/auth/login', { preHandler: authPreHandlers }, async (req, reply) => {
    const body = LoginInputSchema.parse(req.body);
    const user = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, body.email))
      .get();
    if (!user) {
      await reply.code(401).send({ error: 'invalid_credentials' });
      return;
    }
    const ok = await verifyPassword(body.password, user.passwordHash);
    if (!ok) {
      await reply.code(401).send({ error: 'invalid_credentials' });
      return;
    }
    const session = await createSession(db, user.id, config.sessionTtlHours);
    await reply
      .setCookie('session', session.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        expires: session.expiresAt,
      })
      .code(200)
      .send({ id: user.id, email: user.email, role: user.role });
  });

  fastify.get('/auth/me', { preHandler: requireUser }, async (req) => {
    const user = getUser(req);
    // Re-fetch from DB so role is always fresh (authUser is set at request start)
    const row = await db
      .select({ id: schema.users.id, email: schema.users.email, role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .get();
    return row ?? { id: user.id, email: user.email, role: user.role };
  });

  fastify.patch('/auth/password', { preHandler: [...authPreHandlers, requireUser] }, async (req, reply) => {
    const body = ChangePasswordSchema.parse(req.body);
    const user = getUser(req);
    const row = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .get();
    if (!row) {
      await reply.code(401).send({ error: 'invalid_password' });
      return;
    }
    const ok = await verifyPassword(body.currentPassword, row.passwordHash);
    if (!ok) {
      await reply.code(401).send({ error: 'invalid_password' });
      return;
    }
    const newHash = await hashPassword(body.newPassword, config.bcryptCost);
    await db.update(schema.users).set({ passwordHash: newHash }).where(eq(schema.users.id, user.id));
    await reply.code(200).send({ ok: true });
  });

  fastify.patch('/auth/email', { preHandler: [...authPreHandlers, requireUser] }, async (req, reply) => {
    const body = ChangeEmailSchema.parse(req.body);
    const user = getUser(req);
    const existing = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, body.newEmail))
      .get();
    if (existing) {
      await reply.code(409).send({ error: 'email_taken' });
      return;
    }
    await db.update(schema.users).set({ email: body.newEmail }).where(eq(schema.users.id, user.id));
    await reply.code(200).send({ ok: true });
  });

  fastify.post('/auth/logout', async (req, reply) => {
    const cookies = (req as unknown as { cookies?: Record<string, string | undefined> }).cookies;
    const token = cookies?.['session'];
    if (token) await deleteSession(db, token);
    await reply.clearCookie('session', { path: '/' }).code(200).send({ ok: true });
  });
}
