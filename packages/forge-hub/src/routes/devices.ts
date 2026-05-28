import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { RegisterDeviceInputSchema, schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireUser, getUser } from '../auth/middleware.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { TokenBucketStore, createTokenBucketPreHandler } from '../rate-limit/index.js';

const RenameDeviceBodySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9-]+$/, 'Name may only contain letters, numbers, and hyphens'),
});

export interface DeviceRouteHandles {
  /** Destroy the rotate-token rate limiter on hub close. */
  destroy(): void;
}

export function registerDeviceRoutes(fastify: FastifyInstance, db: Db): DeviceRouteHandles {
  // Rate limiter per hub instance - created here so tests do not share state
  const rotateTokenLimiter = new TokenBucketStore();
  const rotateTokenRateLimit = createTokenBucketPreHandler(rotateTokenLimiter, {
    max: 5,
    windowMs: 60 * 60 * 1000,
  });
  fastify.post('/devices', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req);
    const body = RegisterDeviceInputSchema.parse(req.body);
    const id = nanoid();
    const token = generateToken();
    const tokenHash = hashToken(token);
    await db.insert(schema.devices).values({
      id,
      userId: user.id,
      name: body.name,
      hostname: body.hostname ?? null,
      platform: body.platform ?? null,
      tokenHash,
      agentId: body.agentId ?? null,
      deviceType: body.deviceType ?? 'worker',
    });
    await reply.code(201).send({ id, name: body.name, token });
  });

  fastify.get('/devices', { preHandler: requireUser }, async (req) => {
    const user = getUser(req);
    const query = req.query as Record<string, string | undefined>;
    const includeDeregistered = query['includeDeregistered'] === 'true';

    const whereClause = includeDeregistered
      ? eq(schema.devices.userId, user.id)
      : and(eq(schema.devices.userId, user.id), eq(schema.devices.status, 'active'));

    const devices = await db
      .select({
        id: schema.devices.id,
        name: schema.devices.name,
        hostname: schema.devices.hostname,
        platform: schema.devices.platform,
        lastSeen: schema.devices.lastSeen,
        createdAt: schema.devices.createdAt,
        deviceType: schema.devices.deviceType,
        agentId: schema.devices.agentId,
        status: schema.devices.status,
      })
      .from(schema.devices)
      .where(whereClause);
    return { devices };
  });

  // DELETE /devices/:deviceId - soft delete (deregister)
  fastify.delete('/devices/:deviceId', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req);
    const { deviceId } = req.params as { deviceId: string };

    const device = await db
      .select({ id: schema.devices.id, status: schema.devices.status })
      .from(schema.devices)
      .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.userId, user.id)))
      .get();

    if (!device || device.status !== 'active') {
      await reply.code(404).send({ error: 'not_found' });
      return;
    }

    await db
      .update(schema.devices)
      .set({ status: 'deregistered' })
      .where(eq(schema.devices.id, deviceId));

    await reply.code(204).send();
  });

  // PATCH /devices/:deviceId - rename
  fastify.patch('/devices/:deviceId', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req);
    const { deviceId } = req.params as { deviceId: string };

    const parsed = RenameDeviceBodySchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: 'validation_error', issues: parsed.error.issues });
      return;
    }

    const device = await db
      .select({ id: schema.devices.id })
      .from(schema.devices)
      .where(
        and(
          eq(schema.devices.id, deviceId),
          eq(schema.devices.userId, user.id),
          eq(schema.devices.status, 'active'),
        ),
      )
      .get();

    if (!device) {
      await reply.code(404).send({ error: 'not_found' });
      return;
    }

    const [updated] = await db
      .update(schema.devices)
      .set({ name: parsed.data.name })
      .where(eq(schema.devices.id, deviceId))
      .returning({
        id: schema.devices.id,
        name: schema.devices.name,
        hostname: schema.devices.hostname,
        platform: schema.devices.platform,
        deviceType: schema.devices.deviceType,
        agentId: schema.devices.agentId,
        lastSeen: schema.devices.lastSeen,
        createdAt: schema.devices.createdAt,
        status: schema.devices.status,
      });

    return updated;
  });

  // POST /devices/:deviceId/rotate-token
  fastify.post(
    '/devices/:deviceId/rotate-token',
    { preHandler: [requireUser, rotateTokenRateLimit] },
    async (req, reply) => {
      const user = getUser(req);
      const { deviceId } = req.params as { deviceId: string };

      const device = await db
        .select({ id: schema.devices.id, status: schema.devices.status })
        .from(schema.devices)
        .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.userId, user.id)))
        .get();

      if (!device) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      if (device.status === 'deregistered') {
        await reply.code(410).send({ error: 'device_deregistered' });
        return;
      }

      const newToken = generateToken();
      const newTokenHash = hashToken(newToken);

      await db
        .update(schema.devices)
        .set({ tokenHash: newTokenHash })
        .where(eq(schema.devices.id, deviceId));

      req.log.info({ deviceId, userId: user.id, event: 'token_rotated' }, 'device token rotated');

      return { token: newToken };
    },
  );

  return { destroy: () => rotateTokenLimiter.destroy() };
}
