import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { schema } from '@forge-lab/core';
import { createHub, type Hub } from '../app.js';
import { createSession } from '../auth/sessions.js';
import { TEST_HUB_CONFIG, setupAdmin, createWorkspace } from '../test-utils.js';

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

describe('/workspaces routes', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
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
    const { id: ownerId, cookie } = await setupAdmin(hub);
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
    const { cookie } = await setupAdmin(hub);
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
    const { cookie } = await setupAdmin(hub);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'Bad', slug: 'Has Spaces' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /workspaces stores a repo binding and GET returns it', async () => {
    const { cookie } = await setupAdmin(hub);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: {
        name: 'HAL',
        slug: 'hal',
        repoUrl: 'https://github.com/sugar-crash-studios/hal.git',
        repoBranch: 'main',
      },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const getRes = await hub.fastify.inject({ method: 'GET', url: `/workspaces/${id}`, headers: { cookie } });
    const ws = getRes.json() as { repoUrl: string; repoBranch: string };
    expect(ws.repoUrl).toBe('https://github.com/sugar-crash-studios/hal.git');
    expect(ws.repoBranch).toBe('main');
  });

  it('POST /workspaces - 400 for a non-https repo URL', async () => {
    const { cookie } = await setupAdmin(hub);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'HAL', slug: 'hal', repoUrl: 'git@github.com:sugar-crash-studios/hal.git' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /workspaces/:workspaceId updates and clears the repo binding', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'repo-ws' });
    const patch = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
      payload: { repoUrl: 'https://github.com/sugar-crash-studios/hal', repoBranch: 'dev' },
    });
    expect(patch.statusCode).toBe(200);
    let ws = (await hub.fastify.inject({ method: 'GET', url: `/workspaces/${wsId}`, headers: { cookie } })).json() as { repoUrl: string | null };
    expect(ws.repoUrl).toBe('https://github.com/sugar-crash-studios/hal');

    const clear = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
      payload: { repoUrl: null },
    });
    expect(clear.statusCode).toBe(200);
    ws = (await hub.fastify.inject({ method: 'GET', url: `/workspaces/${wsId}`, headers: { cookie } })).json() as { repoUrl: string | null };
    expect(ws.repoUrl).toBeNull();
  });

  it('GET /workspaces lists only user memberships', async () => {
    const { cookie } = await setupAdmin(hub);
    const { cookie: cookieB } = await setupSecondUser(hub);

    await createWorkspace(hub, cookie, { slug: 'ws-owner' });
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
    const { cookie } = await setupAdmin(hub);
    await createWorkspace(hub, cookie, { slug: 'ws-a' });
    await createWorkspace(hub, cookie, { slug: 'ws-b' });
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
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'my-ws' });
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { slug: string }).slug).toBe('my-ws');
  });

  it('GET /workspaces/:workspaceId - 403 for non-member', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'priv-ws' });
    const { cookie: cookieB } = await setupSecondUser(hub);
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PATCH /workspaces/:workspaceId updates name and description', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'patch-ws' });
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

  it('PATCH /workspaces/:workspaceId archives and unarchives via status', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'arch-ws' });

    const archive = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
      payload: { status: 'archived' },
    });
    expect(archive.statusCode).toBe(200);
    let ws = (await hub.fastify.inject({ method: 'GET', url: `/workspaces/${wsId}`, headers: { cookie } })).json() as { status: string };
    expect(ws.status).toBe('archived');

    const unarchive = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
      payload: { status: 'active' },
    });
    expect(unarchive.statusCode).toBe(200);
    ws = (await hub.fastify.inject({ method: 'GET', url: `/workspaces/${wsId}`, headers: { cookie } })).json() as { status: string };
    expect(ws.status).toBe('active');
  });

  it('PATCH /workspaces/:workspaceId - 400 for invalid status', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'badstatus-ws' });
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
      payload: { status: 'deleted' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /workspaces/:workspaceId - 400 when no fields sent', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'patch-ws' });
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH /workspaces/:workspaceId - 403 for collaborator', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'patch-ws' });
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
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'del-ws' });
    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });

  it('DELETE /workspaces/:workspaceId - 403 for admin (not owner)', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'del-ws' });
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
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'mem-ws' });
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
    const { cookie, id: ownerId } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'mem-ws' });

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
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'mem-ws' });

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsId}/members`,
      headers: { cookie },
      payload: { userId: 'does-not-exist', role: 'viewer' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /workspaces/:workspaceId/members/:userId removes member', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'mem-ws' });
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
    const { cookie, id: ownerId } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'mem-ws' });

    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: `/workspaces/${wsId}/members/${ownerId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('cannot_remove_owner');
  });

  it('DELETE /workspaces/:workspaceId/members/:userId - 404 for nonexistent member', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'mem-ws' });

    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: `/workspaces/${wsId}/members/no-such-user`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /workspaces excludes soft-deleted workspaces from list', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'del-list' });
    await hub.fastify.inject({ method: 'DELETE', url: `/workspaces/${wsId}`, headers: { cookie } });
    const res = await hub.fastify.inject({ method: 'GET', url: '/workspaces', headers: { cookie } });
    const { workspaces } = res.json() as { workspaces: unknown[] };
    expect(workspaces).toHaveLength(0);
  });

  it('GET /workspaces/:workspaceId returns 404 after soft-delete', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'dead-ws' });
    await hub.fastify.inject({ method: 'DELETE', url: `/workspaces/${wsId}`, headers: { cookie } });
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /workspaces/:workspaceId/members returns 404 after soft-delete', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'dead-mem' });
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
    const { cookie, id: ownerId } = await setupAdmin(hub);
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
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'shared-ws' });
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
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'act-priv' });
    const { cookie: cookieB } = await setupSecondUser(hub);
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${wsId}/activity`,
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /workspaces/:workspaceId/activity returns task history with task title', async () => {
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'act-ws' });

    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'act', title: 'Activity task' },
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
    const { cookie } = await setupAdmin(hub);
    const wsId = await createWorkspace(hub, cookie, { slug: 'act-ws-a' });
    const wsIdB = await createWorkspace(hub, cookie, { slug: 'act-ws-b' });

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${wsIdB}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'oth', title: 'Other workspace task' },
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
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
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

  it('returns 403 for worker-type device (non-orchestrator)', async () => {
    const workerRes = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'architect-daemon', agentId: 'architect', deviceType: 'worker' },
    });
    const workerToken = (workerRes.json() as { token: string }).token;

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { authorization: `Bearer ${workerToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('orchestrator_required');
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

    // Unrouted workspace tasks now default to pending_dispatcher_action, so move
    // the "normal" task out of the inbox to prove only inbox-status tasks appear.
    const normalRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ctx', title: 'Normal task' },
    });
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_agent' })
      .where(eq(schema.tasks.id, (normalRes.json() as { id: string }).id));

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

  it('queueDepth counts pending_agent tasks per assignedAgentId (not by status)', async () => {
    // Create 2 tasks assigned to 'architect' and 1 assigned to 'furnace'
    for (let i = 0; i < 2; i++) {
      const r = await hub.fastify.inject({
        method: 'POST',
        url: `/workspaces/${workspaceId}/tasks`,
        headers: { cookie },
        payload: { projectPrefix: 'qd', title: `Architect task ${i}` },
      });
      await hub.db
        .update(schema.tasks)
        .set({ status: 'pending_agent', assignedAgentId: 'architect' })
        .where(eq(schema.tasks.id, (r.json() as { id: string }).id));
    }
    const furnaceRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'qd', title: 'Furnace task' },
    });
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_agent', assignedAgentId: 'furnace' })
      .where(eq(schema.tasks.id, (furnaceRes.json() as { id: string }).id));

    // Create an in_progress task — should NOT appear in queueDepth
    const inProgressRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'qd', title: 'Running task' },
    });
    await hub.db
      .update(schema.tasks)
      .set({ status: 'in_progress', assignedAgentId: 'architect' })
      .where(eq(schema.tasks.id, (inProgressRes.json() as { id: string }).id));

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    const ctx = res.json() as ContextResponse;
    // Only pending_agent tasks counted; in_progress excluded
    expect(ctx.queueDepth['architect']).toBe(2);
    expect(ctx.queueDepth['furnace']).toBe(1);
    // Status keys should NOT appear — queueDepth is per-agentId, not per-status
    expect(ctx.queueDepth['in_progress']).toBeUndefined();
    expect(ctx.queueDepth['pending_agent']).toBeUndefined();
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

  it('dispatcherHistory surfaces taskComments with authorType=dispatcher (workspace-scoped)', async () => {
    // Create a workspace task so the comment can be workspace-scoped
    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dh', title: 'Dispatcher task' },
    });
    const taskId = (taskRes.json() as { id: string }).id;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, taskId));

    // Post a dispatcher comment via FM device
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/comments`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { body: 'Decision: ROUTED\nAgent: architect\nReason: Pure architecture task.\nConfidence: HIGH', authorType: 'dispatcher' },
    });

    // Context should include the dispatcher comment in dispatcherHistory
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    const ctx = res.json() as ContextResponse;
    expect(ctx.dispatcherHistory).toHaveLength(1);
    const comment = ctx.dispatcherHistory[0] as { authorType: string; body: string };
    expect(comment.authorType).toBe('dispatcher');
    expect(comment.body).toContain('ROUTED');
  });

  it('dispatcherHistory is workspace-scoped (other workspace comments excluded)', async () => {
    // Create task in another workspace with no FM access
    const ws2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'Other WS DH', slug: 'other-ws-dh' },
    });
    const ws2Id = (ws2Res.json() as { id: string }).id;
    const t2 = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${ws2Id}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dh', title: 'Other WS task' },
    });
    const t2Id = (t2.json() as { id: string }).id;

    // Post dispatcher comment on the other-workspace task
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${t2Id}/comments`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { body: 'Decision: ROUTED\nAgent: furnace', authorType: 'dispatcher' },
    });

    // Context for workspaceId should have 0 dispatcherHistory (comment is in ws2)
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    const ctx = res.json() as ContextResponse;
    expect(ctx.dispatcherHistory).toHaveLength(0);
  });

  it('goals excludes archived and cancelled goals', async () => {
    // Create active goal
    const activeRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/goals`,
      headers: { cookie },
      payload: { title: 'Active goal' },
    });
    const activeGoalId = (activeRes.json() as { id: string }).id;

    // Create a second goal then mark it completed (inactive)
    const completedRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/goals`,
      headers: { cookie },
      payload: { title: 'Completed goal' },
    });
    const completedGoalId = (completedRes.json() as { id: string }).id;
    await hub.db
      .update(schema.goals)
      .set({ status: 'completed' })
      .where(eq(schema.goals.id, completedGoalId));

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    const ctx = res.json() as ContextResponse;
    const goalIds = (ctx.goals as { id: string }[]).map((g) => g.id);
    expect(goalIds).toContain(activeGoalId);
    expect(goalIds).not.toContain(completedGoalId);
  });

  it('liveInstances excludes stopped and crashed instances', async () => {
    // Create agent + stopped instance directly in DB
    const agentId = nanoid();
    await hub.db.insert(schema.agents).values({
      id: agentId,
      workspaceId,
      name: 'architect',
      personality: 'You are architect.',
      runtimeId: 'background',
      config: {},
    });
    const devRes = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'arch-dev', agentId: 'architect', deviceType: 'worker' },
    });
    const deviceId = (devRes.json() as { id: string }).id;

    // Running instance
    const runningId = nanoid();
    await hub.db.insert(schema.agentInstances).values({
      id: runningId,
      workspaceId,
      agentId,
      deviceId,
      status: 'running',
    });

    // Stopped instance
    await hub.db.insert(schema.agentInstances).values({
      id: nanoid(),
      workspaceId,
      agentId,
      deviceId,
      status: 'stopped',
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/context`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    const ctx = res.json() as ContextResponse;
    const instanceIds = (ctx.liveInstances as { id: string }[]).map((i) => i.id);
    expect(instanceIds).toContain(runningId);
    expect(instanceIds).toHaveLength(1); // stopped instance excluded
  });
});

// ---------------------------------------------------------------------------
// GET /workspaces/:workspaceId/dispatcher-log — FM triage dashboard feed
// ---------------------------------------------------------------------------

type DispatcherLogResponse = {
  comments: { id: string; taskId: string; taskTitle: string; body: string; authorId: string; createdAt: string }[];
  inboxCount: number;
};

describe('GET /workspaces/:workspaceId/dispatcher-log', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;
  let fmToken: string;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);

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

  it('returns 401 for unauthenticated requests', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/dispatcher-log`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns empty comments and inboxCount=0 for fresh workspace', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/dispatcher-log`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DispatcherLogResponse;
    expect(body.comments).toHaveLength(0);
    expect(body.inboxCount).toBe(0);
  });

  it('inboxCount reflects pending_dispatcher_action tasks in workspace', async () => {
    const t1 = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dl', title: 'Inbox task 1' },
    });
    const t2 = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dl', title: 'Inbox task 2' },
    });
    const id1 = (t1.json() as { id: string }).id;
    const id2 = (t2.json() as { id: string }).id;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, id1));
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, id2));

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/dispatcher-log`,
      headers: { cookie },
    });
    const body = res.json() as DispatcherLogResponse;
    expect(body.inboxCount).toBe(2);
  });

  it('returns dispatcher comments with taskTitle from join', async () => {
    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dl', title: 'Design the API' },
    });
    const taskId = (taskRes.json() as { id: string }).id;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, taskId));

    // Post dispatcher comment via FM device
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/comments`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: {
        body: 'Decision: ROUTED\nAgent: architect\nReason: ADR task.\nConfidence: HIGH',
        authorType: 'dispatcher',
      },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/dispatcher-log`,
      headers: { cookie },
    });
    const body = res.json() as DispatcherLogResponse;
    expect(body.comments).toHaveLength(1);
    const comment = body.comments[0]!;
    expect(comment.taskId).toBe(taskId);
    expect(comment.taskTitle).toBe('Design the API');
    expect(comment.body).toContain('ROUTED');
  });

  it('excludes non-dispatcher comments (agent, user, system)', async () => {
    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dl', title: 'Noisy task' },
    });
    const taskId = (taskRes.json() as { id: string }).id;

    // Post a user comment (not dispatcher)
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/comments`,
      headers: { cookie },
      payload: { body: 'User note here' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/dispatcher-log`,
      headers: { cookie },
    });
    const body = res.json() as DispatcherLogResponse;
    // User comments should not appear in dispatcher log
    expect(body.comments).toHaveLength(0);
  });

  it('excludes comments from other workspaces', async () => {
    // Create another workspace and task + dispatcher comment there
    const ws2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'Other WS Log', slug: 'other-ws-log' },
    });
    const ws2Id = (ws2Res.json() as { id: string }).id;
    const t2Res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${ws2Id}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dl', title: 'Other WS task' },
    });
    const t2Id = (t2Res.json() as { id: string }).id;
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${t2Id}/comments`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { body: 'Decision: ROUTED\nAgent: furnace', authorType: 'dispatcher' },
    });

    // dispatcher-log for workspaceId should be empty (comment is in ws2)
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/dispatcher-log`,
      headers: { cookie },
    });
    const body = res.json() as DispatcherLogResponse;
    expect(body.comments).toHaveLength(0);
  });
});
