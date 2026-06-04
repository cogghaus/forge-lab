import type { FastifyInstance } from 'fastify';
import { and, count, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireWorkspaceMember, getWorkspace, requireUser, getUser } from '../auth/middleware.js';

const VALID_ACTIONS = [
  'task:assign', 'task:claim', 'task:cancel', 'task:retry', 'task:complete', 'task:fail',
  'doc:write', 'doc:update', 'doc:supersede', 'doc:archive',
  'device:rotate-token', 'device:deregister',
  'context:read', 'workspace:list',
] as const;

const MAX_RULES_PER_WORKSPACE = 100;
const VALID_RESOURCE_TYPES = ['task', 'doc', 'device', 'workspace'] as const;

const CreatePolicyRuleSchema = z.object({
  principal: z
    .string()
    .min(1)
    .max(200)
    .regex(
      /^(agent|role|user|device):[a-zA-Z0-9*_-]+$/,
      'principal must match agent:X, role:X, user:*, or device:X',
    ),
  action: z.enum(VALID_ACTIONS),
  resourceType: z.enum(VALID_RESOURCE_TYPES).nullable().optional(),
  resourceCondition: z
    .string()
    .max(2000)
    .refine(
      (v) => { try { JSON.parse(v); return true; } catch { return false; } },
      'resourceCondition must be valid JSON',
    )
    .nullable()
    .optional(),
  effect: z.enum(['allow', 'deny']),
  priority: z.number().int().min(0).max(999).default(0),
});

export function registerPolicyRuleRoutes(fastify: FastifyInstance, db: Db): void {
  // GET /workspaces/:workspaceId/policy-rules — list active rules (workspace + global)
  fastify.get<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/policy-rules',
    { preHandler: requireWorkspaceMember(db, 'admin') },
    async (req) => {
      const { id: workspaceId } = getWorkspace(req);
      const rules = await db
        .select()
        .from(schema.policyRules)
        .where(
          and(
            isNull(schema.policyRules.archivedAt),
            eq(schema.policyRules.workspaceId, workspaceId),
          ),
        )
        .orderBy(schema.policyRules.priority);
      return { rules };
    },
  );

  // POST /workspaces/:workspaceId/policy-rules — create workspace-scoped rule
  fastify.post<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/policy-rules',
    { preHandler: requireWorkspaceMember(db, 'admin') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const body = CreatePolicyRuleSchema.parse(req.body);
      const countRows = await db
        .select({ activeCount: count() })
        .from(schema.policyRules)
        .where(and(eq(schema.policyRules.workspaceId, workspaceId), isNull(schema.policyRules.archivedAt)));
      const activeCount = countRows[0]?.activeCount ?? 0;
      if (activeCount >= MAX_RULES_PER_WORKSPACE) {
        return reply.code(422).send({ error: 'rule_limit_exceeded', max: MAX_RULES_PER_WORKSPACE });
      }
      const id = nanoid();
      await db.insert(schema.policyRules).values({
        id,
        workspaceId,
        principal: body.principal,
        action: body.action,
        resourceType: body.resourceType ?? null,
        resourceCondition: body.resourceCondition ?? null,
        effect: body.effect,
        priority: body.priority,
      });
      const rule = await db
        .select()
        .from(schema.policyRules)
        .where(eq(schema.policyRules.id, id))
        .get();
      return reply.code(201).send({ rule });
    },
  );

  // PATCH /workspaces/:workspaceId/policy-rules/:ruleId — archive rule (no DELETE)
  fastify.patch<{ Params: { workspaceId: string; ruleId: string } }>(
    '/workspaces/:workspaceId/policy-rules/:ruleId',
    { preHandler: requireWorkspaceMember(db, 'admin') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const { ruleId } = req.params;
      const body = z.object({ archived: z.literal(true) }).parse(req.body);
      void body;
      const rule = await db
        .select()
        .from(schema.policyRules)
        .where(
          and(
            eq(schema.policyRules.id, ruleId),
            eq(schema.policyRules.workspaceId, workspaceId),
          ),
        )
        .get();
      if (!rule) return reply.code(404).send({ error: 'not_found' });
      if (rule.archivedAt) return reply.code(409).send({ error: 'already_archived' });
      await db
        .update(schema.policyRules)
        .set({ archivedAt: new Date() })
        .where(eq(schema.policyRules.id, ruleId));
      return reply.code(200).send({ archived: true });
    },
  );

  // GET /policy-rules — list global rules (admin users only, owner check)
  fastify.get(
    '/policy-rules',
    { preHandler: requireUser },
    async (req, reply) => {
      const user = getUser(req);
      if (user.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
      const rules = await db
        .select()
        .from(schema.policyRules)
        .where(
          and(
            isNull(schema.policyRules.archivedAt),
            isNull(schema.policyRules.workspaceId),
          ),
        )
        .orderBy(schema.policyRules.priority);
      return { rules };
    },
  );

  // POST /policy-rules — create global rule (admin users only)
  fastify.post(
    '/policy-rules',
    { preHandler: requireUser },
    async (req, reply) => {
      const user = getUser(req);
      if (user.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
      const body = CreatePolicyRuleSchema.parse(req.body);
      const globalCountRows = await db
        .select({ activeGlobalCount: count() })
        .from(schema.policyRules)
        .where(and(isNull(schema.policyRules.workspaceId), isNull(schema.policyRules.archivedAt)));
      const activeGlobalCount = globalCountRows[0]?.activeGlobalCount ?? 0;
      if (activeGlobalCount >= MAX_RULES_PER_WORKSPACE) {
        return reply.code(422).send({ error: 'rule_limit_exceeded', max: MAX_RULES_PER_WORKSPACE });
      }
      const id = nanoid();
      await db.insert(schema.policyRules).values({
        id,
        workspaceId: null,
        principal: body.principal,
        action: body.action,
        resourceType: body.resourceType ?? null,
        resourceCondition: body.resourceCondition ?? null,
        effect: body.effect,
        priority: body.priority,
      });
      const rule = await db
        .select()
        .from(schema.policyRules)
        .where(eq(schema.policyRules.id, id))
        .get();
      return reply.code(201).send({ rule });
    },
  );

  // PATCH /policy-rules/:ruleId — archive global rule (admin users only)
  fastify.patch<{ Params: { ruleId: string } }>(
    '/policy-rules/:ruleId',
    { preHandler: requireUser },
    async (req, reply) => {
      const user = getUser(req);
      if (user.role !== 'admin') return reply.code(403).send({ error: 'admin_required' });
      const { ruleId } = req.params;
      const body = z.object({ archived: z.literal(true) }).parse(req.body);
      void body;
      const rule = await db
        .select()
        .from(schema.policyRules)
        .where(
          and(
            eq(schema.policyRules.id, ruleId),
            isNull(schema.policyRules.workspaceId),
          ),
        )
        .get();
      if (!rule) return reply.code(404).send({ error: 'not_found' });
      if (rule.archivedAt) return reply.code(409).send({ error: 'already_archived' });
      await db
        .update(schema.policyRules)
        .set({ archivedAt: new Date() })
        .where(eq(schema.policyRules.id, ruleId));
      return reply.code(200).send({ archived: true });
    },
  );
}
