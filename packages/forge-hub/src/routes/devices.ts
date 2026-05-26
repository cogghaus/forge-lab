import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { RegisterDeviceInputSchema, schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireUser, getUser } from '../auth/middleware.js';
import { generateToken, hashToken } from '../auth/tokens.js';

export function registerDeviceRoutes(fastify: FastifyInstance, db: Db): void {
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
      })
      .from(schema.devices)
      .where(eq(schema.devices.userId, user.id));
    return { devices };
  });
}
