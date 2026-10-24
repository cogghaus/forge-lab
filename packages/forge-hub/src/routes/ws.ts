import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { schema, type EventEnvelope } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { hashToken } from '../auth/tokens.js';
import { authorizeUserForTask, authorizeUserForWorkspace } from '../auth/access.js';

/**
 * Whether a device's owner may see a bus event. Events carrying a workspaceId
 * need membership; events carrying only a taskId use the task's access rule
 * (flat POST /tasks emits task.created without a workspaceId). Anything else
 * cannot be attributed to a tenant and is dropped.
 */
async function ownerCanSee(db: Db, userId: string, env: EventEnvelope): Promise<boolean> {
  const payload = env.payload as Record<string, unknown>;
  const workspaceId = payload['workspaceId'];
  if (typeof workspaceId === 'string') {
    return (await authorizeUserForWorkspace(db, userId, workspaceId)) === null;
  }
  const taskId = payload['taskId'];
  if (typeof taskId !== 'string') return false;
  const task = await db
    .select({ id: schema.tasks.id, workspaceId: schema.tasks.workspaceId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .get();
  if (!task) return false;
  return (await authorizeUserForTask(db, userId, task)) === null;
}

async function isActiveDevice(db: Db, deviceId: string): Promise<boolean> {
  const row = await db
    .select({ id: schema.devices.id })
    .from(schema.devices)
    .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.status, 'active')))
    .get();
  return row !== undefined;
}

export function registerWsRoutes(fastify: FastifyInstance, db: Db, bus: EventBus): void {
  fastify.get('/ws', { websocket: true }, async (socket, req) => {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const token = url.searchParams.get('token');
    if (!token) {
      socket.send(JSON.stringify({ error: 'unauthorized' }));
      socket.close();
      return;
    }
    const tokenHash = hashToken(token);
    // Same rule as populateAuth: a deregistered device's token is dead.
    const device = await db
      .select({ id: schema.devices.id, userId: schema.devices.userId })
      .from(schema.devices)
      .where(and(eq(schema.devices.tokenHash, tokenHash), eq(schema.devices.status, 'active')))
      .get();
    if (!device) {
      socket.send(JSON.stringify({ error: 'unauthorized' }));
      socket.close();
      return;
    }
    socket.send(JSON.stringify({ type: 'hello', deviceId: device.id }));
    // Each event is checked asynchronously; chaining keeps delivery in bus order.
    // The device is re-checked per event so deregistering it ends the stream.
    let delivery: Promise<void> = Promise.resolve();
    const unsub = bus.subscribe((env) => {
      delivery = delivery
        .then(async () => {
          if (!(await isActiveDevice(db, device.id))) {
            unsub();
            socket.close();
            return;
          }
          if (await ownerCanSee(db, device.userId, env)) socket.send(JSON.stringify(env));
        })
        .catch(() => {
          // socket closed or lookup failed; drop this event
        });
    });
    socket.on('close', () => unsub());
  });
}
