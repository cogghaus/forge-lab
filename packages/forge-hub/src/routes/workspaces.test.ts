import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { schema } from '@forge-lab/core';
import { createHub, type Hub } from '../app.js';
import { createSession } from '../auth/sessions.js';
import type { HubConfig } from '../config.js';

const testConfig: HubConfig = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl: ':memory:',
  sessionSecret: 'test-secret-with-at-least-32-characters-xxxx',
  sessionTtlHours: 24,
  bcryptCost: 10,
  cookieSecure: false,
};

async function setupOwner(hub: Hub) {
  const regRes = await hub.fastify.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email: 'owner@example.com', password: 'password123' },
  });
  const ownerId = (regRes.json() as { id: string }).id;
  const loginRes = await hub.fastify.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'owner@example.com', password: 'password123' },
  });
  const setCookie = loginRes.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
  return { ownerId, cookie };
}

async function setupSecondUser(hub: Hub) {
  const userId = nanoid();
  await hub.db.insert(schema.users).values({
    id: userId,
    email: 'member@example.com',
    passwordHash: 'placeholder',
    role: 'user',
  });
  const session = await createSession(hub.db, userId, 24);
  const cookie = `session=${session.token}`;
  return { userId, cookie };
}

async function createWorkspace(hub: Hub, cookie: string, slug = 'test-ws') {
  const res = await hub.fastify.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { cookie },
    payload: { name: 'Test WS', slug },
  });
  return (res.json() as { id: string }).id;
}

describe('/workspaces routes', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('POST /workspaces requires auth', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      payload: { name: 'Acme', slug: 'acme' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /workspaces requires auth', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/workspaces' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /workspaces/:workspaceId requires auth', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/workspaces/fake-id' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /workspaces/:workspaceId/members requires auth', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/workspaces/fake-id/members' });
    expect(res.statusCode).toBe(401);
  });

  it('creates workspace and auto-adds creator as owner', async () => {
    const { ownerId, cookie } = await setupOwner(hub);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'Acme Corp', slug: 'acme' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    expect(id).toBeTruthy();

    const membersRes = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${id}/members`,
      headers: { cookie },
    });
    expect(membersRes.statusCode).toBe(200);
    const { members } = membersRes.json() as { members: { userId: string; role: string }[] };
    expect(members).toHaveLength(1);
    expect(members[0]!.userId).toBe(ownerId);
    expect(members[0]!.role).toBe('owner');
  });

  it('POST /workspaces - 409 for duplicate slug', async () => {
    const { cookie } = await setupOwner(hub);
    await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'First', slug: 'acme' },
    });
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'Second', slug: 'acme' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('slug_taken');
  });

  it('POST /workspaces - 400 for invalid slug', async () => {
    const { cookie } = await setupOwner(hub);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'Bad', slug: 'Has Spaces' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /workspaces lists only user memberships', async () => {
    const { cookie } = await setupOwner(hub);
    const { cookie: cookieB } = await setupSecondUser(hub);

    await createWorkspace(hub, cookie, 'ws-owner');
    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: '/workspaces',
      headers: { cookie: cookieB },
    });
    expect(listRes.statusCode).toBe(200);
    const { workspaces } = listRes.json() as { workspaces: unknown[] };
    expect(workspaces).toHaveLength(0);
  });

  it('GET /workspaces lists workspaces with role', async () => {
    const { cookie } = await setupOwner(hub);
    await createWorkspace(hub, cookie, 'ws-a');
    await createWorkspace(hub, cookie, 'ws-b');
    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: '/workspaces',
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const { workspaces } = listRes.json() as { workspaces: { role: string }[] };
    expect(workspaces).toHaveLength(2);
    expect(workspaces.every((w) => w.role === 'owner')).toBe(true);
  });

  it('GET /workspaces/:workspaceId returns workspace', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'my-ws');
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { slug: string }).slug).toBe('my-ws');
  });

  it('GET /workspaces/:workspaceId - 403 for non-member', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'priv-ws');
    const { cookie: cookieB } = await setupSecondUser(hub);
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PATCH /workspaces/:workspaceId updates name and description', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'patch-ws');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
      payload: { name: 'Renamed', description: 'Updated desc' },
    });
    expect(res.statusCode).toBe(200);

    const getRes = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
    });
    const ws = getRes.json() as { name: string; description: string };
    expect(ws.name).toBe('Renamed');
    expect(ws.description).toBe('Updated desc');
  });

  it('PATCH /workspaces/:workspaceId - 400 when no fields sent', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'patch-ws');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /workspaces/:workspaceId - 403 for collaborator', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'patch-ws');
    const { userId: userBId, cookie: cookieB } = await setupSecondUser(hub);

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsId}/members`,
      headers: { cookie },
      payload: { userId: userBId, role: 'collaborator' },
    });

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${wsId}`,
      headers: { cookie: cookieB },
      payload: { name: 'Hacked' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('insufficient_role');
  });

  it('DELETE /workspaces/:workspaceId soft-deletes workspace', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'del-ws');
    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });

  it('DELETE /workspaces/:workspaceId - 403 for admin (not owner)', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'del-ws');
    const { userId: userBId, cookie: cookieB } = await setupSecondUser(hub);

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsId}/members`,
      headers: { cookie },
      payload: { userId: userBId, role: 'admin' },
    });

    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: `/workspaces/${wsId}`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /workspaces/:workspaceId/members adds member', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'mem-ws');
    const { userId: userBId } = await setupSecondUser(hub);

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsId}/members`,
      headers: { cookie },
      payload: { userId: userBId, role: 'collaborator' },
    });
    expect(res.statusCode).toBe(201);

    const membersRes = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}/members`,
      headers: { cookie },
    });
    const { members } = membersRes.json() as { members: { userId: string; role: string }[] };
    expect(members).toHaveLength(2);
    const memberB = members.find((m) => m.userId === userBId);
    expect(memberB?.role).toBe('collaborator');
  });

  it('POST /workspaces/:workspaceId/members - 409 for already member', async () => {
    const { cookie, ownerId } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'mem-ws');

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsId}/members`,
      headers: { cookie },
      payload: { userId: ownerId, role: 'collaborator' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('already_member');
  });

  it('POST /workspaces/:workspaceId/members - 404 for nonexistent user', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'mem-ws');

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsId}/members`,
      headers: { cookie },
      payload: { userId: 'does-not-exist', role: 'viewer' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /workspaces/:workspaceId/members/:userId removes member', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'mem-ws');
    const { userId: userBId } = await setupSecondUser(hub);

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsId}/members`,
      headers: { cookie },
      payload: { userId: userBId, role: 'viewer' },
    });

    const delRes = await hub.fastify.inject({
      method: 'DELETE',
      url: `/workspaces/${wsId}/members/${userBId}`,
      headers: { cookie },
    });
    expect(delRes.statusCode).toBe(200);

    const membersRes = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}/members`,
      headers: { cookie },
    });
    const { members } = membersRes.json() as { members: { userId: string }[] };
    expect(members.every((m) => m.userId !== userBId)).toBe(true);
  });

  it('DELETE /workspaces/:workspaceId/members/:userId - 422 for owner removal', async () => {
    const { cookie, ownerId } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'mem-ws');

    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: `/workspaces/${wsId}/members/${ownerId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('cannot_remove_owner');
  });

  it('DELETE /workspaces/:workspaceId/members/:userId - 404 for nonexistent member', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'mem-ws');

    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: `/workspaces/${wsId}/members/no-such-user`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /workspaces excludes soft-deleted workspaces from list', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'del-list');
    await hub.fastify.inject({ method: 'DELETE', url: `/workspaces/${wsId}`, headers: { cookie } });
    const res = await hub.fastify.inject({ method: 'GET', url: '/workspaces', headers: { cookie } });
    const { workspaces } = res.json() as { workspaces: unknown[] };
    expect(workspaces).toHaveLength(0);
  });

  it('GET /workspaces/:workspaceId returns 404 after soft-delete', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'dead-ws');
    await hub.fastify.inject({ method: 'DELETE', url: `/workspaces/${wsId}`, headers: { cookie } });
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /workspaces/:workspaceId/members returns 404 after soft-delete', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'dead-mem');
    const { userId: userBId } = await setupSecondUser(hub);
    await hub.fastify.inject({ method: 'DELETE', url: `/workspaces/${wsId}`, headers: { cookie } });
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsId}/members`,
      headers: { cookie },
      payload: { userId: userBId, role: 'viewer' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /workspaces returns 409 when UNIQUE constraint fires (no pre-check race)', async () => {
    const { cookie, ownerId } = await setupOwner(hub);
    await hub.db.insert(schema.workspaces).values({
      id: 'pre-existing-id',
      name: 'Pre-inserted',
      slug: 'no-precheck-slug',
      ownerUserId: ownerId,
      status: 'active',
      budgetMonthlyCents: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'Late Arrival', slug: 'no-precheck-slug' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('slug_taken');
  });

  it('added member can access workspace', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'shared-ws');
    const { userId: userBId, cookie: cookieB } = await setupSecondUser(hub);

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsId}/members`,
      headers: { cookie },
      payload: { userId: userBId, role: 'viewer' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Activity feed
  // ---------------------------------------------------------------------------

  it('GET /workspaces/:workspaceId/activity requires auth', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/workspaces/fake-id/activity',
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /workspaces/:workspaceId/activity - 403 for non-member', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'act-priv');
    const { cookie: cookieB } = await setupSecondUser(hub);
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}/activity`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /workspaces/:workspaceId/activity returns task history with task title', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'act-ws');

    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ACT', title: 'Activity task' },
    });
    expect(taskRes.statusCode).toBe(201);

    const actRes = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}/activity`,
      headers: { cookie },
    });
    expect(actRes.statusCode).toBe(200);
    const { activity } = actRes.json() as {
      activity: { eventName: string; taskTitle: string; taskId: string }[];
    };
    expect(activity.length).toBeGreaterThan(0);
    expect(activity[0]!.eventName).toBe('task.created');
    expect(activity[0]!.taskTitle).toBe('Activity task');
    expect(activity[0]!.taskId).toBe('act-001');
  });

  it('GET /workspaces/:workspaceId/activity excludes tasks from other workspaces', async () => {
    const { cookie } = await setupOwner(hub);
    const wsId = await createWorkspace(hub, cookie, 'act-ws-a');
    const wsIdB = await createWorkspace(hub, cookie, 'act-ws-b');

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsIdB}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'OTH', title: 'Other workspace task' },
    });

    const actRes = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}/activity`,
      headers: { cookie },
    });
    expect(actRes.statusCode).toBe(200);
    const { activity } = actRes.json() as { activity: unknown[] };
    expect(activity).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GET /workspaces/:workspaceId/context  — FM Tier 0 context bundle
// ---------------------------------------------------------------------------

type ContextResponse = {
  workspaceId: string;
  docs: unknown[];
  goals: unknown[];
  agents: unknown[];
  liveInstances: unknown[];
  inboxTasks: unknown[];
  recentHistory: unknown[];
  dispatcherHistory: unknown[];
  queueDepth: Record<string, number>;
};

describe('GET /workspaces/:workspaceId/context', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;
  let fmToken: string;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie } = await setupOwner(hub));
    workspaceId = await createWorkspace(hub, cookie);

    // Register FM orchestrator device
    const devRes = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'forge-master', agentId: 'forge-master', deviceType: 'orchestrator' },
    });
    fmToken = (devRes.json() as { token: string }).token;
  });

  afterEach(async () => {
    await hub.close();
  });

  it('returns 401 without device auth', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns all context keys with empty data for a fresh workspace', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    const ctx = res.json() as ContextResponse;
    expect(ctx.workspaceId).toBe(workspaceId);
    expect(Array.isArray(ctx.docs)).toBe(true);
    expect(Array.isArray(ctx.goals)).toBe(true);
    expect(Array.isArray(ctx.agents)).toBe(true);
    expect(Array.isArray(ctx.liveInstances)).toBe(true);
    expect(Array.isArray(ctx.inboxTasks)).toBe(true);
    expect(Array.isArray(ctx.recentHistory)).toBe(true);
    expect(Array.isArray(ctx.dispatcherHistory)).toBe(true);
    expect(typeof ctx.queueDepth).toBe('object');
  });

  it('inboxTasks only includes pending_dispatcher_action tasks', async () => {
    // Create one inbox task and one normal task
    const inboxRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ctx', title: 'Inbox task' },
    });
    const inboxId = (inboxRes.json() as { id: string }).id;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, inboxId));

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ctx', title: 'Normal task' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    const ctx = res.json() as ContextResponse;
    expect(ctx.inboxTasks).toHaveLength(1);
    const inboxTask = ctx.inboxTasks[0] as { id: string; status: string };
    expect(inboxTask.id).toBe(inboxId);
    expect(inboxTask.status).toBe('pending_dispatcher_action');
  });

  it('queueDepth counts tasks by status', async () => {
    // Create 2 pending_agent + 1 in_progress tasks
    for (let i = 0; i < 2; i++) {
      await hub.fastify.inject({
        method: 'POST',
        url: `/workspaces/${workspaceId}/tasks`,
        headers: { cookie },
        payload: { projectPrefix: 'qd', title: `Task ${i}` },
      });
    }
    const inProgressRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'qd', title: 'Running task' },
    });
    const inProgressId = (inProgressRes.json() as { id: string }).id;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'in_progress' })
      .where(eq(schema.tasks.id, inProgressId));

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    const ctx = res.json() as ContextResponse;
    expect(ctx.queueDepth['pending_agent']).toBe(2);
    expect(ctx.queueDepth['in_progress']).toBe(1);
  });

  it('docs only includes active docs in FM-critical categories', async () => {
    // Insert one active architecture doc and one archived doc
    await hub.db.insert(schema.workspaceDocs).values({
      id: nanoid(),
      workspaceId,
      key: 'arch-overview',
      title: 'Architecture Overview',
      content: 'The system uses a hub-spoke model.',
      category: 'architecture',
      status: 'active',
      updatedBy: 'scribe',
    });
    await hub.db.insert(schema.workspaceDocs).values({
      id: nanoid(),
      workspaceId,
      key: 'old-pattern',
      title: 'Old Pattern',
      content: 'Deprecated approach.',
      category: 'pattern',
      status: 'archived',
      updatedBy: 'scribe',
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    const ctx = res.json() as ContextResponse;
    // architecture is in CONTEXT_DOC_CATEGORIES, archived status excluded
    expect(ctx.docs).toHaveLength(1);
    const doc = ctx.docs[0] as { key: string; status: string; category: string };
    expect(doc.key).toBe('arch-overview');
    expect(doc.status).toBe('active');
    expect(doc.category).toBe('architecture');
  });

  it('docs excludes pattern and feature categories (not in Tier 0)', async () => {
    await hub.db.insert(schema.workspaceDocs).values({
      id: nanoid(),
      workspaceId,
      key: 'feature-x',
      title: 'Feature X',
      content: 'Details.',
      category: 'feature',
      status: 'active',
      updatedBy: 'scribe',
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    const ctx = res.json() as ContextResponse;
    expect(ctx.docs).toHaveLength(0);
  });

  it('context excludes data from other workspaces', async () => {
    const ws2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'Other WS', slug: 'other-ws-ctx' },
    });
    const ws2Id = (ws2Res.json() as { id: string }).id;

    // Add inbox task to ws2
    const t2Res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${ws2Id}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'oth', title: 'WS2 task' },
    });
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, (t2Res.json() as { id: string }).id));

    // Context for workspaceId should not include ws2 data
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    const ctx = res.json() as ContextResponse;
    expect(ctx.inboxTasks).toHaveLength(0);
    expect(ctx.queueDepth['pending_dispatcher_action']).toBeUndefined();
  });
});
