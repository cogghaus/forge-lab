import type { FastifyInstance } from 'fastify';
import { and, count, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireWorkspaceMember, getWorkspace } from '../auth/middleware.js';
import { parseDateRange } from '../utils/date-range.js';

const OverviewQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

export function registerAnalyticsRoutes(fastify: FastifyInstance, db: Db): void {
  /**
   * GET /workspaces/:workspaceId/analytics/overview
   *
   * Returns workspace task stats, optionally scoped to a date range.
   *
   * Query params:
   *   from  - ISO 8601 start of range (inclusive)
   *   to    - ISO 8601 end of range (inclusive, defaults to now when from is given)
   *
   * Both omitted -> all-time stats.
   */
  fastify.get<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/analytics/overview',
    { preHandler: requireWorkspaceMember(db) },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const q = OverviewQuerySchema.parse(req.query);

      const range = parseDateRange(q.from, q.to);
      if (!range.ok) {
        await reply.code(400).send({ error: range.error });
        return;
      }

      const dateFilter =
        range.fromMs !== undefined && range.toMs !== undefined
          ? and(
              gte(schema.tasks.createdAt, new Date(range.fromMs)),
              lte(schema.tasks.createdAt, new Date(range.toMs)),
            )
          : undefined;

      const baseWhere = and(eq(schema.tasks.workspaceId, workspaceId), dateFilter);

      const row = await db
        .select({
          total: count(),
          completed: sql<number>`cast(sum(case when ${schema.tasks.status} = 'completed' then 1 else 0 end) as integer)`,
          failed: sql<number>`cast(sum(case when ${schema.tasks.status} = 'failed' then 1 else 0 end) as integer)`,
          inProgress: sql<number>`cast(sum(case when ${schema.tasks.status} = 'in_progress' then 1 else 0 end) as integer)`,
          pending: sql<number>`cast(sum(case when ${schema.tasks.status} in (
            'pending_dispatcher_action', 'pending_design', 'design_review', 'pending_agent', 'assigned'
          ) then 1 else 0 end) as integer)`,
          avgCompletionMs: sql<number | null>`avg(
            case when ${schema.tasks.status} = 'completed'
              and ${schema.tasks.completedAt} is not null
              and ${schema.tasks.assignedAt} is not null
            then ${schema.tasks.completedAt} - ${schema.tasks.assignedAt}
            else null end
          )`,
        })
        .from(schema.tasks)
        .where(baseWhere)
        .get();

      const total = Number(row?.total ?? 0);
      const completed = Number(row?.completed ?? 0);
      const failed = Number(row?.failed ?? 0);
      const inProgress = Number(row?.inProgress ?? 0);
      const pending = Number(row?.pending ?? 0);
      const completionRate = total > 0 ? Math.round((completed / total) * 1000) / 1000 : 0;
      const rawAvg = row?.avgCompletionMs;
      const avgCompletionTimeMs =
        rawAvg !== null && rawAvg !== undefined ? Math.round(Number(rawAvg)) : null;

      return {
        totalTasks: total,
        completedTasks: completed,
        failedTasks: failed,
        pendingTasks: pending,
        inProgressTasks: inProgress,
        completionRate,
        avgCompletionTimeMs,
        period: {
          from: range.fromStr ?? null,
          to: range.toStr ?? null,
        },
      };
    },
  );
}
