import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';

/**
 * Waker endpoint used by the forge-waker service to decide which daemon
 * containers to start. Returns pending task counts broken down by assigned
 * agent role so the waker only starts the containers that actually have work.
 *
 * Auth: static bearer token (FORGE_HUB_WAKER_TOKEN). Internal network only;
 * not exposed on any public-facing Traefik rule.
 */
export function registerWakerRoutes(
  fastify: FastifyInstance,
  db: Db,
  wakerToken: string | undefined,
): void {
  fastify.get('/waker/has-work', async (req, reply) => {
    // Validate waker token when configured. If no token is set the endpoint
    // remains open — acceptable for single-host deployments where the port is
    // not publicly exposed.
    if (wakerToken) {
      const auth = req.headers['authorization'];
      if (typeof auth !== 'string' || auth !== `Bearer ${wakerToken}`) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }
    }

    // Count pending tasks grouped by assigned_agent_id.
    // COALESCE(assigned_agent_id, 'forge-master') maps unrouted tasks to FM
    // since FM is responsible for dispatching anything without an assignment.
    const rows = await db.run(
      sql`SELECT COALESCE(assigned_agent_id, 'forge-master') as role, COUNT(*) as cnt
          FROM tasks
          WHERE status IN ('pending_agent', 'assigned', 'pending_dispatcher_action', 'waiting_on_deps')
          GROUP BY role`,
    );

    const byRole: Record<string, number> = {};
    let pending = 0;
    for (const row of rows.rows) {
      const role = String(row['role'] ?? 'forge-master');
      const cnt = Number(row['cnt'] ?? 0);
      byRole[role] = cnt;
      pending += cnt;
    }

    return { pending, byRole };
  });
}
