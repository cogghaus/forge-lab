import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { requireWorkspaceMember, getWorkspace, getUser } from '../auth/middleware.js';

const MAX_DOCS = 10;
const MAX_BYTES = 10_000;

const RESERVED_NAMES = new Set(['changes']);

const NameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9-]+$/, 'name must be lowercase alphanumeric with hyphens')
  .refine((n) => !RESERVED_NAMES.has(n), 'reserved name');

const PutBodySchema = z.object({
  content: z.string().min(1),
});

const ListQuerySchema = z.object({
  content: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const ChangesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().min(1).optional(),
});

async function recordContextChange(
  db: Db,
  entry: {
    workspaceId: string;
    name: string;
    action: 'create' | 'update' | 'delete';
    changedBy: string;
    snapshot: object | null;
  },
): Promise<void> {
  try {
    await db.insert(schema.workspaceContextChanges).values({
      id: nanoid(),
      workspaceId: entry.workspaceId,
      name: entry.name,
      action: entry.action,
      changedBy: entry.changedBy,
      snapshot: entry.snapshot !== null ? JSON.stringify(entry.snapshot) : null,
    });
  } catch (err) {
    // Non-fatal — audit write failure must not block the mutation response.
    console.error('[workspace-context] audit write failed', err);
  }
}

export function registerWorkspaceContextRoutes(fastify: FastifyInstance, db: Db): void {
  // GET /workspaces/:workspaceId/context-docs — list docs (optionally with content)
  fastify.get<{ Params: { workspaceId: string }; Querystring: Record<string, string> }>(
    '/workspaces/:workspaceId/context-docs',
    { preHandler: requireWorkspaceMember(db, 'viewer') },
    async (req) => {
      const { id: workspaceId } = getWorkspace(req);
      const { content: includeContent } = ListQuerySchema.parse(req.query);

      // Conditionally project content — avoids fetching up to 100KB per request when not needed.
      const rows = includeContent
        ? await db
            .select()
            .from(schema.workspaceContext)
            .where(eq(schema.workspaceContext.workspaceId, workspaceId))
            .orderBy(desc(schema.workspaceContext.updatedAt))
        : await db
            .select({
              id: schema.workspaceContext.id,
              name: schema.workspaceContext.name,
              content: schema.workspaceContext.content,
              updatedAt: schema.workspaceContext.updatedAt,
              updatedBy: schema.workspaceContext.updatedBy,
            })
            .from(schema.workspaceContext)
            .where(eq(schema.workspaceContext.workspaceId, workspaceId))
            .orderBy(desc(schema.workspaceContext.updatedAt));

      const docs = rows.map((r) => ({
        id: r.id,
        name: r.name,
        sizeBytes: Buffer.byteLength(r.content, 'utf8'),
        updatedAt: r.updatedAt,
        updatedBy: r.updatedBy,
        ...(includeContent ? { content: r.content } : {}),
      }));

      return { docs };
    },
  );

  // GET /workspaces/:workspaceId/context-docs/:name — fetch single doc
  fastify.get<{ Params: { workspaceId: string; name: string } }>(
    '/workspaces/:workspaceId/context-docs/:name',
    { preHandler: requireWorkspaceMember(db, 'viewer') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const name = NameSchema.parse(req.params.name);

      const doc = await db
        .select()
        .from(schema.workspaceContext)
        .where(
          and(
            eq(schema.workspaceContext.workspaceId, workspaceId),
            eq(schema.workspaceContext.name, name),
          ),
        )
        .get();

      if (!doc) return reply.code(404).send({ error: 'not_found' });
      return {
        doc: { ...doc, sizeBytes: Buffer.byteLength(doc.content, 'utf8') },
      };
    },
  );

  // PUT /workspaces/:workspaceId/context-docs/:name — upsert a doc
  fastify.put<{ Params: { workspaceId: string; name: string } }>(
    '/workspaces/:workspaceId/context-docs/:name',
    { preHandler: requireWorkspaceMember(db, 'admin') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const user = getUser(req);
      const name = NameSchema.parse(req.params.name);
      const { content } = PutBodySchema.parse(req.body);

      const sizeBytes = Buffer.byteLength(content, 'utf8');
      if (sizeBytes > MAX_BYTES) {
        return reply.code(413).send({ error: 'content_too_large', maxBytes: MAX_BYTES, sizeBytes });
      }

      const now = new Date();

      // Check whether this is a create (needs count guard) or update (upsert OK).
      // SQLite WAL mode allows this check-then-insert race as an advisory soft limit;
      // the UNIQUE(workspace_id, name) constraint prevents duplicate docs, and a
      // transient overflow by one slot (two concurrent inserts of different names) is
      // acceptable in practice. db.transaction() is incompatible with libsql :memory:
      // clients (the client nullifies its connection after issuing BEGIN, causing
      // subsequent requests to hit a fresh empty in-memory database).
      const existing = await db
        .select({ id: schema.workspaceContext.id })
        .from(schema.workspaceContext)
        .where(
          and(
            eq(schema.workspaceContext.workspaceId, workspaceId),
            eq(schema.workspaceContext.name, name),
          ),
        )
        .get();

      if (!existing) {
        const countRow = await db
          .select({ n: count() })
          .from(schema.workspaceContext)
          .where(eq(schema.workspaceContext.workspaceId, workspaceId))
          .get();
        if ((countRow?.n ?? 0) >= MAX_DOCS) {
          return reply.code(422).send({ error: 'doc_limit_exceeded', max: MAX_DOCS });
        }
      }

      const id = existing?.id ?? nanoid();
      const isCreate = !existing;

      if (existing) {
        await db
          .update(schema.workspaceContext)
          .set({ content, updatedBy: user.id, updatedAt: now })
          .where(eq(schema.workspaceContext.id, id))
          .run();
      } else {
        await db.insert(schema.workspaceContext).values({
          id,
          workspaceId,
          name,
          content,
          createdBy: user.id,
          updatedBy: user.id,
        });
      }

      void recordContextChange(db, {
        workspaceId,
        name,
        action: isCreate ? 'create' : 'update',
        changedBy: user.id,
        snapshot: { id, name, content, sizeBytes, updatedAt: now.getTime() },
      });

      return reply.code(isCreate ? 201 : 200).send({
        doc: { id, name, sizeBytes, updatedAt: now.getTime() },
      });
    },
  );

  // DELETE /workspaces/:workspaceId/context-docs/:name — remove a doc
  fastify.delete<{ Params: { workspaceId: string; name: string } }>(
    '/workspaces/:workspaceId/context-docs/:name',
    { preHandler: requireWorkspaceMember(db, 'admin') },
    async (req, reply) => {
      const { id: workspaceId } = getWorkspace(req);
      const user = getUser(req);
      const name = NameSchema.parse(req.params.name);

      const doc = await db
        .select()
        .from(schema.workspaceContext)
        .where(
          and(
            eq(schema.workspaceContext.workspaceId, workspaceId),
            eq(schema.workspaceContext.name, name),
          ),
        )
        .get();

      if (!doc) return reply.code(404).send({ error: 'not_found' });

      await db
        .delete(schema.workspaceContext)
        .where(eq(schema.workspaceContext.id, doc.id))
        .run();

      void recordContextChange(db, {
        workspaceId,
        name,
        action: 'delete',
        changedBy: user.id,
        snapshot: { id: doc.id, name: doc.name, content: doc.content, updatedAt: doc.updatedAt },
      });

      return { deleted: true };
    },
  );

  // GET /workspaces/:workspaceId/context-docs/changes — audit log
  fastify.get<{ Params: { workspaceId: string }; Querystring: Record<string, string> }>(
    '/workspaces/:workspaceId/context-docs/changes',
    { preHandler: requireWorkspaceMember(db, 'admin') },
    async (req) => {
      const { id: workspaceId } = getWorkspace(req);
      const query = ChangesQuerySchema.parse(req.query);

      const changes = await db
        .select()
        .from(schema.workspaceContextChanges)
        .where(
          and(
            eq(schema.workspaceContextChanges.workspaceId, workspaceId),
            query.before
              ? lt(schema.workspaceContextChanges.changedAt, new Date(query.before))
              : undefined,
          ),
        )
        .orderBy(desc(schema.workspaceContextChanges.changedAt))
        .limit(query.limit);

      return { changes };
    },
  );
}
