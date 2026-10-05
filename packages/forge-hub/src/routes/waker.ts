import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';

/**
 * Constant-time check of an Authorization header against the expected bearer
 * token (security finding 4b). Both sides are reduced to SHA-256 digests first,
 * so timingSafeEqual always sees two 32-byte buffers: a length mismatch neither
 * throws nor exits early, and the comparison time does not depend on how many
 * leading characters of the presented token are correct.
 */
function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = createHash('sha256').update(header ?? '').digest();
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  return timingSafeEqual(presented, expected);
}

/**
 * Waker endpoint used by the forge-waker service to decide which daemon
 * containers to start. Returns pending task counts broken down by assigned
 * agent role so the waker only starts the containers that actually have work.
 *
 * Auth: static bearer token (FORGE_HUB_WAKER_TOKEN). Internal network only;
 * not exposed on any public-facing Traefik rule.
 *
 * Fails closed (security finding 4a): with no token configured the endpoint
 * answers 503 rather than serving unauthenticated requests. In production the
 * hub refuses to boot without a token at all (see assertWakerTokenConfigured
 * in app.ts), so the 503 path only exists in dev and test.
 */
export function registerWakerRoutes(
  fastify: FastifyInstance,
  db: Db,
  wakerToken: string | undefined,
): void {
  fastify.get('/waker/has-work', async (req, reply) => {
    if (!wakerToken) {
      await reply.code(503).send({ error: 'waker_token_not_configured' });
      return;
    }
    const auth = req.headers['authorization'];
    if (!bearerMatches(typeof auth === 'string' ? auth : undefined, wakerToken)) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
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
