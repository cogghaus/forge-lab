import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { hasUniqueConstraint } from '../db/errors.js';
import { getDevice } from '../auth/middleware.js';
import { checkPolicy } from '../policy/engine.js';
import { buildDevicePrincipal } from '../policy/principals.js';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const DOC_CATEGORIES = ['architecture', 'api', 'pattern', 'adr', 'agent', 'feature', 'runbook'] as const;
const DOC_STATUSES = ['active', 'archived', 'superseded'] as const;

const CreateDocBodySchema = z.object({
  key: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/, 'key must be lowercase alphanumeric with hyphens'),
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  category: z.enum(DOC_CATEGORIES),
});

const PatchDocBodySchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    content: z.string().min(1).optional(),
    status: z.enum(DOC_STATUSES).optional(),
    supersededById: z.string().min(1).optional(),
    supersededReason: z.string().min(1).optional(),
  })
  .refine(
    (v) => {
      // If status=superseded, supersededReason is required
      if (v.status === 'superseded' && !v.supersededReason) return false;
      return true;
    },
    { message: 'supersededReason is required when status is superseded' },
  );

const ListDocsQuerySchema = z.object({
  category: z.enum(DOC_CATEGORIES).optional(),
  // When omitted, defaults to 'active'. Pass status=all to return docs of any status.
  status: z.enum([...DOC_STATUSES, 'all'] as const).optional().default('active'),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerDocsRoutes(fastify: FastifyInstance, db: Db): void {
  // POST — create a new doc. Orchestrator devices OR workspace collaborators may write.
  fastify.post<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/docs',
    async (req, reply) => {
      const workspaceId = req.params.workspaceId;
      let updatedBy: string;

      if (req.authDevice) {
        const device = getDevice(req);
        const principal = buildDevicePrincipal(device);
        const decision = await checkPolicy(
          principal,
          'doc:write',
          { type: 'doc', workspaceId },
          { db, workspaceId },
        );
        if (!decision.allowed) {
          await reply.code(403).send({
            error: 'policy_denied',
            action: 'doc:write',
            principal: decision.principal,
          });
          return;
        }
        updatedBy = device.agentId ?? `device:${device.id}`;
      } else if (req.authUser) {
        // Verify workspace membership
        const member = await db
          .select({ role: schema.workspaceMembers.role })
          .from(schema.workspaceMembers)
          .where(
            and(
              eq(schema.workspaceMembers.workspaceId, workspaceId),
              eq(schema.workspaceMembers.userId, req.authUser.id),
            ),
          )
          .get();
        if (!member) {
          await reply.code(403).send({ error: 'forbidden' });
          return;
        }
        updatedBy = `user:${req.authUser.id}`;
      } else {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }

      const body = CreateDocBodySchema.parse(req.body);

      const id = nanoid();
      try {
        await db.insert(schema.workspaceDocs).values({
          id,
          workspaceId,
          key: body.key,
          title: body.title,
          content: body.content,
          category: body.category,
          updatedBy,
        });
      } catch (err) {
        if (hasUniqueConstraint(err)) {
          await reply.code(409).send({ error: 'key_taken' });
          return;
        }
        throw err;
      }

      await reply.code(201).send({ id, key: body.key });
    },
  );

  // GET — list docs for a workspace. Orchestrators or workspace members.
  fastify.get<{ Params: { workspaceId: string }; Querystring: Record<string, string> }>(
    '/workspaces/:workspaceId/docs',
    async (req, reply) => {
      const workspaceId = req.params.workspaceId;

      if (!req.authDevice && !req.authUser) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }
      if (req.authDevice && req.authDevice.deviceType !== 'orchestrator') {
        await reply.code(403).send({ error: 'orchestrator_required' });
        return;
      }

      const query = ListDocsQuerySchema.parse(req.query);

      const conditions = [
        eq(schema.workspaceDocs.workspaceId, workspaceId),
      ];
      // 'all' is a sentinel meaning "no status filter" — return docs of any status.
      if (query.status !== 'all') {
        conditions.push(eq(schema.workspaceDocs.status, query.status));
      }
      if (query.category) {
        conditions.push(eq(schema.workspaceDocs.category, query.category));
      }

      const docs = await db
        .select()
        .from(schema.workspaceDocs)
        .where(and(...conditions))
        .orderBy(desc(schema.workspaceDocs.updatedAt));

      return { docs };
    },
  );

  // GET /:key — fetch a single doc by key.
  fastify.get<{ Params: { workspaceId: string; key: string } }>(
    '/workspaces/:workspaceId/docs/:key',
    async (req, reply) => {
      const { workspaceId, key } = req.params;

      if (!req.authDevice && !req.authUser) {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }
      if (req.authDevice && req.authDevice.deviceType !== 'orchestrator') {
        await reply.code(403).send({ error: 'orchestrator_required' });
        return;
      }

      const doc = await db
        .select()
        .from(schema.workspaceDocs)
        .where(
          and(
            eq(schema.workspaceDocs.workspaceId, workspaceId),
            eq(schema.workspaceDocs.key, key),
          ),
        )
        .get();

      if (!doc) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      return doc;
    },
  );

  // PATCH /:key — update content/title, archive, or supersede.
  fastify.patch<{ Params: { workspaceId: string; key: string } }>(
    '/workspaces/:workspaceId/docs/:key',
    async (req, reply) => {
      const { workspaceId, key } = req.params;
      let updatedBy: string;

      if (req.authDevice) {
        const device = getDevice(req);
        if (device.deviceType !== 'orchestrator') {
          await reply.code(403).send({ error: 'orchestrator_required' });
          return;
        }
        updatedBy = device.agentId ?? `device:${device.id}`;
      } else if (req.authUser) {
        const member = await db
          .select({ role: schema.workspaceMembers.role })
          .from(schema.workspaceMembers)
          .where(
            and(
              eq(schema.workspaceMembers.workspaceId, workspaceId),
              eq(schema.workspaceMembers.userId, req.authUser.id),
            ),
          )
          .get();
        if (!member) {
          await reply.code(403).send({ error: 'forbidden' });
          return;
        }
        updatedBy = `user:${req.authUser.id}`;
      } else {
        await reply.code(401).send({ error: 'unauthorized' });
        return;
      }

      const body = PatchDocBodySchema.parse(req.body);
      if (Object.keys(body).length === 0) {
        await reply.code(400).send({ error: 'no_fields' });
        return;
      }

      const existing = await db
        .select({ id: schema.workspaceDocs.id, status: schema.workspaceDocs.status })
        .from(schema.workspaceDocs)
        .where(
          and(
            eq(schema.workspaceDocs.workspaceId, workspaceId),
            eq(schema.workspaceDocs.key, key),
          ),
        )
        .get();

      if (!existing) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }

      // Docs can only move forward: active -> archived | superseded.
      // Once archived or superseded, the doc is fully immutable (no edits, no status changes).
      if (existing.status !== 'active') {
        await reply.code(422).send({ error: 'doc_not_active', status: existing.status });
        return;
      }

      const updates: Partial<{
        title: string;
        content: string;
        status: 'active' | 'archived' | 'superseded';
        supersededById: string | null;
        supersededReason: string | null;
        updatedBy: string;
        updatedAt: Date;
      }> = { updatedBy, updatedAt: new Date() };

      if (body.title !== undefined) updates.title = body.title;
      if (body.content !== undefined) updates.content = body.content;
      if (body.status !== undefined) updates.status = body.status;
      if (body.supersededById !== undefined) updates.supersededById = body.supersededById;
      if (body.supersededReason !== undefined) updates.supersededReason = body.supersededReason;

      await db
        .update(schema.workspaceDocs)
        .set(updates)
        .where(eq(schema.workspaceDocs.id, existing.id));

      return { ok: true };
    },
  );
}
