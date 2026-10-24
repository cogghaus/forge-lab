/**
 * Cross-tenant access control for routes addressed by task id or workspace id.
 *
 * Any logged-in user can register a device of any type (POST /devices), so a
 * device token proves nothing about which workspaces its holder may touch. A
 * caller is authorized through its user: the session user, or the device's
 * owner. Workspace tasks need membership (collaborator for writes); unscoped
 * tasks belong to their creator (see auth/task-owner.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@forge-lab/core';
import { createHub, type Hub } from '../app.js';
import { TEST_HUB_CONFIG, setupAdmin, setupUser, registerDevice, createTask, createWorkspace } from '../test-utils.js';

interface Fixture {
  adminCookie: string;
  workspaceId: string;
  /** Workspace task owned by the admin's workspace, status pending_agent, unrouted. */
  wsTaskId: string;
  /** Unscoped task created by the admin, status pending_agent, unrouted. */
  unscopedTaskId: string;
  ownerWorkerToken: string;
  ownerFmToken: string;
  outsiderCookie: string;
  outsiderWorkerToken: string;
  outsiderFmToken: string;
}

async function setupFixture(hub: Hub): Promise<Fixture> {
  const { cookie: adminCookie } = await setupAdmin(hub);
  const workspaceId = await createWorkspace(hub, adminCookie, { slug: 'tenant-a' });
  const wsRes = await hub.fastify.inject({
    method: 'POST',
    url: `/workspaces/${workspaceId}/tasks`,
    headers: { cookie: adminCookie },
    payload: { projectPrefix: 'ws', title: 'PRIVATE-WS-TASK' },
  });
  const wsTaskId = (wsRes.json() as { id: string }).id;
  // Unrouted pending_agent: claimable by any worker that passes authorization.
  await hub.db
    .update(schema.tasks)
    .set({ status: 'pending_agent', assignedAgentId: null })
    .where(eq(schema.tasks.id, wsTaskId));
  const unscopedTaskId = await createTask(hub, adminCookie, { projectPrefix: 'fl', title: 'PRIVATE-UNSCOPED-TASK' });

  const { token: ownerWorkerToken } = await registerDevice(hub, adminCookie, 'owner-worker');
  const { token: ownerFmToken } = await registerDevice(hub, adminCookie, 'owner-fm', {
    agentId: 'forge-master',
    deviceType: 'orchestrator',
  });

  const { cookie: outsiderCookie } = await setupUser(hub, adminCookie, { email: 'outsider@example.com' });
  const { token: outsiderWorkerToken } = await registerDevice(hub, outsiderCookie, 'outsider-worker');
  const { token: outsiderFmToken } = await registerDevice(hub, outsiderCookie, 'outsider-fm', {
    agentId: 'forge-master',
    deviceType: 'orchestrator',
  });

  return {
    adminCookie,
    workspaceId,
    wsTaskId,
    unscopedTaskId,
    ownerWorkerToken,
    ownerFmToken,
    outsiderCookie,
    outsiderWorkerToken,
    outsiderFmToken,
  };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function taskRow(hub: Hub, id: string) {
  return hub.db
    .select({ status: schema.tasks.status, assignedDeviceId: schema.tasks.assignedDeviceId })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, id))
    .get();
}

describe('cross-tenant: GET /tasks/:id and /tasks/:id/history', () => {
  let hub: Hub;
  let f: Fixture;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    f = await setupFixture(hub);
  });

  afterEach(async () => {
    await hub.close();
  });

  it('outsider user and outsider devices cannot read a workspace task (403)', async () => {
    for (const headers of [{ cookie: f.outsiderCookie }, bearer(f.outsiderWorkerToken), bearer(f.outsiderFmToken)]) {
      const res = await hub.fastify.inject({ method: 'GET', url: `/tasks/${f.wsTaskId}`, headers });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('PRIVATE-WS-TASK');
    }
  });

  it('outsider cannot read another user\'s unscoped task (403)', async () => {
    for (const headers of [{ cookie: f.outsiderCookie }, bearer(f.outsiderWorkerToken)]) {
      const res = await hub.fastify.inject({ method: 'GET', url: `/tasks/${f.unscopedTaskId}`, headers });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('PRIVATE-UNSCOPED-TASK');
    }
  });

  it('outsider cannot read a task\'s history (403)', async () => {
    for (const id of [f.wsTaskId, f.unscopedTaskId]) {
      const res = await hub.fastify.inject({
        method: 'GET',
        url: `/tasks/${id}/history`,
        headers: bearer(f.outsiderWorkerToken),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('owner\'s devices read both tasks and their history (positive control)', async () => {
    for (const id of [f.wsTaskId, f.unscopedTaskId]) {
      const task = await hub.fastify.inject({ method: 'GET', url: `/tasks/${id}`, headers: bearer(f.ownerWorkerToken) });
      expect(task.statusCode).toBe(200);
      const history = await hub.fastify.inject({
        method: 'GET',
        url: `/tasks/${id}/history`,
        headers: bearer(f.ownerWorkerToken),
      });
      expect(history.statusCode).toBe(200);
    }
  });

  it('missing task is still 404', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/tasks/zz-999', headers: bearer(f.ownerWorkerToken) });
    expect(res.statusCode).toBe(404);
  });
});

describe('cross-tenant: POST /tasks/:id/claim', () => {
  let hub: Hub;
  let f: Fixture;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    f = await setupFixture(hub);
  });

  afterEach(async () => {
    await hub.close();
  });

  it('outsider worker cannot claim a workspace task (403, task untouched)', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${f.wsTaskId}/claim`,
      headers: bearer(f.outsiderWorkerToken),
    });
    expect(res.statusCode).toBe(403);
    expect(await taskRow(hub, f.wsTaskId)).toEqual({ status: 'pending_agent', assignedDeviceId: null });
  });

  it('outsider worker cannot claim another user\'s unscoped task (403)', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${f.unscopedTaskId}/claim`,
      headers: bearer(f.outsiderWorkerToken),
    });
    expect(res.statusCode).toBe(403);
    expect(await taskRow(hub, f.unscopedTaskId)).toEqual({ status: 'pending_agent', assignedDeviceId: null });
  });

  it('worker owned by a workspace viewer cannot claim (403 insufficient_role)', async () => {
    const { cookie } = await setupUser(hub, f.adminCookie, {
      email: 'viewer@example.com',
      workspaceId: f.workspaceId,
      workspaceRole: 'viewer',
    });
    const { token } = await registerDevice(hub, cookie, 'viewer-worker');
    const res = await hub.fastify.inject({ method: 'POST', url: `/tasks/${f.wsTaskId}/claim`, headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'insufficient_role' });
  });

  it('owner\'s worker claims both tasks (positive control)', async () => {
    for (const id of [f.wsTaskId, f.unscopedTaskId]) {
      const res = await hub.fastify.inject({ method: 'POST', url: `/tasks/${id}/claim`, headers: bearer(f.ownerWorkerToken) });
      expect(res.statusCode).toBe(200);
    }
  });
});
