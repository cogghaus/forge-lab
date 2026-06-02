import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { CreateWorkspaceInputSchema, RepoUrlSchema, RepoBranchSchema, schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { hasUniqueConstraint } from '../db/errors.js';
import { requireUser, requireDevice, requireWorkspaceMember, getUser, getWorkspace, getDevice } from '../auth/middleware.js';

const ACTIVITY_LIMIT = 50;

/** How many recent task_history rows to include in FM Tier 0 context. */
const CONTEXT_HISTORY_LIMIT = 30;
/** How many dispatcher-comment events to surface separately. */
const CONTEXT_DISPATCHER_LIMIT = 15;
/** Categories Scribe writes that FM must always have. */
const CONTEXT_DOC_CATEGORIES = ['architecture', 'adr', 'agent', 'runbook'] as const;

const UpdateWorkspaceInputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  // Pass null to clear the repo binding.
  repoUrl: RepoUrlSchema.nullable().optional(),
  repoBranch: RepoBranchSchema.nullable().optional(),
  // Archive / unarchive. Hard delete goes through DELETE (status='deleted').
  status: z.enum(['active', 'archived']).optional(),
});

const AddMemberInputSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['admin', 'collaborator', 'viewer']),
});

export function registerWorkspaceRoutes(fastify: FastifyInstance, db: Db): void {
  fastify.post('/workspaces', { preHandler: requireUser }, async (req, reply) => {
    const user = getUser(req);
    const body = CreateWorkspaceInputSchema.parse(req.body);
    const id = nanoid();
    try {
      await db.insert(schema.workspaces).values({
        id,
        name: body.name,
        slug: body.slug,
        description: body.description ?? null,
        repoUrl: body.repoUrl ?? null,
        repoBranch: body.repoBranch ?? null,
        ownerUserId: user.id,
      });
    } catch (err) {
      if (hasUniqueConstraint(err, 'workspaces.slug')) {
        await reply.code(409).send({ error: 'slug_taken' });
        return;
      }
      throw err;
    }
    await db.insert(schema.workspaceMembers).values({
      workspaceId: id,
      userId: user.id,
      role: 'owner',
    });
    await reply.code(201).send({ id });
  });

  fastify.get('/workspaces', { preHandler: requireUser }, async (req) => {
    const user = getUser(req);
    const workspaces = await db
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        slug: schema.workspaces.slug,
        description: schema.workspaces.description,
        ownerUserId: schema.workspaces.ownerUserId,
        status: schema.workspaces.status,
        budgetMonthlyCents: schema.workspaces.budgetMonthlyCents,
        createdAt: schema.workspaces.createdAt,
        updatedAt: schema.workspaces.updatedAt,
        role: schema.workspaceMembers.role,
      })
      .from(schema.workspaces)
      .innerJoin(
        schema.workspaceMembers,
        and(
          eq(schema.workspaceMembers.workspaceId, schema.workspaces.id),
          eq(schema.workspaceMembers.userId, user.id),
        ),
      )
      .where(ne(schema.workspaces.status, 'deleted'))
      .orderBy(desc(schema.workspaces.createdAt));
    return { workspaces };
  });

  fastify.get<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId',
    { preHandler: requireWorkspaceMember(db) },
    async (req) => {
      const { id, role } = getWorkspace(req);
      const workspace = await db
        .select()
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, id))
        .get();
      if (!workspace) return null;
      return { ...workspace, role };
    },
  );

  fastify.patch<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId',
    { preHandler: requireWorkspaceMember(db, 'admin') },
    async (req, reply) => {
      const { id } = getWorkspace(req);
      const body = UpdateWorkspaceInputSchema.parse(req.body);
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates['name'] = body.name;
      if (body.description !== undefined) updates['description'] = body.description;
      if (body.repoUrl !== undefined) updates['repoUrl'] = body.repoUrl;
      if (body.repoBranch !== undefined) updates['repoBranch'] = body.repoBranch;
      if (body.status !== undefined) updates['status'] = body.status;
      if (Object.keys(updates).length === 0) {
        await reply.code(400).send({ error: 'no_fields' });
        return;
      }
      updates['updatedAt'] = new Date();
      await db.update(schema.workspaces).set(updates).where(eq(schema.workspaces.id, id));
      return { ok: true };
    },
  );

  fastify.delete<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId',
    { preHandler: requireWorkspaceMember(db, 'owner') },
    async (req) => {
      const { id } = getWorkspace(req);
      await db
        .update(schema.workspaces)
        .set({ status: 'deleted', updatedAt: new Date() })
        .where(eq(schema.workspaces.id, id));
      return { ok: true };
    },
  );

  fastify.get<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/members',
    { preHandler: requireWorkspaceMember(db) },
    async (req) => {
      const { id } = getWorkspace(req);
      const members = await db
        .select()
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.workspaceId, id))
        .orderBy(asc(schema.workspaceMembers.joinedAt));
      return { members };
    },
  );

  fastify.post<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/members',
    { preHandler: requireWorkspaceMember(db, 'admin') },
    async (req, reply) => {
      const { id } = getWorkspace(req);
      const body = AddMemberInputSchema.parse(req.body);

      const targetUser = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, body.userId))
        .get();
      if (!targetUser) {
        await reply.code(404).send({ error: 'user_not_found' });
        return;
      }

      const existingMember = await db
        .select({ role: schema.workspaceMembers.role })
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, id),
            eq(schema.workspaceMembers.userId, body.userId),
          ),
        )
        .get();
      if (existingMember) {
        await reply.code(409).send({ error: 'already_member' });
        return;
      }

      await db.insert(schema.workspaceMembers).values({
        workspaceId: id,
        userId: body.userId,
        role: body.role,
      });
      await reply.code(201).send({ ok: true });
    },
  );

  // ---------------------------------------------------------------------------
  // Activity feed — last 50 task-history events scoped to this workspace
  // ---------------------------------------------------------------------------

  fastify.get<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/activity',
    { preHandler: requireWorkspaceMember(db) },
    async (req) => {
      const { id } = getWorkspace(req);
      const activity = await db
        .select({
          id: schema.taskHistory.id,
          taskId: schema.taskHistory.taskId,
          taskTitle: schema.tasks.title,
          eventName: schema.taskHistory.eventName,
          source: schema.taskHistory.source,
          payload: schema.taskHistory.payload,
          createdAt: schema.taskHistory.createdAt,
        })
        // innerJoin is safe: taskHistory.taskId has onDelete:cascade so history
        // rows are removed when tasks are deleted. Filter on taskHistory.workspaceId
        // uses the workspace index (task_history_workspace_idx).
        .from(schema.taskHistory)
        .innerJoin(schema.tasks, eq(schema.taskHistory.taskId, schema.tasks.id))
        .where(eq(schema.taskHistory.workspaceId, id))
        .orderBy(desc(schema.taskHistory.createdAt))
        .limit(ACTIVITY_LIMIT);
      return { activity };
    },
  );

  // ---------------------------------------------------------------------------
  // Dispatcher workspace enumeration — returns workspace IDs the FM device is
  // authorized to triage. Orchestrator-device-only (Heimdall workspace:list).
  // Excludes archived and deleted workspaces (active memberships only).
  // ---------------------------------------------------------------------------

  fastify.get(
    '/dispatcher/workspaces',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      if (device.deviceType !== 'orchestrator') {
        await reply.code(403).send({ error: 'orchestrator_required' });
        return;
      }
      const rows = await db
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .innerJoin(
          schema.workspaceMembers,
          and(
            eq(schema.workspaceMembers.workspaceId, schema.workspaces.id),
            eq(schema.workspaceMembers.userId, device.userId),
          ),
        )
        .where(eq(schema.workspaces.status, 'active'));
      return rows;
    },
  );

  // ---------------------------------------------------------------------------
  // FM Tier 0 context bundle — one call gives FM everything it needs to triage.
  // Device-auth-only (orchestrator type required). FM daemons call this on startup
  // and before each triage cycle.
  // ---------------------------------------------------------------------------

  fastify.get<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/context',
    { preHandler: requireDevice },
    async (req, reply) => {
      const device = getDevice(req);
      if (device.deviceType !== 'orchestrator') {
        await reply.code(403).send({ error: 'orchestrator_required' });
        return;
      }
      const workspaceId = req.params.workspaceId;

      const [
        docs,
        goals,
        agents,
        instances,
        inboxTasks,
        recentHistory,
        dispatcherHistory,
      ] = await Promise.all([
        // Active docs in the FM-critical categories
        db
          .select()
          .from(schema.workspaceDocs)
          .where(
            and(
              eq(schema.workspaceDocs.workspaceId, workspaceId),
              eq(schema.workspaceDocs.status, 'active'),
              inArray(schema.workspaceDocs.category, [...CONTEXT_DOC_CATEGORIES]),
            ),
          )
          .orderBy(asc(schema.workspaceDocs.updatedAt)),

        // Active goals
        db
          .select()
          .from(schema.goals)
          .where(
            and(
              eq(schema.goals.workspaceId, workspaceId),
              eq(schema.goals.status, 'active'),
            ),
          )
          .orderBy(asc(schema.goals.createdAt)),

        // Agents scoped to this workspace
        db
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.workspaceId, workspaceId))
          .orderBy(asc(schema.agents.name)),

        // Live agent instances (spawning | running | idle)
        db
          .select()
          .from(schema.agentInstances)
          .where(
            and(
              eq(schema.agentInstances.workspaceId, workspaceId),
              inArray(schema.agentInstances.status, ['spawning', 'running', 'idle']),
            ),
          )
          .orderBy(desc(schema.agentInstances.startedAt)),

        // FM inbox: tasks awaiting dispatcher action
        db
          .select()
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.workspaceId, workspaceId),
              eq(schema.tasks.status, 'pending_dispatcher_action'),
            ),
          )
          .orderBy(asc(schema.tasks.createdAt)),

        // Last N history events for this workspace
        db
          .select()
          .from(schema.taskHistory)
          .where(eq(schema.taskHistory.workspaceId, workspaceId))
          .orderBy(desc(schema.taskHistory.createdAt))
          .limit(CONTEXT_HISTORY_LIMIT),

        // Last N dispatcher comments — FM reads these to avoid re-deciding what it already decided.
        // Source: taskComments with authorType='dispatcher', NOT taskHistory events.
        db
          .select()
          .from(schema.taskComments)
          .where(
            and(
              eq(schema.taskComments.workspaceId, workspaceId),
              eq(schema.taskComments.authorType, 'dispatcher'),
            ),
          )
          .orderBy(desc(schema.taskComments.createdAt))
          .limit(CONTEXT_DISPATCHER_LIMIT),
      ]);

      // Queue depth: count of pending_agent tasks per assignedAgentId.
      // FM uses this for bottleneck detection (queueDepth[agentId] / liveInstances[agentId]).
      // Keyed by agentId (not by status) so FM can directly look up per-agent queue pressure.
      const pendingAgentTasks = await db
        .select({ assignedAgentId: schema.tasks.assignedAgentId })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.workspaceId, workspaceId),
            eq(schema.tasks.status, 'pending_agent'),
          ),
        );

      const queueDepth: Record<string, number> = {};
      for (const t of pendingAgentTasks) {
        const agent = t.assignedAgentId ?? 'unassigned';
        queueDepth[agent] = (queueDepth[agent] ?? 0) + 1;
      }

      return {
        workspaceId,
        docs,
        goals,
        agents,
        liveInstances: instances,
        inboxTasks,
        recentHistory,
        dispatcherHistory,
        queueDepth,
      };
    },
  );

  fastify.delete<{ Params: { workspaceId: string; userId: string } }>(
    '/workspaces/:workspaceId/members/:userId',
    { preHandler: requireWorkspaceMember(db, 'admin') },
    async (req, reply) => {
      const { id } = getWorkspace(req);
      const targetUserId = req.params.userId;

      const targetMember = await db
        .select({ role: schema.workspaceMembers.role })
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, id),
            eq(schema.workspaceMembers.userId, targetUserId),
          ),
        )
        .get();
      if (!targetMember) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (targetMember.role === 'owner') {
        await reply.code(422).send({ error: 'cannot_remove_owner' });
        return;
      }

      await db
        .delete(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, id),
            eq(schema.workspaceMembers.userId, targetUserId),
          ),
        );
      return { ok: true };
    },
  );

  // ---------------------------------------------------------------------------
  // GET /workspaces/:workspaceId/dispatcher-log
  // Returns recent dispatcher comments + inbox count for the FM triage dashboard.
  // Unlike GET /workspaces/:id/context (device-only), this endpoint accepts
  // workspace member auth so the dash can surface FM decisions without a device token.
  // ---------------------------------------------------------------------------

  const DISPATCHER_LOG_LIMIT = 50;

  fastify.get<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/dispatcher-log',
    { preHandler: requireWorkspaceMember(db) },
    async (req) => {
      const { id: workspaceId } = getWorkspace(req);

      const [comments, inboxTasks] = await Promise.all([
        // Recent dispatcher comments with task title for context
        db
          .select({
            id: schema.taskComments.id,
            taskId: schema.taskComments.taskId,
            taskTitle: schema.tasks.title,
            body: schema.taskComments.body,
            authorId: schema.taskComments.authorId,
            createdAt: schema.taskComments.createdAt,
          })
          .from(schema.taskComments)
          .innerJoin(schema.tasks, eq(schema.taskComments.taskId, schema.tasks.id))
          .where(
            and(
              eq(schema.taskComments.workspaceId, workspaceId),
              eq(schema.taskComments.authorType, 'dispatcher'),
            ),
          )
          .orderBy(desc(schema.taskComments.createdAt))
          .limit(DISPATCHER_LOG_LIMIT),

        // Count pending_dispatcher_action tasks (FM inbox size)
        db
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(
            and(
              eq(schema.tasks.workspaceId, workspaceId),
              eq(schema.tasks.status, 'pending_dispatcher_action'),
            ),
          ),
      ]);

      return { comments, inboxCount: inboxTasks.length };
    },
  );
}
