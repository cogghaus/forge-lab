import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createHub, type Hub } from '../app.js';
import { schema } from '@forge-lab/core';
import { TEST_HUB_CONFIG, setupAdmin, registerDevice, createTask, createWorkspace } from '../test-utils.js';

describe('/workspaces/:workspaceId/tasks', () => {
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

  it('POST without an agent routes to the FM dispatcher inbox (pending_dispatcher_action)', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ws', title: 'Unrouted task' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const task = await hub.db
      .select({ status: schema.tasks.status, assignedAgentId: schema.tasks.assignedAgentId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    expect(task?.status).toBe('pending_dispatcher_action');
    expect(task?.assignedAgentId).toBeNull();
  });

  it('POST with an explicit agent skips triage (pending_agent + assignedAgentId)', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ws', title: 'Pre-assigned task', assignedAgentId: 'furnace' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const task = await hub.db
      .select({ status: schema.tasks.status, assignedAgentId: schema.tasks.assignedAgentId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    expect(task?.status).toBe('pending_agent');
    expect(task?.assignedAgentId).toBe('furnace');
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

  it('POST with digit-containing projectPrefix returns 400', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'v4l', title: 'Digit in prefix' },
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
    hub = await createHub({ config: TEST_HUB_CONFIG });
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
    hub = await createHub({ config: TEST_HUB_CONFIG });
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
    hub = await createHub({ config: TEST_HUB_CONFIG });
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

  it('cancels a pending_dispatcher_action task', async () => {
    // Regression: pending_dispatcher_action was missing from USER_ALLOWED_TRANSITIONS,
    // making FM-queued tasks impossible to cancel through the API.
    const taskId = await createWsTask();
    await hub.db.update(schema.tasks).set({ status: 'pending_dispatcher_action' }).where(eq(schema.tasks.id, taskId));
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
    hub = await createHub({ config: TEST_HUB_CONFIG });
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
    // Unrouted workspace tasks now land in pending_dispatcher_action, so force
    // the status this test needs rather than relying on the create default.
    await hub.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, id));
    return id;
  }

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
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

  it('worker device gets policy_denied on assign (role:worker deny @ 100)', async () => {
    // After Heimdall: error body is policy_denied not orchestrator_required.
    const { token: workerToken } = await registerWorkerDevice('architect');
    const taskId = await createWsTask('pending_dispatcher_action');

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${workerToken}` },
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string; action?: string };
    expect(body.error).toBe('policy_denied');
    expect(body.action).toBe('task:assign');
  });

  it('orchestrator device gets policy_denied on task:claim (role:orchestrator deny)', async () => {
    // FM should assign tasks, not claim them. Orchestrator claim is now blocked at policy layer.
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createWsTask('pending_agent');

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${fmToken}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string; action?: string };
    expect(body.error).toBe('policy_denied');
    expect(body.action).toBe('task:claim');
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

  it('unauthenticated request returns 401', async () => {
    const taskId = await createWsTask('pending_dispatcher_action');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
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
    hub = await createHub({ config: TEST_HUB_CONFIG });
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
    hub = await createHub({ config: TEST_HUB_CONFIG });
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
    hub = await createHub({ config: TEST_HUB_CONFIG });
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
    hub = await createHub({ config: TEST_HUB_CONFIG });
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

// ---------------------------------------------------------------------------
// parentId — FM decomposition subtask linking
// ---------------------------------------------------------------------------

describe('task parentId linking', () => {
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

  it('workspace POST creates subtask with parentId persisted', async () => {
    const parentRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'par', title: 'Parent task' },
    });
    expect(parentRes.statusCode).toBe(201);
    const { id: parentId } = parentRes.json() as { id: string };

    const childRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'par', title: 'Child task', parentId },
    });
    expect(childRes.statusCode).toBe(201);
    const { id: childId } = childRes.json() as { id: string };

    const child = await hub.db
      .select({ parentId: schema.tasks.parentId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, childId))
      .get();
    expect(child?.parentId).toBe(parentId);
  });

  it('workspace POST returns 404 when parentId does not exist in workspace', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'par', title: 'Orphan task', parentId: 'par-9999' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('parent_task_not_found');
  });

  it('workspace POST returns 404 when parentId belongs to different workspace', async () => {
    // Create a task in a different workspace using the flat endpoint (no workspace)
    const flatRes = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'par', title: 'Task in different workspace' },
    });
    expect(flatRes.statusCode).toBe(201);
    const { id: alienParentId } = flatRes.json() as { id: string };

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'par', title: 'Cross-ws subtask', parentId: alienParentId },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('parent_task_not_found');
  });

  it('flat POST with parentId and workspaceId persists both (device use case)', async () => {
    const { token } = await registerDevice(hub, cookie, 'forge-fm-test');

    // Create a parent task via flat endpoint with workspaceId
    const parentRes = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectPrefix: 'fmd', title: 'FM parent', workspaceId },
    });
    expect(parentRes.statusCode).toBe(201);
    const { id: parentId } = parentRes.json() as { id: string };

    // Create a subtask with parentId + workspaceId
    const childRes = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectPrefix: 'fmd', title: 'FM subtask', parentId, workspaceId },
    });
    expect(childRes.statusCode).toBe(201);
    const { id: childId } = childRes.json() as { id: string };

    const child = await hub.db
      .select({ parentId: schema.tasks.parentId, workspaceId: schema.tasks.workspaceId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, childId))
      .get();
    expect(child?.parentId).toBe(parentId);
    expect(child?.workspaceId).toBe(workspaceId);
  });

  it('flat POST returns 404 when parentId does not exist', async () => {
    const { token } = await registerDevice(hub, cookie, 'forge-fm-validate');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectPrefix: 'fmd', title: 'Bad parent', parentId: 'fmd-9999' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('parent_task_not_found');
  });

  it('flat POST returns 404 when parentId is in a different workspace than supplied workspaceId', async () => {
    const { token } = await registerDevice(hub, cookie, 'forge-fm-cross-ws');

    // Create parent with no workspace (workspaceId = null)
    const parentRes = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectPrefix: 'fmd', title: 'Unscoped parent' },
    });
    expect(parentRes.statusCode).toBe(201);
    const { id: parentId } = parentRes.json() as { id: string };

    // Attempt to create child with parentId + a specific workspaceId (parent is not in that workspace)
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectPrefix: 'fmd', title: 'Cross-ws child', parentId, workspaceId },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('parent_task_not_found');
  });

  it('flat POST with workspaceId mirrors workspaceId onto taskHistory audit event', async () => {
    const { token } = await registerDevice(hub, cookie, 'forge-fm-audit');

    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
      payload: { projectPrefix: 'aud', title: 'Audit task', workspaceId },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const history = await hub.db
      .select({ workspaceId: schema.taskHistory.workspaceId })
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, id))
      .get();
    expect(history?.workspaceId).toBe(workspaceId);
  });

  it('task created without parentId has null parentId', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'par', title: 'Top-level task' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const task = await hub.db
      .select({ parentId: schema.tasks.parentId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    expect(task?.parentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assignedAgentId — reactive agent pre-assignment
// ---------------------------------------------------------------------------

describe('task assignedAgentId via flat POST', () => {
  let hub: Hub;
  let cookie: string;
  let deviceToken: string;
  let workspaceId: string;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
    ({ token: deviceToken } = await registerDevice(hub, cookie, 'scribe-daemon', { deviceType: 'worker' }));
  });

  afterEach(async () => {
    await hub.close();
  });

  it('flat POST persists assignedAgentId on the task', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { projectPrefix: 'doc', title: 'Document the auth endpoint', assignedAgentId: 'scribe' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const task = await hub.db
      .select({ assignedAgentId: schema.tasks.assignedAgentId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    expect(task?.assignedAgentId).toBe('scribe');
  });

  it('flat POST with no assignedAgentId stores null', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { projectPrefix: 'doc', title: 'Generic task' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const task = await hub.db
      .select({ assignedAgentId: schema.tasks.assignedAgentId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    expect(task?.assignedAgentId).toBeNull();
  });


  it('task.completed SSE event includes result and workspaceId in payload', async () => {
    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'doc', title: 'Build the API endpoint' },
    });
    const { id: taskId } = taskRes.json() as { id: string };

    // Unrouted workspace tasks now land in pending_dispatcher_action, which is
    // not claimable; move it to pending_agent so the device can claim it.
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_agent' })
      .where(eq(schema.tasks.id, taskId));

    // Claim the task so it can be completed by the same device
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });

    const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = hub.bus.subscribe((ev) => {
      emitted.push(ev as { name: string; payload: Record<string, unknown> });
    });

    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/complete`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { result: 'Added GET /api/auth endpoint with JWT validation' },
    });

    const completedEvent = emitted.find(ev => ev.name === 'task.completed');
    unsubscribe();

    expect(completedEvent).toBeDefined();
    expect(completedEvent?.payload['taskId']).toBe(taskId);
    expect(completedEvent?.payload['result']).toBe('Added GET /api/auth endpoint with JWT validation');
    expect(completedEvent?.payload['workspaceId']).toBe(workspaceId);
  });
});

// ---------------------------------------------------------------------------
// POST /workspaces/:workspaceId/tasks/:taskId/cancel
// ---------------------------------------------------------------------------

describe('POST /workspaces/:workspaceId/tasks/:taskId/cancel', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  type TaskStatusLiteral =
    | 'pending_dispatcher_action'
    | 'pending_agent'
    | 'pending_design'
    | 'design_review'
    | 'assigned'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'cancelled';

  async function createWsTask(status: TaskStatusLiteral = 'pending_agent'): Promise<string> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'can', title: 'Cancellable task' },
    });
    const id = (res.json() as { id: string }).id;
    // Unrouted workspace tasks now land in pending_dispatcher_action, so force
    // the status this test needs rather than relying on the create default.
    await hub.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, id));
    return id;
  }

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  it('cancels a pending_agent task', async () => {
    const taskId = await createWsTask('pending_agent');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { id: string; status: string }).status).toBe('cancelled');
    const task = await hub.db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.status).toBe('cancelled');
  });

  it('cancels a pending_dispatcher_action task (gap fix)', async () => {
    const taskId = await createWsTask('pending_dispatcher_action');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const task = await hub.db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.status).toBe('cancelled');
  });

  it('cancels an in_progress task and inserts stop instruction', async () => {
    const taskId = await createWsTask('in_progress');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const instr = await hub.db
      .select()
      .from(schema.taskInstructions)
      .where(eq(schema.taskInstructions.taskId, taskId))
      .get();
    expect(instr).toBeDefined();
    expect(instr?.priority).toBe('stop');
  });

  it('stop instruction body includes cancel reason', async () => {
    const taskId = await createWsTask('in_progress');
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
      payload: { reason: 'wrong scope' },
    });
    const instr = await hub.db
      .select({ body: schema.taskInstructions.body })
      .from(schema.taskInstructions)
      .where(eq(schema.taskInstructions.taskId, taskId))
      .get();
    expect(instr?.body).toContain('wrong scope');
  });

  it('no stop instruction inserted for non-in_progress cancel', async () => {
    const taskId = await createWsTask('pending_agent');
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    const instr = await hub.db
      .select()
      .from(schema.taskInstructions)
      .where(eq(schema.taskInstructions.taskId, taskId))
      .get();
    expect(instr).toBeUndefined();
  });

  it('returns 409 already_terminal for already-cancelled task', async () => {
    const taskId = await createWsTask('cancelled');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('already_terminal');
  });

  it('returns 409 already_terminal for completed task', async () => {
    const taskId = await createWsTask('completed');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('already_terminal');
  });

  it('returns 409 already_terminal for failed task', async () => {
    const taskId = await createWsTask('failed');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('already_terminal');
  });

  it('returns 404 for non-existent task', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/can-999/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for non-workspace-member', async () => {
    const taskId = await createWsTask('pending_agent');
    // Use invite flow — direct registration is admin-only
    const inviteRes = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie },
      payload: {},
    });
    const { token: inviteToken } = inviteRes.json() as { token: string };
    const acceptRes = await hub.fastify.inject({
      method: 'POST',
      url: `/invites/${inviteToken}/accept`,
      payload: { email: 'other@example.com', password: 'password123' },
    });
    const rawAcceptCookie = acceptRes.headers['set-cookie'];
    const otherCookie = (Array.isArray(rawAcceptCookie) ? rawAcceptCookie[0] : rawAcceptCookie)!.split(';')[0]!;
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 for unauthenticated request', async () => {
    const taskId = await createWsTask('pending_agent');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('records taskHistory with task.cancelled event', async () => {
    const taskId = await createWsTask('pending_agent');
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    const rows = await hub.db
      .select()
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, taskId));
    const history = rows.find((r) => r.eventName === 'task.cancelled');
    expect(history).toBeDefined();
    expect((history?.payload as Record<string, unknown>)['previousStatus']).toBe('pending_agent');
  });

  it('stores reason in taskHistory payload', async () => {
    const taskId = await createWsTask('pending_agent');
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
      payload: { reason: 'test reason' },
    });
    const rows = await hub.db
      .select()
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, taskId));
    const history = rows.find((r) => r.eventName === 'task.cancelled');
    expect((history?.payload as Record<string, unknown>)['reason']).toBe('test reason');
  });

  it('stores null reason when body omitted', async () => {
    const taskId = await createWsTask('pending_agent');
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    const rows = await hub.db
      .select()
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, taskId));
    const history = rows.find((r) => r.eventName === 'task.cancelled');
    expect((history?.payload as Record<string, unknown>)['reason']).toBeNull();
  });

  it('emits task.cancelled SSE event', async () => {
    const taskId = await createWsTask('pending_agent');
    const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const unsub = hub.bus.subscribe((ev) => {
      emitted.push(ev as { name: string; payload: Record<string, unknown> });
    });
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    unsub();
    const ev = emitted.find((e) => e.name === 'task.cancelled');
    expect(ev).toBeDefined();
    expect(ev?.payload['taskId']).toBe(taskId);
    expect(ev?.payload['workspaceId']).toBe(workspaceId);
  });

  it('concurrent cancel: second request returns 409 status_changed', async () => {
    const taskId = await createWsTask('pending_agent');
    // First cancel succeeds
    const r1 = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    expect(r1.statusCode).toBe(200);
    // Second cancel: task is now cancelled (terminal) → already_terminal
    const r2 = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    expect(r2.statusCode).toBe(409);
    expect((r2.json() as { error: string }).error).toBe('already_terminal');
  });
});

// ---------------------------------------------------------------------------
// POST /workspaces/:workspaceId/tasks/:taskId/retry
// ---------------------------------------------------------------------------

describe('POST /workspaces/:workspaceId/tasks/:taskId/retry', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  type TaskStatusLiteral =
    | 'pending_dispatcher_action'
    | 'pending_agent'
    | 'in_progress'
    | 'assigned'
    | 'completed'
    | 'cancelled'
    | 'failed';

  async function createWsTask(status: TaskStatusLiteral = 'failed'): Promise<string> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ret', title: 'Retriable task' },
    });
    const id = (res.json() as { id: string }).id;
    // Unrouted workspace tasks now land in pending_dispatcher_action, so force
    // the status this test needs rather than relying on the create default.
    await hub.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, id));
    return id;
  }

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  it('retries a failed task to pending_dispatcher_action', async () => {
    const taskId = await createWsTask('failed');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/retry`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; status: string };
    expect(body.status).toBe('pending_dispatcher_action');

    const task = await hub.db
      .select({
        status: schema.tasks.status,
        assignedAgentId: schema.tasks.assignedAgentId,
        assignedAt: schema.tasks.assignedAt,
        assignedDeviceId: schema.tasks.assignedDeviceId,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.status).toBe('pending_dispatcher_action');
    expect(task?.assignedAgentId).toBeNull();
    expect(task?.assignedAt).toBeNull();
    expect(task?.assignedDeviceId).toBeNull();
  });

  it('applies priority override', async () => {
    const taskId = await createWsTask('failed');
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/retry`,
      headers: { cookie },
      payload: { priority: 'urgent' },
    });
    const task = await hub.db
      .select({ priority: schema.tasks.priority })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.priority).toBe('urgent');
  });

  it('keeps existing priority when not provided', async () => {
    const taskId = await createWsTask('failed');
    await hub.db
      .update(schema.tasks)
      .set({ priority: 'high' })
      .where(eq(schema.tasks.id, taskId));
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/retry`,
      headers: { cookie },
    });
    const task = await hub.db
      .select({ priority: schema.tasks.priority })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.priority).toBe('high');
  });

  it('returns 409 not_failed when task is in_progress', async () => {
    const taskId = await createWsTask('in_progress');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/retry`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('not_failed');
  });

  it('returns 409 not_failed when task is pending_agent', async () => {
    const taskId = await createWsTask('pending_agent');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/retry`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('not_failed');
  });

  it('returns 404 for non-existent task', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/ret-999/retry`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 for non-workspace-member', async () => {
    const taskId = await createWsTask('failed');
    const inviteRes = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie },
      payload: {},
    });
    const { token: inviteToken } = inviteRes.json() as { token: string };
    const acceptRes = await hub.fastify.inject({
      method: 'POST',
      url: `/invites/${inviteToken}/accept`,
      payload: { email: 'other2@example.com', password: 'password123' },
    });
    const rawAcceptCookie = acceptRes.headers['set-cookie'];
    const otherCookie = (Array.isArray(rawAcceptCookie) ? rawAcceptCookie[0] : rawAcceptCookie)!.split(';')[0]!;
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/retry`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 401 for unauthenticated request', async () => {
    const taskId = await createWsTask('failed');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/retry`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('records task.requeued taskHistory event', async () => {
    const taskId = await createWsTask('failed');
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/retry`,
      headers: { cookie },
    });
    const rows = await hub.db
      .select()
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, taskId));
    const requeuedRow = rows.find((r) => r.eventName === 'task.requeued');
    expect(requeuedRow).toBeDefined();
    expect((requeuedRow?.payload as Record<string, unknown>)['previousStatus']).toBe('failed');
  });

  it('emits task.requeued SSE event', async () => {
    const taskId = await createWsTask('failed');
    const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const unsub = hub.bus.subscribe((ev) => {
      emitted.push(ev as { name: string; payload: Record<string, unknown> });
    });
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/retry`,
      headers: { cookie },
    });
    unsub();
    const ev = emitted.find((e) => e.name === 'task.requeued');
    expect(ev).toBeDefined();
    expect(ev?.payload['taskId']).toBe(taskId);
    expect(ev?.payload['workspaceId']).toBe(workspaceId);
  });

  it('clears assignedDeviceId on retry', async () => {
    const taskId = await createWsTask('failed');
    // Simulate a task that had a device assigned
    const deviceRes = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'temp-worker', deviceType: 'worker' },
    });
    const { id: deviceId } = deviceRes.json() as { id: string; token: string };
    await hub.db
      .update(schema.tasks)
      .set({ assignedDeviceId: deviceId })
      .where(eq(schema.tasks.id, taskId));
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/retry`,
      headers: { cookie },
    });
    const task = await hub.db
      .select({ assignedDeviceId: schema.tasks.assignedDeviceId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.assignedDeviceId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH /workspaces/:workspaceId/tasks/:taskId/assign — user session path
// ---------------------------------------------------------------------------

describe('PATCH /workspaces/:workspaceId/tasks/:taskId/assign — user session', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  type TaskStatusLiteral =
    | 'pending_dispatcher_action'
    | 'pending_agent'
    | 'in_progress'
    | 'assigned'
    | 'completed'
    | 'cancelled'
    | 'failed';

  async function createWsTask(status: TaskStatusLiteral = 'pending_agent'): Promise<string> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'ras', title: 'Reassignable task' },
    });
    const id = (res.json() as { id: string }).id;
    // Unrouted workspace tasks now land in pending_dispatcher_action, so force
    // the status this test needs rather than relying on the create default.
    await hub.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, id));
    return id;
  }

  async function registerOrchestratorDevice(): Promise<{ token: string }> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'forge-master', agentId: 'forge-master', deviceType: 'orchestrator' },
    });
    return { token: (res.json() as { token: string }).token };
  }

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  it('user can reassign a pending_agent task to a specific agent', async () => {
    const taskId = await createWsTask('pending_agent');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
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

  it('user can reassign an assigned task', async () => {
    const taskId = await createWsTask('assigned');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('user can clear assignment with agentId: null', async () => {
    const taskId = await createWsTask('pending_agent');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
      payload: { agentId: null },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; status?: string };
    expect(body.status).toBe('pending_dispatcher_action');

    const task = await hub.db
      .select({
        status: schema.tasks.status,
        assignedAgentId: schema.tasks.assignedAgentId,
        assignedAt: schema.tasks.assignedAt,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.status).toBe('pending_dispatcher_action');
    expect(task?.assignedAgentId).toBeNull();
    expect(task?.assignedAt).toBeNull();
  });

  it('user cannot reassign an in_progress task', async () => {
    const taskId = await createWsTask('in_progress');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('not_assignable');
  });

  it('user cannot reassign a completed task', async () => {
    const taskId = await createWsTask('completed');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('not_assignable');
  });

  it('user without workspace membership returns 403', async () => {
    const taskId = await createWsTask('pending_agent');
    const inviteRes = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie },
      payload: {},
    });
    const { token: inviteToken } = inviteRes.json() as { token: string };
    const acceptRes = await hub.fastify.inject({
      method: 'POST',
      url: `/invites/${inviteToken}/accept`,
      payload: { email: 'outsider@example.com', password: 'password123' },
    });
    const rawAcceptCookie = acceptRes.headers['set-cookie'];
    const outsiderCookie = (Array.isArray(rawAcceptCookie) ? rawAcceptCookie[0] : rawAcceptCookie)!.split(';')[0]!;
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie: outsiderCookie },
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('unauthenticated returns 401', async () => {
    const taskId = await createWsTask('pending_agent');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('orchestrator device path still works (regression guard)', async () => {
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createWsTask('pending_dispatcher_action');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'architect' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });

  it('orchestrator cannot pass null agentId (validation error)', async () => {
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createWsTask('pending_dispatcher_action');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it('records task.assigned history when user reassigns', async () => {
    const taskId = await createWsTask('pending_agent');
    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
      payload: { agentId: 'scribe' },
    });
    const rows = await hub.db
      .select()
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, taskId));
    const assignRow = rows.find((r) => r.eventName === 'task.assigned');
    expect(assignRow).toBeDefined();
    expect(assignRow?.source).toMatch(/^user:/);
  });

  it('records task.requeued history when user clears assignment', async () => {
    const taskId = await createWsTask('pending_agent');
    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
      payload: { agentId: null },
    });
    const rows = await hub.db
      .select()
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, taskId));
    const requeuedRow = rows.find((r) => r.eventName === 'task.requeued');
    expect(requeuedRow).toBeDefined();
    expect(
      (requeuedRow?.payload as Record<string, unknown>)['reason'],
    ).toBe('manual_reassign_cleared');
  });

  it('emits task.assigned SSE when user reassigns', async () => {
    const taskId = await createWsTask('pending_agent');
    const emitted: Array<{ name: string }> = [];
    const unsub = hub.bus.subscribe((ev) => emitted.push(ev as { name: string }));
    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
      payload: { agentId: 'furnace' },
    });
    unsub();
    expect(emitted.find((e) => e.name === 'task.assigned')).toBeDefined();
  });

  it('emits task.requeued SSE when user clears assignment', async () => {
    const taskId = await createWsTask('pending_agent');
    const emitted: Array<{ name: string }> = [];
    const unsub = hub.bus.subscribe((ev) => emitted.push(ev as { name: string }));
    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
      payload: { agentId: null },
    });
    unsub();
    expect(emitted.find((e) => e.name === 'task.requeued')).toBeDefined();
  });
});
