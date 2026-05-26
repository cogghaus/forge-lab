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

  it('GET returns empty list when no stale tasks', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks/stale-assigned?ttlMinutes=30`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(0);
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
