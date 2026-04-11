import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { hashToken } from '../auth/tokens.js';

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
    const device = await db
      .select({ id: schema.devices.id })
      .from(schema.devices)
      .where(eq(schema.devices.tokenHash, tokenHash))
      .get();
    if (!device) {
      socket.send(JSON.stringify({ error: 'unauthorized' }));
      socket.close();
      return;
    }
    socket.send(JSON.stringify({ type: 'hello', deviceId: device.id }));
    const unsub = bus.subscribe((env) => {
      try {
        socket.send(JSON.stringify(env));
      } catch {
        // ignore
      }
    });
    socket.on('close', () => unsub());
  });
}
