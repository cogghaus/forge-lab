import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@forge-lab/core';
import { createHub, type Hub } from '../app.js';
import type { HubConfig } from '../config.js';
import { TEST_HUB_CONFIG, setupAdmin, createWorkspace } from '../test-utils.js';

const testConfig: HubConfig = TEST_HUB_CONFIG;

async function registerOrchestrator(hub: Hub, cookie: string): Promise<string> {
  const res = await hub.fastify.inject({
    method: 'POST',
    url: '/devices',
    headers: { cookie },
    payload: { name: 'scribe', agentId: 'scribe', deviceType: 'orchestrator' },
  });
  return (res.json() as { token: string }).token;
}

async function registerWorker(hub: Hub, cookie: string): Promise<string> {
  const res = await hub.fastify.inject({
    method: 'POST',
    url: '/devices',
    headers: { cookie },
    payload: { name: 'architect', agentId: 'architect', deviceType: 'worker' },
  });
  return (res.json() as { token: string }).token;
}

describe('/workspaces/:workspaceId/docs', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;
  let fmToken: string;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie, { slug: 'docs-ws' });
    fmToken = await registerOrchestrator(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  // POST -----------------------------------------------------------------------

  it('orchestrator can create a doc', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: {
        key: 'architecture-overview',
        title: 'Architecture Overview',
        content: 'Hub-spoke model.',
        category: 'architecture',
      },
    });
    expect(res.statusCode).toBe(201);
    const { id, key } = res.json() as { id: string; key: string };
    expect(id).toBeTruthy();
    expect(key).toBe('architecture-overview');

    const doc = await hub.db
      .select()
      .from(schema.workspaceDocs)
      .where(eq(schema.workspaceDocs.id, id))
      .get();
    expect(doc?.workspaceId).toBe(workspaceId);
    expect(doc?.status).toBe('active');
    expect(doc?.updatedBy).toBe('scribe');
  });

  it('workspace member (user) can create a doc', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { cookie },
      payload: {
        key: 'user-doc',
        title: 'User Doc',
        content: 'Content.',
        category: 'adr',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('worker device (non-orchestrator) gets 403', async () => {
    const workerToken = await registerWorker(hub, cookie);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${workerToken}` },
      payload: {
        key: 'worker-doc',
        title: 'Worker Doc',
        content: 'Content.',
        category: 'pattern',
      },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('orchestrator_required');
  });

  it('duplicate key returns 409', async () => {
    const payload = {
      key: 'arch',
      title: 'Arch',
      content: 'Content.',
      category: 'architecture',
    };
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload,
    });
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('key_taken');
  });

  it('key with spaces is rejected by Zod (400)', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: {
        key: 'has spaces',
        title: 'Bad',
        content: 'Content.',
        category: 'adr',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires auth — no token returns 401', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      payload: {
        key: 'unauth',
        title: 'Unauth',
        content: 'Content.',
        category: 'adr',
      },
    });
    expect(res.statusCode).toBe(401);
  });

  // GET list -------------------------------------------------------------------

  it('GET lists active docs by default', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'doc-a', title: 'A', content: 'Content.', category: 'adr' },
    });
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'doc-b', title: 'B', content: 'Content.', category: 'architecture' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { docs } = res.json() as { docs: { key: string }[] };
    expect(docs).toHaveLength(2);
    const keys = docs.map((d) => d.key);
    expect(keys).toContain('doc-a');
    expect(keys).toContain('doc-b');
  });

  it('GET with ?category= filters docs', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'adr-001', title: 'ADR', content: 'Decision.', category: 'adr' },
    });
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'arch-main', title: 'Arch', content: 'Arch.', category: 'architecture' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/docs?category=adr`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { docs } = res.json() as { docs: { key: string; category: string }[] };
    expect(docs).toHaveLength(1);
    expect(docs[0]!.category).toBe('adr');
  });

  it('GET excludes docs from other workspaces', async () => {
    const ws2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'WS2', slug: 'ws2-docs' },
    });
    const ws2Id = (ws2Res.json() as { id: string }).id;

    // Insert doc in ws2
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${ws2Id}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'ws2-doc', title: 'WS2 Doc', content: 'Content.', category: 'adr' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    const { docs } = res.json() as { docs: unknown[] };
    expect(docs).toHaveLength(0);
  });

  it('GET ?status=archived only returns archived docs', async () => {
    // Create one active doc, then archive it
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'to-archive', title: 'To Archive', content: 'Content.', category: 'adr' },
    });
    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/docs/to-archive`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { status: 'archived' },
    });
    // Create a second active doc that should NOT appear
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'stays-active', title: 'Active', content: 'Content.', category: 'adr' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/docs?status=archived`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    const { docs } = res.json() as { docs: { key: string; status: string }[] };
    expect(docs).toHaveLength(1);
    expect(docs[0]!.key).toBe('to-archive');
    expect(docs[0]!.status).toBe('archived');
  });

  // GET by key -----------------------------------------------------------------

  it('GET /:key returns the doc', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'get-me', title: 'Get Me', content: 'Content here.', category: 'runbook' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/docs/get-me`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as { key: string; title: string; content: string };
    expect(doc.key).toBe('get-me');
    expect(doc.content).toBe('Content here.');
  });

  it('GET /:key returns 404 for unknown key', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/docs/nonexistent`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // PATCH ----------------------------------------------------------------------

  it('PATCH updates title and content', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'patch-me', title: 'Old Title', content: 'Old content.', category: 'architecture' },
    });

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/docs/patch-me`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { title: 'New Title', content: 'Updated content.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const doc = await hub.db
      .select({ title: schema.workspaceDocs.title, content: schema.workspaceDocs.content })
      .from(schema.workspaceDocs)
      .where(eq(schema.workspaceDocs.key, 'patch-me'))
      .get();
    expect(doc?.title).toBe('New Title');
    expect(doc?.content).toBe('Updated content.');
  });

  it('PATCH can archive a doc', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'archive-me', title: 'To Archive', content: 'Content.', category: 'pattern' },
    });

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/docs/archive-me`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { status: 'archived' },
    });
    expect(res.statusCode).toBe(200);

    const doc = await hub.db
      .select({ status: schema.workspaceDocs.status })
      .from(schema.workspaceDocs)
      .where(eq(schema.workspaceDocs.key, 'archive-me'))
      .get();
    expect(doc?.status).toBe('archived');
  });

  it('PATCH supersede requires supersededReason (400 without it)', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'bad-supersede', title: 'Old', content: 'Content.', category: 'adr' },
    });

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/docs/bad-supersede`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { status: 'superseded' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH supersede with reason succeeds and records supersededById', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'old-arch', title: 'Old', content: 'Old arch.', category: 'architecture' },
    });
    const newRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'new-arch', title: 'New', content: 'New arch.', category: 'architecture' },
    });
    const newId = (newRes.json() as { id: string }).id;

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/docs/old-arch`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: {
        status: 'superseded',
        supersededById: newId,
        supersededReason: 'Replaced by new-arch which adds FM routing details.',
      },
    });
    expect(res.statusCode).toBe(200);

    const doc = await hub.db
      .select({
        status: schema.workspaceDocs.status,
        supersededById: schema.workspaceDocs.supersededById,
        supersededReason: schema.workspaceDocs.supersededReason,
      })
      .from(schema.workspaceDocs)
      .where(eq(schema.workspaceDocs.key, 'old-arch'))
      .get();
    expect(doc?.status).toBe('superseded');
    expect(doc?.supersededById).toBe(newId);
    expect(doc?.supersededReason).toBe('Replaced by new-arch which adds FM routing details.');
  });

  it('PATCH on archived doc returns 422 (immutable)', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'frozen', title: 'Frozen', content: 'Content.', category: 'pattern' },
    });
    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/docs/frozen`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { status: 'archived' },
    });

    // Try to archive again
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/docs/frozen`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { status: 'archived' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('doc_not_active');
  });

  it('PATCH returns 404 for unknown key', async () => {
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/docs/does-not-exist`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { title: 'New title' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH content edit on archived doc returns 422 (fully immutable)', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'immutable-content', title: 'Immutable', content: 'Original.', category: 'adr' },
    });
    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/docs/immutable-content`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { status: 'archived' },
    });

    // Title-only edit on archived doc must also be rejected
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/docs/immutable-content`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { title: 'Should not update' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('doc_not_active');
  });

  it('PATCH with empty body returns 400', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'empty-patch', title: 'Empty Patch', content: 'Content.', category: 'adr' },
    });

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/docs/empty-patch`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('no_fields');
  });

  it('worker device on GET list returns 403', async () => {
    const workerToken = await registerWorker(hub, cookie);
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${workerToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('orchestrator_required');
  });

  it('worker device on GET /:key returns 403', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/docs`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { key: 'worker-read', title: 'Worker Read', content: 'Content.', category: 'adr' },
    });

    const workerToken = await registerWorker(hub, cookie);
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/docs/worker-read`,
      headers: { authorization: `Bearer ${workerToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('orchestrator_required');
  });
});
