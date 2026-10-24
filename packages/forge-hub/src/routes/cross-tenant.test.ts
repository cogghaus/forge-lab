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

describe('cross-tenant: orchestrator device routes on another workspace', () => {
  let hub: Hub;
  let f: Fixture;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    f = await setupFixture(hub);
  });

  afterEach(async () => {
    await hub.close();
  });

  async function makeStale(): Promise<void> {
    await hub.db
      .update(schema.tasks)
      .set({ status: 'assigned', assignedAgentId: 'architect', assignedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(schema.tasks.id, f.wsTaskId));
  }

  it('outsider FM cannot read the workspace context bundle (403)', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${f.workspaceId}/context`,
      headers: bearer(f.outsiderFmToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it('outsider FM cannot assign a task in the workspace (403, task untouched)', async () => {
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${f.workspaceId}/tasks/${f.wsTaskId}/assign`,
      headers: bearer(f.outsiderFmToken),
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(403);
    expect((await taskRow(hub, f.wsTaskId))?.status).toBe('pending_agent');
  });

  it('outsider FM cannot list stale assigned tasks (403)', async () => {
    await makeStale();
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${f.workspaceId}/tasks/stale-assigned`,
      headers: bearer(f.outsiderFmToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('PRIVATE-WS-TASK');
  });

  it('outsider FM cannot requeue stale tasks (403, task untouched)', async () => {
    await makeStale();
    for (const path of ['stale-assigned/requeue', 'stale-phase/requeue']) {
      const res = await hub.fastify.inject({
        method: 'POST',
        url: `/workspaces/${f.workspaceId}/tasks/${path}`,
        headers: bearer(f.outsiderFmToken),
      });
      expect(res.statusCode).toBe(403);
    }
    expect((await taskRow(hub, f.wsTaskId))?.status).toBe('assigned');
  });

  it('owner\'s FM reads context, assigns and requeues (positive control)', async () => {
    const ctx = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${f.workspaceId}/context`,
      headers: bearer(f.ownerFmToken),
    });
    expect(ctx.statusCode).toBe(200);
    const assign = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${f.workspaceId}/tasks/${f.wsTaskId}/assign`,
      headers: bearer(f.ownerFmToken),
      payload: { agentId: 'architect' },
    });
    expect(assign.statusCode).toBe(200);
    await makeStale();
    const requeue = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${f.workspaceId}/tasks/stale-assigned/requeue`,
      headers: bearer(f.ownerFmToken),
    });
    expect(requeue.json()).toEqual({ requeued: 1 });
  });
});

describe('cross-tenant: task instructions', () => {
  let hub: Hub;
  let f: Fixture;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    f = await setupFixture(hub);
  });

  afterEach(async () => {
    await hub.close();
  });

  async function instructionRows(taskId: string) {
    return hub.db.select().from(schema.taskInstructions).where(eq(schema.taskInstructions.taskId, taskId));
  }

  async function postInstruction(headers: Record<string, string>, taskId: string) {
    return hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/instructions`,
      headers,
      payload: { priority: 'stop', body: 'PRIVATE-INSTRUCTION' },
    });
  }

  it('outsider user cannot send stop/redirect to another tenant\'s task (403, nothing inserted)', async () => {
    for (const id of [f.wsTaskId, f.unscopedTaskId]) {
      const res = await postInstruction({ cookie: f.outsiderCookie }, id);
      expect(res.statusCode).toBe(403);
      expect(await instructionRows(id)).toHaveLength(0);
    }
  });

  it('workspace viewer cannot send instructions (403 insufficient_role)', async () => {
    const { cookie } = await setupUser(hub, f.adminCookie, {
      email: 'viewer@example.com',
      workspaceId: f.workspaceId,
      workspaceRole: 'viewer',
    });
    const res = await postInstruction({ cookie }, f.wsTaskId);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'insufficient_role' });
  });

  it('outsider user and outsider device cannot read or ack instructions (403)', async () => {
    const created = await postInstruction({ cookie: f.adminCookie }, f.wsTaskId);
    expect(created.statusCode).toBe(201);
    const { id: instrId } = created.json() as { id: string };

    for (const headers of [{ cookie: f.outsiderCookie }, bearer(f.outsiderWorkerToken)]) {
      const list = await hub.fastify.inject({ method: 'GET', url: `/tasks/${f.wsTaskId}/instructions`, headers });
      expect(list.statusCode).toBe(403);
      expect(list.body).not.toContain('PRIVATE-INSTRUCTION');
      const ack = await hub.fastify.inject({
        method: 'POST',
        url: `/tasks/${f.wsTaskId}/instructions/${instrId}/ack`,
        headers,
      });
      expect(ack.statusCode).toBe(403);
    }
    const [row] = await instructionRows(f.wsTaskId);
    expect(row?.acknowledgedAt).toBeNull();
  });

  it('owner sends, owner\'s worker reads and acks (positive control)', async () => {
    const created = await postInstruction({ cookie: f.adminCookie }, f.unscopedTaskId);
    expect(created.statusCode).toBe(201);
    const { id: instrId } = created.json() as { id: string };
    const list = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${f.unscopedTaskId}/instructions`,
      headers: bearer(f.ownerWorkerToken),
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('PRIVATE-INSTRUCTION');
    const ack = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${f.unscopedTaskId}/instructions/${instrId}/ack`,
      headers: bearer(f.ownerWorkerToken),
    });
    expect(ack.statusCode).toBe(200);
  });
});

describe('cross-tenant: task comments', () => {
  let hub: Hub;
  let f: Fixture;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    f = await setupFixture(hub);
  });

  afterEach(async () => {
    await hub.close();
  });

  async function commentRows(taskId: string) {
    return hub.db.select().from(schema.taskComments).where(eq(schema.taskComments.taskId, taskId));
  }

  async function postComment(headers: Record<string, string>, taskId: string, body = 'INJECTED-COMMENT') {
    return hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/comments`,
      headers,
      payload: { body, authorType: 'dispatcher' },
    });
  }

  it('outsider user and outsider FM cannot comment on another tenant\'s task (403, nothing inserted)', async () => {
    for (const headers of [{ cookie: f.outsiderCookie }, bearer(f.outsiderFmToken)]) {
      for (const id of [f.wsTaskId, f.unscopedTaskId]) {
        const res = await postComment(headers, id);
        expect(res.statusCode).toBe(403);
        expect(await commentRows(id)).toHaveLength(0);
      }
    }
  });

  it('workspace viewer cannot comment (403 insufficient_role)', async () => {
    const { cookie } = await setupUser(hub, f.adminCookie, {
      email: 'viewer@example.com',
      workspaceId: f.workspaceId,
      workspaceRole: 'viewer',
    });
    const res = await postComment({ cookie }, f.wsTaskId);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'insufficient_role' });
  });

  it('outsider user and outsider device cannot read comments (403)', async () => {
    expect((await postComment({ cookie: f.adminCookie }, f.wsTaskId, 'PRIVATE-COMMENT')).statusCode).toBe(201);
    for (const headers of [{ cookie: f.outsiderCookie }, bearer(f.outsiderWorkerToken)]) {
      const res = await hub.fastify.inject({ method: 'GET', url: `/tasks/${f.wsTaskId}/comments`, headers });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('PRIVATE-COMMENT');
    }
  });

  it('owner and owner\'s FM comment, owner\'s worker reads (positive control)', async () => {
    expect((await postComment({ cookie: f.adminCookie }, f.wsTaskId, 'PRIVATE-COMMENT')).statusCode).toBe(201);
    expect((await postComment(bearer(f.ownerFmToken), f.wsTaskId, 'FM-COMMENT')).statusCode).toBe(201);
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${f.wsTaskId}/comments`,
      headers: bearer(f.ownerWorkerToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('PRIVATE-COMMENT');
    expect(res.body).toContain('FM-COMMENT');
  });
});

describe('cross-tenant: /ws event stream', () => {
  type Socket = Awaited<ReturnType<Hub['fastify']['injectWS']>>;
  interface Received {
    name?: string;
    error?: string;
    payload?: { taskId?: string };
  }

  let hub: Hub;
  let f: Fixture;
  const open: Socket[] = [];

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    f = await setupFixture(hub);
    await hub.fastify.ready();
  });

  afterEach(async () => {
    for (const s of open.splice(0)) s.terminate();
    await hub.close();
  });

  async function connect(token: string): Promise<{ messages: Received[]; closed: Promise<void> }> {
    const messages: Received[] = [];
    let onClose: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      onClose = resolve;
    });
    const socket = await hub.fastify.injectWS(`/ws?token=${encodeURIComponent(token)}`, {}, {
      onInit: (ws) => {
        ws.on('message', (data) => messages.push(JSON.parse(String(data)) as Received));
        ws.on('close', () => onClose());
      },
    });
    open.push(socket);
    return { messages, closed };
  }

  async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for websocket message');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function taskEvents(messages: Received[]): string[] {
    return messages.filter((m) => m.name === 'task.created').map((m) => m.payload?.taskId ?? '');
  }

  it('an outsider device receives only events for tasks its owner can see', async () => {
    const owner = await connect(f.ownerWorkerToken);
    const outsider = await connect(f.outsiderWorkerToken);

    const wsRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${f.workspaceId}/tasks`,
      headers: { cookie: f.adminCookie },
      payload: { projectPrefix: 'ws', title: 'Second workspace task' },
    });
    const ownerWsTask = (wsRes.json() as { id: string }).id;
    const ownerUnscoped = await createTask(hub, f.adminCookie, { projectPrefix: 'fl', title: 'Second unscoped' });
    // The outsider's own task. Delivery is ordered per socket, so once this
    // arrives every earlier event has already been filtered.
    const outsiderTask = await createTask(hub, f.outsiderCookie, { projectPrefix: 'ot', title: 'Outsider task' });
    // Same role for the owner's socket: its arrival means outsiderTask was filtered.
    const ownerSentinel = await createTask(hub, f.adminCookie, { projectPrefix: 'fl', title: 'Sentinel' });

    await until(() => taskEvents(outsider.messages).includes(outsiderTask));
    expect(taskEvents(outsider.messages)).toEqual([outsiderTask]);

    await until(() => taskEvents(owner.messages).includes(ownerSentinel));
    expect(taskEvents(owner.messages)).toEqual([ownerWsTask, ownerUnscoped, ownerSentinel]);
  });

  it('a deregistered device token is rejected', async () => {
    const devices = await hub.fastify.inject({ method: 'GET', url: '/devices', headers: { cookie: f.outsiderCookie } });
    const { devices: list } = devices.json() as { devices: { id: string; name: string }[] };
    const worker = list.find((d) => d.name === 'outsider-worker');
    const del = await hub.fastify.inject({
      method: 'DELETE',
      url: `/devices/${worker?.id ?? ''}`,
      headers: { cookie: f.outsiderCookie },
    });
    expect(del.statusCode).toBeLessThan(300);

    const conn = await connect(f.outsiderWorkerToken);
    await until(() => conn.messages.length > 0);
    expect(conn.messages[0]).toEqual({ error: 'unauthorized' });
    await conn.closed;
  });
});
