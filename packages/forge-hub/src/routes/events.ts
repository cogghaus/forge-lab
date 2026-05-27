import { eq } from 'drizzle-orm';
import { schema } from '@forge-lab/core';
import type { EventEnvelope } from '@forge-lab/core';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import type { EventBus } from '../events/bus.js';
import { requireUser, getUser } from '../auth/middleware.js';

/** SSE heartbeat interval (ms). Keeps proxies and load balancers from dropping idle connections. */
const HEARTBEAT_MS = 25_000;

/**
 * Registers the GET /events SSE endpoint.
 *
 * Clients connect with a session cookie and receive a `text/event-stream` of
 * workspace-scoped task lifecycle events. Each SSE event has the form:
 *
 *   event: task.created
 *   data: {"taskId":"...","workspaceId":"..."}
 *
 * A heartbeat comment (`: heartbeat`) is sent every 25 s so reverse proxies do
 * not close idle connections.
 *
 * **Workspace filter:**
 * - Without `?workspaceId=`, the stream delivers events for all workspaces the
 *   authenticated user is a member of.
 * - With `?workspaceId=<id>`, only events for that workspace are delivered.
 *   403 is returned if the user is not a member of that workspace.
 *
 * **Security:** Only events whose `payload.workspaceId` matches the user's
 * memberships are forwarded. Events without a workspace context (e.g. unscoped
 * task creation) are silently dropped — they carry no workspace identifier so
 * membership cannot be verified.
 *
 * **Known limitations:**
 * - Workspace membership is resolved once at connection time. If a user is
 *   added to or removed from a workspace while connected, the change takes
 *   effect on their next reconnect.
 * - No per-user connection count limit. In multi-process deployments, a
 *   connection-flooding defence belongs at the load balancer or reverse proxy
 *   layer.
 * - No explicit max-lifetime timeout. Zombie connections (socket hung but
 *   close event never fires) will accumulate EventBus listeners indefinitely.
 *   Reverse-proxy read-timeouts (e.g. nginx proxy_read_timeout) are the
 *   recommended mitigation.
 */
export function registerEventsRoutes(
  fastify: FastifyInstance,
  db: Db,
  bus: EventBus,
): void {
  fastify.get<{ Querystring: { workspaceId?: string } }>(
    '/events',
    { preHandler: requireUser },
    async (req, reply) => {
      const user = getUser(req);
      const { workspaceId: filterWorkspaceId } = req.query;

      // Build set of workspace IDs the user can access.
      const memberships = await db
        .select({ workspaceId: schema.workspaceMembers.workspaceId })
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.userId, user.id));
      const allowedIds = new Set(memberships.map((m) => m.workspaceId));

      // If the caller scoped to a specific workspace, verify membership upfront.
      if (filterWorkspaceId !== undefined && !allowedIds.has(filterWorkspaceId)) {
        await reply.code(403).send({ error: 'forbidden' });
        return;
      }

      // --- Switch to SSE mode ---
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Disable nginx/Caddy response buffering so events reach the client immediately.
        'X-Accel-Buffering': 'no',
      });
      reply.raw.flushHeaders?.();

      // Swallow write errors after the socket closes; the 'close' handler cleans up.
      reply.raw.on('error', () => { /* socket closed before write completed */ });

      function sendEvent(name: string, data: unknown): void {
        let serialized: string;
        try {
          serialized = JSON.stringify(data);
        } catch (err) {
          fastify.log.warn({ err, eventName: name }, 'SSE: could not serialize event payload — skipping');
          return;
        }
        // write() returns false when the internal buffer is full (backpressure).
        // For SSE we accept this rather than implementing full drain/pause logic:
        // slow clients will lag but not cause unbounded memory growth because the
        // EventBus listener does not buffer — it simply drops the write result.
        reply.raw.write(`event: ${name}\ndata: ${serialized}\n\n`);
      }

      // Heartbeat: prevents proxies from dropping the idle connection.
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch {
          // Socket may have closed between interval fires; cleanup handles it.
        }
      }, HEARTBEAT_MS);

      // EventBus subscription — filter by workspace membership.
      const unsubscribe = bus.subscribe((env: EventEnvelope) => {
        const payload = env.payload as Record<string, unknown>;
        const wsId = typeof payload['workspaceId'] === 'string' ? payload['workspaceId'] : null;

        // Drop events with no workspace context (cannot verify membership).
        if (wsId === null) return;
        // Drop events for workspaces the user cannot access.
        if (!allowedIds.has(wsId)) return;
        // Drop events outside the optional workspace filter.
        if (filterWorkspaceId !== undefined && wsId !== filterWorkspaceId) return;

        sendEvent(env.name, payload);
      });

      // Cleanup when the client disconnects.
      req.raw.once('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        // End the response if not already finished.
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      });

      // Hold the Fastify handler open until the client disconnects.
      await new Promise<void>((resolve) => {
        req.raw.once('close', resolve);
      });
    },
  );
}
