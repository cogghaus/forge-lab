import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHub, type Hub } from '../app.js';
import { schema } from '@forge-lab/core';
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

async function setupAdmin(hub: Hub): Promise<{ cookie: string }> {
  await hub.fastify.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email: 'admin@example.com', password: 'password123' },
  });
  const loginRes = await hub.fastify.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'admin@example.com', password: 'password123' },
  });
  const setCookie = loginRes.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
  return { cookie };
}

async function registerDevice(
  hub: Hub,
  cookie: string,
  name: string,
): Promise<{ id: string; token: string }> {
  const res = await hub.fastify.inject({
    method: 'POST',
    url: '/devices',
    headers: { cookie },
    payload: { name, hostname: 'host', platform: 'win32' },
  });
  const body = res.json() as { id: string; token: string };
  return { id: body.id, token: body.token };
}

async function createTask(hub: Hub, cookie: string): Promise<string> {
  const res = await hub.fastify.inject({
    method: 'POST',
    url: '/tasks',
    headers: { cookie },
    payload: { projectPrefix: 'fl', title: 'Test task' },
  });
  const body = res.json() as { id: string };
  return body.id;
}

async function createWorkspace(hub: Hub, cookie: string): Promise<string> {
  const res = await hub.fastify.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { cookie },
    payload: { name: 'Test WS', slug: 'test-ws' },
  });
  return (res.json() as { id: string }).id;
}

describe('/workspaces/:workspaceId/tasks', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  it('POST creates a task scoped to the workspace', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ws', title: 'Workspace task' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    expect(id).toBe('ws-001');

    const task = await hub.db
      .select({ workspaceId: schema.tasks.workspaceId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    expect(task?.workspaceId).toBe(workspaceId);
  });

  it('GET lists only tasks for that workspace', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ws', title: 'WS task 1' },
    });
    await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'Flat task' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { tasks } = res.json() as { tasks: { id: string }[] };
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('ws-001');
  });

  it('POST requires workspace membership', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      payload: { projectPrefix: 'ws', title: 'No auth' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /tasks without workspaceId excludes workspace tasks', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ws', title: 'WS task' },
    });
    await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'Flat task' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/tasks',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { tasks } = res.json() as { tasks: { id: string }[] };
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain('fl-001');
    expect(ids).not.toContain('ws-001');
  });

  it('GET /tasks?workspaceId= returns only that workspace tasks', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ws', title: 'WS task' },
    });
    await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'Flat task' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks?workspaceId=${workspaceId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { tasks } = res.json() as { tasks: { id: string }[] };
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('ws-001');
  });
});

describe('/tasks/:id/claim', () => {
  let hub: Hub;
  let cookie: string;
  let device1: { id: string; token: string };
  let device2: { id: string; token: string };

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie } = await setupAdmin(hub));
    device1 = await registerDevice(hub, cookie, 'device-1');
    device2 = await registerDevice(hub, cookie, 'device-2');
  });

  afterEach(async () => {
    await hub.close();
  });

  it('device can claim a pending_agent task', async () => {
    const taskId = await createTask(hub, cookie);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${device1.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const task = await hub.db
      .select({ status: schema.tasks.status, assignedDeviceId: schema.tasks.assignedDeviceId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.status).toBe('in_progress');
    expect(task?.assignedDeviceId).toBe(device1.id);
  });

  it('cannot claim an in_progress task', async () => {
    const taskId = await createTask(hub, cookie);
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${device1.token}` },
    });
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${device2.token}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('cannot steal an assigned task from a different device', async () => {
    const taskId = await createTask(hub, cookie);
    await hub.db
      .update(schema.tasks)
      .set({ status: 'assigned', assignedDeviceId: device1.id })
      .where(eq(schema.tasks.id, taskId));

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${device2.token}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('device can re-claim its own assigned task', async () => {
    const taskId = await createTask(hub, cookie);
    await hub.db
      .update(schema.tasks)
      .set({ status: 'assigned', assignedDeviceId: device1.id })
      .where(eq(schema.tasks.id, taskId));

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${device1.token}` },
    });
    expect(res.statusCode).toBe(200);

    const task = await hub.db
      .select({ status: schema.tasks.status, assignedDeviceId: schema.tasks.assignedDeviceId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.status).toBe('in_progress');
    expect(task?.assignedDeviceId).toBe(device1.id);
  });

  it('concurrent claims from two devices: exactly one succeeds', async () => {
    const taskId = await createTask(hub, cookie);
    const [res1, res2] = await Promise.all([
      hub.fastify.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { authorization: `Bearer ${device1.token}` },
      }),
      hub.fastify.inject({
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
        headers: { authorization: `Bearer ${device2.token}` },
      }),
    ]);
    const statuses = [res1.statusCode, res2.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
  });

  it('returns 404 for a non-existent task', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks/fl-999/claim',
      headers: { authorization: `Bearer ${device1.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires device auth (user session returns 401)', async () => {
    const taskId = await createTask(hub, cookie);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});
