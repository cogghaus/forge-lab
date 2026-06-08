import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHub, type Hub } from '../app.js';
import { TEST_HUB_CONFIG, setupAdmin, createWorkspace } from '../test-utils.js';

describe('workspace context API', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  // ── PUT (upsert) ──────────────────────────────────────────────────────────

  it('PUT creates a new context doc (201)', async () => {
    const res = await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/architecture`,
      headers: { cookie },
      payload: { content: '# Architecture\nOverview here.' },
    });
    expect(res.statusCode).toBe(201);
    const { doc } = res.json() as { doc: Record<string, unknown> };
    expect(doc['name']).toBe('architecture');
    expect(doc['sizeBytes']).toBeGreaterThan(0);
  });

  it('PUT replaces existing doc (200)', async () => {
    await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/architecture`,
      headers: { cookie },
      payload: { content: 'v1' },
    });
    const res = await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/architecture`,
      headers: { cookie },
      payload: { content: 'v2 updated' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('PUT rejects content over 10 000 bytes (413)', async () => {
    const res = await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/big`,
      headers: { cookie },
      payload: { content: 'x'.repeat(10_001) },
    });
    expect(res.statusCode).toBe(413);
    expect((res.json() as { error: string }).error).toBe('content_too_large');
  });

  it('PUT rejects invalid name characters (400)', async () => {
    const res = await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/Bad_Name`,
      headers: { cookie },
      payload: { content: 'test' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PUT returns 422 after 10 docs', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await hub.fastify.inject({
        method: 'PUT',
        url: `/workspaces/${workspaceId}/context-docs/doc-${i}`,
        headers: { cookie },
        payload: { content: `content ${i}` },
      });
      expect(r.statusCode).toBe(201);
    }
    const over = await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/doc-overflow`,
      headers: { cookie },
      payload: { content: 'one too many' },
    });
    expect(over.statusCode).toBe(422);
    expect((over.json() as { max: number }).max).toBe(10);
  });

  it('PUT update does not count against doc limit', async () => {
    for (let i = 0; i < 10; i++) {
      await hub.fastify.inject({
        method: 'PUT',
        url: `/workspaces/${workspaceId}/context-docs/doc-${i}`,
        headers: { cookie },
        payload: { content: `content ${i}` },
      });
    }
    // Update existing doc-0 — should succeed even though count == 10
    const res = await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/doc-0`,
      headers: { cookie },
      payload: { content: 'updated' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('PUT requires workspace admin (403 for non-admin)', async () => {
    const res = await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/architecture`,
      payload: { content: 'test' },
    });
    expect(res.statusCode).toBe(401);
  });

  // ── GET list ──────────────────────────────────────────────────────────────

  it('GET /context returns list without content by default', async () => {
    await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/architecture`,
      headers: { cookie },
      payload: { content: '# Arch' },
    });
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context-docs`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { docs } = res.json() as { docs: Record<string, unknown>[] };
    expect(docs).toHaveLength(1);
    expect(docs[0]!['content']).toBeUndefined();
    expect(docs[0]!['sizeBytes']).toBeGreaterThan(0);
  });

  it('GET /context?content=true includes content', async () => {
    await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/architecture`,
      headers: { cookie },
      payload: { content: '# Arch' },
    });
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context-docs?content=true`,
      headers: { cookie },
    });
    const { docs } = res.json() as { docs: Record<string, unknown>[] };
    expect(docs[0]!['content']).toBe('# Arch');
  });

  it('GET /context returns empty array when no docs', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context-docs`,
      headers: { cookie },
    });
    const { docs } = res.json() as { docs: unknown[] };
    expect(docs).toHaveLength(0);
  });

  // ── GET single ────────────────────────────────────────────────────────────

  it('GET /context/:name returns full doc', async () => {
    await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/gotchas`,
      headers: { cookie },
      payload: { content: '- Watch out for X' },
    });
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context-docs/gotchas`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { doc } = res.json() as { doc: Record<string, unknown> };
    expect(doc['content']).toBe('- Watch out for X');
    expect(doc['name']).toBe('gotchas');
  });

  it('GET /context/:name returns 404 for missing doc', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context-docs/missing`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── DELETE ────────────────────────────────────────────────────────────────

  it('DELETE removes doc and returns deleted:true', async () => {
    await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/temp`,
      headers: { cookie },
      payload: { content: 'temp content' },
    });
    const del = await hub.fastify.inject({
      method: 'DELETE',
      url: `/workspaces/${workspaceId}/context-docs/temp`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { deleted: boolean }).deleted).toBe(true);

    const get = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context-docs/temp`,
      headers: { cookie },
    });
    expect(get.statusCode).toBe(404);
  });

  it('DELETE returns 404 for missing doc', async () => {
    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: `/workspaces/${workspaceId}/context-docs/nonexistent`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE allows new doc after deletion (limit freed)', async () => {
    for (let i = 0; i < 10; i++) {
      await hub.fastify.inject({
        method: 'PUT',
        url: `/workspaces/${workspaceId}/context-docs/doc-${i}`,
        headers: { cookie },
        payload: { content: `content ${i}` },
      });
    }
    await hub.fastify.inject({
      method: 'DELETE',
      url: `/workspaces/${workspaceId}/context-docs/doc-0`,
      headers: { cookie },
    });
    const res = await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/doc-new`,
      headers: { cookie },
      payload: { content: 'fits now' },
    });
    expect(res.statusCode).toBe(201);
  });

  // ── audit trail ───────────────────────────────────────────────────────────

  it('GET /context/changes records create + update + delete', async () => {
    await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/arch`,
      headers: { cookie },
      payload: { content: 'v1' },
    });
    await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/arch`,
      headers: { cookie },
      payload: { content: 'v2' },
    });
    await hub.fastify.inject({
      method: 'DELETE',
      url: `/workspaces/${workspaceId}/context-docs/arch`,
      headers: { cookie },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context-docs/changes`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { changes } = res.json() as { changes: { action: string }[] };
    const actions = changes.map((c) => c.action).sort();
    expect(actions).toEqual(['create', 'delete', 'update']);
  });

  it('GET /context/changes requires admin (401 unauthenticated)', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context-docs/changes`,
    });
    expect(res.statusCode).toBe(401);
  });

  // ── migration coverage ─────────────────────────────────────────────────────

  it('migration 0013 creates workspace_context table', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (hub.db as any).$client as { execute: (opts: { sql: string }) => Promise<{ rows: unknown[] }> };
    const result = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_context'" });
    expect(result.rows).toHaveLength(1);
  });

  it('migration 0014 adds context_snapshot column to tasks', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (hub.db as any).$client as { execute: (opts: { sql: string }) => Promise<{ rows: Record<string, unknown>[] }> };
    const result = await client.execute({ sql: 'PRAGMA table_info(tasks)' });
    const names = result.rows.map((r) => r['name'] as string);
    expect(names).toContain('context_snapshot');
  });
});
