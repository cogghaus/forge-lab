import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
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

  it('POST with special-char projectPrefix returns 400', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'a!', title: 'Bad prefix' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST with uppercase projectPrefix returns 400', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'FL', title: 'Uppercase prefix' },
    });
    expect(res.statusCode).toBe(400);
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

  it('workspace task sequence continues from flat task with same prefix', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'Flat first' },
    });
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'WS second' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { id: string }).id).toBe('fl-002');
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

describe('X-Forge-Run-Id header', () => {
  let hub: Hub;
  let cookie: string;
  let deviceToken: string;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie } = await setupAdmin(hub));
    ({ token: deviceToken } = await registerDevice(hub, cookie, 'run-device'));
  });
  afterEach(async () => { await hub.close(); });

  it('runId is recorded in task history when X-Forge-Run-Id header is present', async () => {
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie, 'x-forge-run-id': 'run-abc-123' },
      payload: { projectPrefix: 'fl', title: 'Run test task' },
    });
    expect(createRes.statusCode).toBe(201);
    const { id } = createRes.json() as { id: string };

    const histRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${id}/history`,
      headers: { cookie },
    });
    const { history } = histRes.json() as { history: { payload: unknown }[] };
    expect(history.length).toBeGreaterThan(0);
    const payload = history[0]?.payload as Record<string, unknown>;
    expect(payload?.['runId']).toBe('run-abc-123');
  });

  it('runId is omitted from history when header is absent', async () => {
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'No run task' },
    });
    const { id } = createRes.json() as { id: string };

    const histRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${id}/history`,
      headers: { cookie },
    });
    const { history } = histRes.json() as { history: { payload: unknown }[] };
    const payload = history[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.['runId']).toBeUndefined();
  });

  it('runId is recorded when device claims a task', async () => {
    const taskId = await createTask(hub, cookie);
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${deviceToken}`, 'x-forge-run-id': 'run-claim-99' },
    });

    const histRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/history`,
      headers: { cookie },
    });
    const { history } = histRes.json() as { history: { eventName: string; payload: unknown }[] };
    const claimEntry = history.find((h) => h.eventName === 'task.claimed');
    const payload = claimEntry?.payload as Record<string, unknown> | undefined;
    expect(payload?.['runId']).toBe('run-claim-99');
  });
});

describe('PATCH /workspaces/:workspaceId/tasks/:taskId', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  beforeEach(async () => {
    hub = await createHub({ config: testConfig });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  async function createWsTask(title = 'My task'): Promise<string> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ws', title },
    });
    return (res.json() as { id: string }).id;
  }

  it('cancels a pending_agent task', async () => {
    const taskId = await createWsTask();
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}`,
      headers: { cookie },
      payload: { status: 'cancelled' },
    });
    expect(res.statusCode).toBe(200);
    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('cancelled');
  });

  it('records task.cancelled history event', async () => {
    const taskId = await createWsTask();
    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}`,
      headers: { cookie },
      payload: { status: 'cancelled' },
    });
    const histRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/history`,
      headers: { cookie },
    });
    const { history } = histRes.json() as { history: { eventName: string }[] };
    expect(history.some((h) => h.eventName === 'task.cancelled')).toBe(true);
  });

  it('requeues a cancelled task to pending_agent', async () => {
    const taskId = await createWsTask();
    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}`,
      headers: { cookie },
      payload: { status: 'cancelled' },
    });
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}`,
      headers: { cookie },
      payload: { status: 'pending_agent' },
    });
    expect(res.statusCode).toBe(200);
    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('pending_agent');
  });

  it('requeues a failed task to pending_agent', async () => {
    const taskId = await createWsTask();
    await hub.db.update(schema.tasks).set({ status: 'failed' }).where(eq(schema.tasks.id, taskId));
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}`,
      headers: { cookie },
      payload: { status: 'pending_agent' },
    });
    expect(res.statusCode).toBe(200);
    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('pending_agent');
  });

  it('returns 422 for invalid transition (pending_agent -> pending_agent)', async () => {
    const taskId = await createWsTask();
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}`,
      headers: { cookie },
      payload: { status: 'pending_agent' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('invalid_transition');
  });

  it('returns 422 for invalid transition (completed -> cancelled)', async () => {
    const taskId = await createWsTask();
    await hub.db.update(schema.tasks).set({ status: 'completed' }).where(eq(schema.tasks.id, taskId));
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}`,
      headers: { cookie },
      payload: { status: 'cancelled' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 404 for task in a different workspace', async () => {
    const ws2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'WS2', slug: 'ws2-patch' },
    });
    const ws2Id = (ws2Res.json() as { id: string }).id;
    const taskId = await createWsTask();
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${ws2Id}/tasks/${taskId}`,
      headers: { cookie },
      payload: { status: 'cancelled' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const taskId = await createWsTask();
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}`,
      payload: { status: 'cancelled' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('CX-01 regression: concurrent cancel requests produce at most one history event', async () => {
    // The PATCH UPDATE WHERE now includes eq(status, readStatus) so a second concurrent
    // cancel sees 0 rows (status already changed to cancelled) and returns 409 instead of
    // silently writing a duplicate task.cancelled history event.
    const taskId = await createWsTask();

    const [res1, res2] = await Promise.all([
      hub.fastify.inject({
        method: 'PATCH',
        url: `/workspaces/${workspaceId}/tasks/${taskId}`,
        headers: { cookie },
        payload: { status: 'cancelled' },
      }),
      hub.fastify.inject({
        method: 'PATCH',
        url: `/workspaces/${workspaceId}/tasks/${taskId}`,
        headers: { cookie },
        payload: { status: 'cancelled' },
      }),
    ]);

    // Exactly one request must succeed; the other gets 409 (race detected) or 422 (serial execution
    // where second request read the already-cancelled status).
    const codes = [res1.statusCode, res2.statusCode].sort((a, b) => a - b);
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBeGreaterThanOrEqual(409);

    // Final status must be cancelled regardless.
    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('cancelled');

    // No duplicate task.cancelled history events (the core invariant the fix protects).
    const histRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/history`,
      headers: { cookie },
    });
    const { history } = histRes.json() as { history: { eventName: string }[] };
    const cancelEvents = history.filter((h) => h.eventName === 'task.cancelled');
    expect(cancelEvents).toHaveLength(1);
  });
});

describe('task goalId linking', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  async function createGoal(title: string): Promise<string> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/goals`,
      headers: { cookie },
      payload: { title },
    });
    return (res.json() as { id: string }).id;
  }

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie } = await setupAdmin(hub));
    const wsRes = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'Goal WS', slug: 'gwws' },
    });
    workspaceId = (wsRes.json() as { id: string }).id;
  });

  afterEach(async () => {
    await hub.close();
  });

  it('task created with goalId persists the link', async () => {
    const goalId = await createGoal('Ship v1');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'gw', title: 'Linked task', goalId },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const task = await hub.db
      .select({ goalId: schema.tasks.goalId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    expect(task?.goalId).toBe(goalId);
  });

  it('task created without goalId has null goalId', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'gw', title: 'Unlinked task' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const task = await hub.db
      .select({ goalId: schema.tasks.goalId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    expect(task?.goalId).toBeNull();
  });

  it('CX-01: empty string goalId is normalized to null, not stored as ""', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'gw', title: 'Empty goal string', goalId: '' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const task = await hub.db
      .select({ goalId: schema.tasks.goalId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    expect(task?.goalId).toBeNull();
  });

  it('returns 404 when goalId does not exist in workspace', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'gw', title: 'Bad goal', goalId: 'nonexistent-goal-id' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('goal_not_found');
  });

  it('returns 404 when goalId belongs to a different workspace', async () => {
    const ws2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'Other WS', slug: 'owws' },
    });
    const ws2Id = (ws2Res.json() as { id: string }).id;
    const goalInWs2Res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${ws2Id}/goals`,
      headers: { cookie },
      payload: { title: 'Goal in WS2' },
    });
    const foreignGoalId = (goalInWs2Res.json() as { id: string }).id;

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'gw', title: 'Cross-ws goal', goalId: foreignGoalId },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('goal_not_found');
  });
});

// ---------------------------------------------------------------------------
// PATCH /workspaces/:workspaceId/tasks/:taskId/assign  (FM orchestrator endpoint)
// ---------------------------------------------------------------------------

describe('PATCH /workspaces/:workspaceId/tasks/:taskId/assign', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  async function registerOrchestratorDevice(): Promise<{ token: string }> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'forge-master', agentId: 'forge-master', deviceType: 'orchestrator' },
    });
    return { token: (res.json() as { token: string }).token };
  }

  async function registerWorkerDevice(agentId: string): Promise<{ token: string }> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: agentId, agentId, deviceType: 'worker' },
    });
    return { token: (res.json() as { token: string }).token };
  }

  type TaskStatusLiteral =
    | 'pending_agent'
    | 'pending_dispatcher_action'
    | 'in_progress'
    | 'assigned'
    | 'completed'
    | 'cancelled'
    | 'failed';

  async function createWsTask(status: TaskStatusLiteral = 'pending_dispatcher_action'): Promise<string> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'fm', title: 'FM task' },
    });
    const id = (res.json() as { id: string }).id;
    if (status !== 'pending_agent') {
      await hub.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, id));
    }
    return id;
  }

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  it('orchestrator can assign a pending_dispatcher_action task', async () => {
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createWsTask('pending_dispatcher_action');

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const task = await hub.db
      .select({
        status: schema.tasks.status,
        assignedAgentId: schema.tasks.assignedAgentId,
        assignedAt: schema.tasks.assignedAt,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.status).toBe('assigned');
    expect(task?.assignedAgentId).toBe('architect');
    expect(task?.assignedAt).toBeInstanceOf(Date);
  });

  it('orchestrator can assign a pending_agent task', async () => {
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createWsTask('pending_agent');

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'furnace' },
    });
    expect(res.statusCode).toBe(200);

    const task = await hub.db
      .select({ status: schema.tasks.status, assignedAgentId: schema.tasks.assignedAgentId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.status).toBe('assigned');
    expect(task?.assignedAgentId).toBe('furnace');
  });

  it('worker device (non-orchestrator) gets 403', async () => {
    const { token: workerToken } = await registerWorkerDevice('architect');
    const taskId = await createWsTask('pending_dispatcher_action');

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${workerToken}` },
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('orchestrator_required');
  });

  it('returns 422 for task in non-assignable status (in_progress)', async () => {
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createWsTask('in_progress');

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('not_assignable');
  });

  it('returns 404 for task in wrong workspace', async () => {
    const { token: fmToken } = await registerOrchestratorDevice();
    const ws2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'WS2', slug: 'ws2-assign' },
    });
    const ws2Id = (ws2Res.json() as { id: string }).id;
    const taskId = await createWsTask('pending_dispatcher_action');

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${ws2Id}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires device auth — user session returns 401', async () => {
    const taskId = await createWsTask('pending_dispatcher_action');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('records task.assigned history event', async () => {
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createWsTask('pending_dispatcher_action');

    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'architect' },
    });

    const histRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/history`,
      headers: { cookie },
    });
    const { history } = histRes.json() as { history: { eventName: string; payload: unknown }[] };
    const assignEvent = history.find((h) => h.eventName === 'task.assigned');
    expect(assignEvent).toBeDefined();
    const payload = assignEvent?.payload as Record<string, unknown> | undefined;
    expect(payload?.['agentId']).toBe('architect');
  });

  it('assign to already-assigned task returns 422 not_assignable', async () => {
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createWsTask('assigned');

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('not_assignable');
  });
});

// ---------------------------------------------------------------------------
// Claim agentId routing
// ---------------------------------------------------------------------------

describe('/tasks/:id/claim — agentId routing', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  async function registerDeviceWithAgent(
    agentId: string | null,
  ): Promise<{ token: string }> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: {
        name: agentId ?? 'untyped',
        ...(agentId !== null && { agentId }),
      },
    });
    return { token: (res.json() as { token: string }).token };
  }

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  it('device with matching agentId can claim assigned task', async () => {
    const { token } = await registerDeviceWithAgent('architect');
    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'fm', title: 'Architect task' },
    });
    const taskId = (taskRes.json() as { id: string }).id;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'assigned', assignedAgentId: 'architect' })
      .where(eq(schema.tasks.id, taskId));

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('device with mismatched agentId cannot claim task assigned to different agent', async () => {
    const { token } = await registerDeviceWithAgent('furnace');
    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'fm', title: 'Architect task' },
    });
    const taskId = (taskRes.json() as { id: string }).id;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'assigned', assignedAgentId: 'architect' })
      .where(eq(schema.tasks.id, taskId));

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('device with agentId can claim unrouted task (assignedAgentId=null)', async () => {
    const { token } = await registerDeviceWithAgent('architect');
    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'Unrouted task' },
    });
    const taskId = (taskRes.json() as { id: string }).id;

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('device without agentId can claim unrouted task', async () => {
    const { token } = await registerDeviceWithAgent(null);
    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'Unrouted task' },
    });
    const taskId = (taskRes.json() as { id: string }).id;

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('device without agentId cannot claim a routed task', async () => {
    const { token } = await registerDeviceWithAgent(null);
    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'fm', title: 'Routed task' },
    });
    const taskId = (taskRes.json() as { id: string }).id;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'assigned', assignedAgentId: 'architect' })
      .where(eq(schema.tasks.id, taskId));

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Stale assignment detection + requeue
// ---------------------------------------------------------------------------

describe('GET+POST /workspaces/:wsId/tasks/stale-assigned', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;
  let fmToken: string;
  let workerToken: string;

  async function registerOrchestrator(): Promise<string> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'forge-master', agentId: 'forge-master', deviceType: 'orchestrator' },
    });
    return (res.json() as { token: string }).token;
  }

  async function registerWorker(): Promise<string> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'worker', agentId: 'worker', deviceType: 'worker' },
    });
    return (res.json() as { token: string }).token;
  }

  async function createAssignedTask(assignedAt: Date): Promise<string> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'st', title: 'Stale task' },
    });
    const taskId = (res.json() as { id: string }).id;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'assigned', assignedAgentId: 'worker', assignedAt })
      .where(eq(schema.tasks.id, taskId));
    return taskId;
  }

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
    fmToken = await registerOrchestrator();
    workerToken = await registerWorker();
  });

  afterEach(async () => {
    await hub.close();
  });

  it('GET returns empty list when no stale tasks and includes ttlMinutes + cutoff', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned?ttlMinutes=30`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: unknown[]; ttlMinutes: number; cutoff: string };
    expect(body.tasks).toHaveLength(0);
    expect(body.ttlMinutes).toBe(30);
    expect(typeof body.cutoff).toBe('string'); // ISO date serialized
  });

  it('GET returns task assigned beyond ttl', async () => {
    const oldDate = new Date(Date.now() - 60 * 60 * 1000); // 60 min ago
    await createAssignedTask(oldDate);

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned?ttlMinutes=30`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(1);
  });

  it('GET does not return recently-assigned task', async () => {
    const recentDate = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    await createAssignedTask(recentDate);

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned?ttlMinutes=30`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(0);
  });

  it('GET worker device returns 403', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned`,
      headers: { authorization: `Bearer ${workerToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('orchestrator_required');
  });

  it('POST requeue returns requeued=0 when nothing stale', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned/requeue?ttlMinutes=30`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { requeued: number }).requeued).toBe(0);
  });

  it('POST requeue reverts stale tasks to pending_dispatcher_action', async () => {
    const oldDate = new Date(Date.now() - 60 * 60 * 1000); // 60 min ago
    const taskId = await createAssignedTask(oldDate);

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned/requeue?ttlMinutes=30`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { requeued: number }).requeued).toBe(1);

    const task = await hub.db
      .select({ status: schema.tasks.status, assignedAgentId: schema.tasks.assignedAgentId, assignedAt: schema.tasks.assignedAt })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.status).toBe('pending_dispatcher_action');
    expect(task?.assignedAgentId).toBeNull();
    expect(task?.assignedAt).toBeNull();
  });

  it('POST requeue writes task.requeued history event', async () => {
    const oldDate = new Date(Date.now() - 60 * 60 * 1000);
    const taskId = await createAssignedTask(oldDate);

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned/requeue?ttlMinutes=30`,
      headers: { authorization: `Bearer ${fmToken}` },
    });

    const histRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/history`,
      headers: { cookie },
    });
    const { history } = histRes.json() as { history: { eventName: string; payload: unknown }[] };
    const reqEvent = history.find((h) => h.eventName === 'task.requeued');
    expect(reqEvent).toBeDefined();
    const payload = reqEvent?.payload as Record<string, unknown> | undefined;
    expect(payload?.['reason']).toBe('stale_assignment');
    expect(payload?.['ttlMinutes']).toBe(30);
  });

  it('POST requeue worker device returns 403', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned/requeue`,
      headers: { authorization: `Bearer ${workerToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('orchestrator_required');
  });

  it('POST requeue does not touch tasks in other workspaces', async () => {
    const ws2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'WS2', slug: 'ws2-stale' },
    });
    const ws2Id = (ws2Res.json() as { id: string }).id;

    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${ws2Id}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ws', title: 'WS2 task' },
    });
    const ws2TaskId = (taskRes.json() as { id: string }).id;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'assigned', assignedAgentId: 'worker', assignedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.tasks.id, ws2TaskId));

    // Requeue on workspaceId (not ws2Id)
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned/requeue?ttlMinutes=30`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect((res.json() as { requeued: number }).requeued).toBe(0);

    const task = await hub.db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ws2TaskId))
      .get();
    expect(task?.status).toBe('assigned'); // untouched
  });

  it('GET returns multiple stale tasks sorted by assignedAt asc (oldest first)', async () => {
    const older = new Date(Date.now() - 120 * 60 * 1000); // 120 min ago
    const newer = new Date(Date.now() - 60 * 60 * 1000);  // 60 min ago
    const olderTaskId = await createAssignedTask(older);
    const newerTaskId = await createAssignedTask(newer);

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned?ttlMinutes=30`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: { id: string }[] };
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0]!.id).toBe(olderTaskId);
    expect(body.tasks[1]!.id).toBe(newerTaskId);
  });

  it('POST requeue handles multiple stale tasks in one call', async () => {
    const oldDate = new Date(Date.now() - 60 * 60 * 1000);
    const taskId1 = await createAssignedTask(oldDate);
    const taskId2 = await createAssignedTask(oldDate);

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned/requeue?ttlMinutes=30`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { requeued: number }).requeued).toBe(2);

    for (const taskId of [taskId1, taskId2]) {
      const task = await hub.db
        .select({ status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .get();
      expect(task?.status).toBe('pending_dispatcher_action');

      // Verify history event written for each task
      const histRes = await hub.fastify.inject({
        method: 'GET',
        url: `/tasks/${taskId}/history`,
        headers: { cookie },
      });
      expect(histRes.statusCode).toBe(200);
      const { history } = histRes.json() as { history: { eventName: string; payload: unknown }[] };
      const reqEvent = history.find((h) => h.eventName === 'task.requeued');
      expect(reqEvent).toBeDefined();
      const payload = reqEvent?.payload as Record<string, unknown> | undefined;
      expect(payload?.['reason']).toBe('stale_assignment');
      expect(payload?.['ttlMinutes']).toBe(30);
    }
  });

  it('GET invalid ttlMinutes returns 400', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned?ttlMinutes=0`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET ttlMinutes exceeding max returns 400', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned?ttlMinutes=1441`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET no token returns 401', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST requeue no token returns 401', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned/requeue`,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /tasks/:id/fail
// ---------------------------------------------------------------------------

describe('POST /tasks/:id/fail', () => {
  let hub: Hub;
  let cookie: string;
  let deviceToken: string;

  beforeEach(async () => {
    hub = await createHub({ config: testConfig });
    const admin = await setupAdmin(hub);
    cookie = admin.cookie;
    const dev = await registerDevice(hub, cookie, 'test-device');
    deviceToken = dev.token;
  });

  afterEach(async () => {
    await hub.close();
  });

  /** Create and claim a task — returns the task in in_progress state. */
  async function createAndClaimTask(): Promise<string> {
    const taskId = await createTask(hub, cookie);
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    return taskId;
  }

  it('device can fail its own in_progress task', async () => {
    const taskId = await createAndClaimTask();

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { reason: 'spawn failed: ENOENT' },
    });
    expect(res.statusCode).toBe(200);

    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('failed');
  });

  it('fail writes task.failed history event with reason', async () => {
    const taskId = await createAndClaimTask();

    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { reason: 'runtime crash' },
    });

    const history = await hub.db
      .select()
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, taskId));
    const failEvents = history.filter((h) => h.eventName === 'task.failed');
    // Exactly one task.failed event — guards against duplicate writes from race condition
    expect(failEvents).toHaveLength(1);
    const payload = failEvents[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.['reason']).toBe('runtime crash');
  });

  it('fail with no reason still succeeds', async () => {
    const taskId = await createAndClaimTask();
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(200);
    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('failed');
  });

  it('returns 409 when task is not in_progress', async () => {
    const taskId = await createTask(hub, cookie);
    // Task is in pending_agent, not in_progress
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('not_in_progress');
  });

  it('returns 403 when device did not claim the task', async () => {
    const taskId = await createAndClaimTask();

    // Register a different device
    const other = await registerDevice(hub, cookie, 'other-device');

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('not_assigned_to_you');
  });

  it('returns 404 for unknown task', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/fl-9999/fail`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 when no device token provided', async () => {
    const taskId = await createAndClaimTask();
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { cookie }, // user session, not device token
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /tasks/stats', () => {
  let hub: Hub;
  let cookie: string;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie } = await setupAdmin(hub));
  });

  afterEach(async () => {
    await hub.close();
  });

  it('returns zero counts when no tasks exist', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/tasks/stats',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total: number;
      byStatus: Record<string, number>;
      completionRate: number;
      completedLast7Days: number;
      summary: { completed: number; failed: number; inProgress: number; pending: number };
    };
    expect(body.total).toBe(0);
    expect(body.completionRate).toBe(0);
    expect(body.completedLast7Days).toBe(0);
    expect(body.summary.completed).toBe(0);
    expect(body.summary.failed).toBe(0);
  });

  it('counts tasks by status correctly', async () => {
    // Create 3 tasks via API (they land as pending_agent by default)
    for (let i = 0; i < 3; i++) {
      await hub.fastify.inject({
        method: 'POST',
        url: '/tasks',
        headers: { cookie },
        payload: { projectPrefix: 'fl', title: `Task ${i}` },
      });
    }

    // Manually set one to completed and one to failed via hub.db
    const tasks = await hub.db.select({ id: schema.tasks.id }).from(schema.tasks);
    const [t0, t1] = tasks;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, t0!.id));
    await hub.db
      .update(schema.tasks)
      .set({ status: 'failed' })
      .where(eq(schema.tasks.id, t1!.id));

    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/tasks/stats',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total: number;
      byStatus: Record<string, number>;
      completionRate: number;
      summary: { completed: number; failed: number };
    };
    expect(body.total).toBe(3);
    expect(body.byStatus['completed']).toBe(1);
    expect(body.byStatus['failed']).toBe(1);
    expect(body.byStatus['pending_agent']).toBe(1);
    expect(body.summary.completed).toBe(1);
    expect(body.summary.failed).toBe(1);
    // 1 of 3 = 33%
    expect(body.completionRate).toBe(33);
  });

  it('completedLast7Days counts only recent completed tasks', async () => {
    // Create 2 tasks via API so they have the correct createdBy (user's ID)
    const recentRes = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'Recent done' },
    });
    const oldRes = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'Old done' },
    });
    const recentId = (recentRes.json() as { id: string }).id;
    const oldId = (oldRes.json() as { id: string }).id;

    const nowMs = Date.now();
    // "old" is strictly outside the 7-day window by 1 ms
    const oldMs = nowMs - 7 * 24 * 60 * 60 * 1000 - 1;

    await hub.db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date(nowMs) })
      .where(eq(schema.tasks.id, recentId));
    await hub.db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date(oldMs) })
      .where(eq(schema.tasks.id, oldId));

    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/tasks/stats',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { completedLast7Days: number; total: number };
    expect(body.total).toBe(2);
    expect(body.completedLast7Days).toBe(1);
  });

  it('returns 401 when not authenticated', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/tasks/stats',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when authenticated only as a device (not a user)', async () => {
    const { token: deviceToken } = await registerDevice(hub, cookie, 'stats-device');
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/tasks/stats',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('excludes tasks in workspaces the user is not a member of', async () => {
    // Create a task in a workspace the user owns (via API)
    const wsRes = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'My WS', slug: 'my-ws' },
    });
    const { id: ownedWsId } = wsRes.json() as { id: string };
    await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'My task', workspaceId: ownedWsId },
    });

    // Insert a workspace the user is NOT a member of (owned by admin but no workspace_member row)
    const userRow = await hub.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .get();
    const adminId = userRow!.id;
    const alienWsId = nanoid();
    await hub.db.insert(schema.workspaces).values({
      id: alienWsId,
      name: 'Alien WS',
      slug: 'alien-ws',
      ownerUserId: adminId,
      updatedAt: new Date(),
      createdAt: new Date(),
    });
    // Note: intentionally NOT inserting into workspace_members — stats must NOT include this task
    await hub.db.insert(schema.tasks).values({
      id: 'alien-task-1',
      projectPrefix: 'al',
      title: 'Alien task',
      status: 'completed',
      workspaceId: alienWsId,
      createdBy: `user:${adminId}`,
      updatedAt: new Date(),
      createdAt: new Date(),
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/tasks/stats',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { total: number };
    // Should see only the 1 task in the owned workspace, NOT the alien task
    expect(body.total).toBe(1);
  });
});
