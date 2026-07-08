import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { RegisterDeviceInputSchema, schema } from '@forge-lab/core';
import { loadBuiltinRegistry, type PersonalityRegistry } from '@forge-lab/agents';
import type { Db } from '../db/index.js';
import { requireUser, getUser, requireDevice, getDevice } from '../auth/middleware.js';
import { generateToken, hashToken } from '../auth/tokens.js';
import { TokenBucketStore, createTokenBucketPreHandler } from '../rate-limit/index.js';
import { checkPolicy } from '../policy/engine.js';

// name is now optional (a PATCH may update agentId only); agentId is nullable
// (null clears the routing role) and optional (omit to leave it untouched).
const PatchDeviceBodySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9-]+$/, 'Name may only contain letters, numbers, and hyphens')
    .optional(),
  agentId: z.string().min(1).max(100).nullable().optional(),
});

// Built-in personalities load once from disk (markdown shipped in the image).
// Mirrors the lazy singleton in agents.ts - kept local because it is small and
// this route file should not depend on that route file's module state.
let personalityRegistry: Promise<PersonalityRegistry> | null = null;
function getPersonalityRegistry(): Promise<PersonalityRegistry> {
  return (personalityRegistry ??= loadBuiltinRegistry());
}

/**
 * Resolve an incoming device agentId to a known identifier (issue 47).
 * Claim eligibility (tasks.ts) reads this value straight off the device row,
 * so an unvalidated agentId silently makes the device unable to claim
 * anything routed to it, with no error pointing at the mismatch.
 *
 * Valid domains, mirroring the personality-name-is-canonical rule from the
 * assign-identifier fix (issue 45):
 * 1. A built-in personality id (e.g. 'architect', 'forge-master').
 * 2. A workspace-agent name in a workspace this user owns.
 * Anything else returns null; the caller replies 422 unknown_agent.
 */
async function resolveDeviceAgentId(
  db: Db,
  userId: string,
  agentId: string,
): Promise<string | null> {
  const registry = await getPersonalityRegistry();
  if (registry.get(agentId)) return agentId;

  const ownedWorkspaces = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.ownerUserId, userId));
  if (ownedWorkspaces.length === 0) return null;

  const match = await db
    .select({ name: schema.agents.name })
    .from(schema.agents)
    .where(
      and(
        inArray(schema.agents.workspaceId, ownedWorkspaces.map((w) => w.id)),
        eq(schema.agents.name, agentId),
      ),
    )
    .get();
  return match ? agentId : null;
}

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

    const deregDecision = await checkPolicy(
      { type: 'user', id: user.id },
      'device:deregister',
      { type: 'device', id: deviceId },
      { db },
    );
    if (!deregDecision.allowed) {
      await reply.code(403).send({ error: 'policy_denied', action: 'device:deregister', principal: deregDecision.principal });
      return;
    }

    await db
      .update(schema.devices)
      .set({ status: 'deregistered' })
      .where(eq(schema.devices.id, deviceId));

    await reply.code(204).send();
  });

  // PATCH /devices/:deviceId - rename and/or update agentId
  fastify.patch('/devices/:deviceId', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req);
    const { deviceId } = req.params as { deviceId: string };

    const parsed = PatchDeviceBodySchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: 'validation_error', issues: parsed.error.issues });
      return;
    }

    if (parsed.data.name === undefined && parsed.data.agentId === undefined) {
      await reply.code(400).send({ error: 'no_fields' });
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

    const updates: { name?: string; agentId?: string | null } = {};
    if (parsed.data.name !== undefined) {
      updates.name = parsed.data.name;
    }
    if (parsed.data.agentId !== undefined) {
      if (parsed.data.agentId === null) {
        updates.agentId = null;
      } else {
        const resolved = await resolveDeviceAgentId(db, user.id, parsed.data.agentId);
        if (resolved === null) {
          await reply.code(422).send({ error: 'unknown_agent', agentId: parsed.data.agentId });
          return;
        }
        updates.agentId = resolved;
      }
    }

    const [updated] = await db
      .update(schema.devices)
      .set(updates)
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

  // GET /devices/me - the authenticated device's own row. Daemons call this at
  // startup to compare FORGE_DAEMON_AGENT_ID against the registered agentId and
  // warn on mismatch (issue 47). Device-token auth only; must not be shadowed
  // by a GET /devices/:deviceId route (none exists on this method today).
  fastify.get('/devices/me', { preHandler: requireDevice }, async (req, reply) => {
    const device = getDevice(req);
    const row = await db
      .select({
        id: schema.devices.id,
        name: schema.devices.name,
        hostname: schema.devices.hostname,
        platform: schema.devices.platform,
        deviceType: schema.devices.deviceType,
        agentId: schema.devices.agentId,
        lastSeen: schema.devices.lastSeen,
        createdAt: schema.devices.createdAt,
        status: schema.devices.status,
      })
      .from(schema.devices)
      .where(eq(schema.devices.id, device.id))
      .get();

    if (!row) {
      await reply.code(404).send({ error: 'not_found' });
      return;
    }
    return row;
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

      const rotateDecision = await checkPolicy(
        { type: 'user', id: user.id },
        'device:rotate-token',
        { type: 'device', id: deviceId },
        { db },
      );
      if (!rotateDecision.allowed) {
        await reply.code(403).send({ error: 'policy_denied', action: 'device:rotate-token', principal: rotateDecision.principal });
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

  // PUT /devices/me/memory/:taskId — store agent working-memory for a task.
  // Authenticated with device token; agentId resolved from the device record.
  fastify.put<{ Params: { taskId: string } }>(
    '/devices/me/memory/:taskId',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      if (!device.agentId) {
        await reply.code(400).send({ error: 'device_has_no_agent_id' });
        return;
      }
      const { taskId } = req.params;
      const body = z.object({ content: z.string().max(1500) }).parse(req.body);

      // Resolve workspaceId from the task row (needed for the composite PK).
      const task = await db
        .select({ workspaceId: schema.tasks.workspaceId })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .get();
      if (!task) {
        await reply.code(404).send({ error: 'task_not_found' });
        return;
      }
      const workspaceId = task.workspaceId ?? '';

      await db
        .insert(schema.agentMemory)
        .values({
          agentId: device.agentId,
          taskId,
          workspaceId,
          content: body.content,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.agentMemory.agentId, schema.agentMemory.taskId, schema.agentMemory.workspaceId],
          set: { content: body.content, updatedAt: new Date() },
        });

      await reply.code(204).send();
    },
  );

  // GET /devices/me/memory/:taskId — retrieve agent working-memory for a task.
  fastify.get<{ Params: { taskId: string } }>(
    '/devices/me/memory/:taskId',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      if (!device.agentId) {
        await reply.code(400).send({ error: 'device_has_no_agent_id' });
        return;
      }
      const { taskId } = req.params;

      const task = await db
        .select({ workspaceId: schema.tasks.workspaceId })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .get();
      if (!task) {
        await reply.code(404).send({ error: 'task_not_found' });
        return;
      }
      const workspaceId = task.workspaceId ?? '';

      const row = await db
        .select({ content: schema.agentMemory.content })
        .from(schema.agentMemory)
        .where(
          and(
            eq(schema.agentMemory.agentId, device.agentId),
            eq(schema.agentMemory.taskId, taskId),
            eq(schema.agentMemory.workspaceId, workspaceId),
          ),
        )
        .get();

      if (!row) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      return { content: row.content };
    },
  );

  return { destroy: () => rotateTokenLimiter.destroy() };
}
