import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createHub, type Hub } from '../app.js';
import { schema } from '@forge-lab/core';
import { TEST_HUB_CONFIG, setupAdmin, registerDevice, createTask, createWorkspace } from '../test-utils.js';
import { sweepExpiredLeases } from './tasks.js';

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

  it('POST without an agent lands in pending_dispatcher_action so FM triages it (issue 2)', async () => {
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
    // FM-as-front-door (issue 2): an unassigned workspace-created task goes to the
    // dispatcher inbox for FM triage. The previous assertion (pending_agent) encoded
    // the bug: any worker raced to claim the task before FM ever saw it.
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

  // M3 issue 1: claim also sets a lease so a crashed daemon's task can be
  // reclaimed instead of orphaned forever.
  it('claim sets lease_expires_at roughly leaseTtlSeconds in the future', async () => {
    const taskId = await createTask(hub, cookie);
    const before = Date.now();
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${device1.token}` },
    });
    expect(res.statusCode).toBe(200);

    const task = await hub.db
      .select({ leaseExpiresAt: schema.tasks.leaseExpiresAt })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.leaseExpiresAt).not.toBeNull();
    // Default TTL is 1800s; assert the lease lands well beyond "now" without
    // hardcoding tight bounds around timer jitter.
    expect((task!.leaseExpiresAt as Date).getTime()).toBeGreaterThan(before + 1_000_000);
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

describe('POST /tasks/:id/heartbeat (M3 issue 1)', () => {
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

  /** Create a task and claim it with device1, returns the task id. */
  async function createAndClaimTask(): Promise<string> {
    const taskId = await createTask(hub, cookie);
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${device1.token}` },
    });
    return taskId;
  }

  it('owning device extends the lease and gets ok:true + leaseExpiresAt', async () => {
    const taskId = await createAndClaimTask();
    const before = await hub.db
      .select({ leaseExpiresAt: schema.tasks.leaseExpiresAt })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/heartbeat`,
      headers: { authorization: `Bearer ${device1.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; leaseExpiresAt: number };
    expect(body.ok).toBe(true);
    expect(typeof body.leaseExpiresAt).toBe('number');

    const after = await hub.db
      .select({ leaseExpiresAt: schema.tasks.leaseExpiresAt })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect((after!.leaseExpiresAt as Date).getTime()).toBeGreaterThanOrEqual(
      (before!.leaseExpiresAt as Date).getTime(),
    );
    expect((after!.leaseExpiresAt as Date).getTime()).toBe(body.leaseExpiresAt);
  });

  it('heartbeat writes no task_history row and no bus event (too chatty per design)', async () => {
    const taskId = await createAndClaimTask();
    let busEvents = 0;
    hub.bus.subscribe(() => {
      busEvents++;
    });

    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/heartbeat`,
      headers: { authorization: `Bearer ${device1.token}` },
    });

    expect(busEvents).toBe(0);
    const history = await hub.db
      .select()
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, taskId));
    expect(history.filter((h) => h.eventName === 'task.heartbeat')).toHaveLength(0);
  });

  it('returns 409 lease_lost for a device that does not own the task', async () => {
    const taskId = await createAndClaimTask();
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/heartbeat`,
      headers: { authorization: `Bearer ${device2.token}` },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('lease_lost');
  });

  it('returns 409 lease_lost for a task that is not in_progress (e.g. already completed)', async () => {
    const taskId = await createAndClaimTask();
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/complete`,
      headers: { authorization: `Bearer ${device1.token}` },
    });

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/heartbeat`,
      headers: { authorization: `Bearer ${device1.token}` },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('lease_lost');
  });

  it('returns 409 lease_lost for a non-existent task', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks/fl-9999/heartbeat',
      headers: { authorization: `Bearer ${device1.token}` },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('lease_lost');
  });

  it('requires device auth (user session returns 401)', async () => {
    const taskId = await createAndClaimTask();
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/heartbeat`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 policy_denied for an orchestrator device (role:worker allow only)', async () => {
    const taskId = await createAndClaimTask();
    const fm = await registerDevice(hub, cookie, 'fm-device', {
      agentId: 'forge-master',
      deviceType: 'orchestrator',
    });
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/heartbeat`,
      headers: { authorization: `Bearer ${fm.token}` },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('policy_denied');
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

  it('contextSnapshot is baked from workspace context docs at assignment', async () => {
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createWsTask('pending_dispatcher_action');

    // Upload a context doc to the workspace
    await hub.fastify.inject({
      method: 'PUT',
      url: `/workspaces/${workspaceId}/context-docs/arch`,
      headers: { cookie },
      payload: { content: '# Architecture\nKey decisions here.' },
    });

    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'architect' },
    });

    const task = await hub.db
      .select({ contextSnapshot: schema.tasks.contextSnapshot })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();

    expect(task?.contextSnapshot).not.toBeNull();
    const snapshot = JSON.parse(task!.contextSnapshot!) as Array<{ name: string; content: string }>;
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.name).toBe('arch');
    expect(snapshot[0]!.content).toBe('# Architecture\nKey decisions here.');
  });

  it('contextSnapshot is null when workspace has no context docs', async () => {
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createWsTask('pending_dispatcher_action');

    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'architect' },
    });

    const task = await hub.db
      .select({ contextSnapshot: schema.tasks.contextSnapshot })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();

    expect(task?.contextSnapshot).toBeNull();
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

  // OPS-1 originally asserted orchestrators get policy_denied on task:fail.
  // The FM quarantine feature (issue 44) retires that default: orchestrators
  // now have a builtin task:fail allow, and the route-level guards scope it
  // to pending_dispatcher_action tasks only (see the issue 44 tests below,
  // which cover the worker-cannot and wrong-status cases the old test
  // protected against).
  it('worker device can fail its own in_progress task (policy allow check)', async () => {
    const taskId = await createAndClaimTask();
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { reason: 'policy allow test' },
    });
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // FM quarantine fail-path (issue 44): an orchestrator device may fail a task
  // stuck in pending_dispatcher_action after repeated triage deferrals.
  // -------------------------------------------------------------------------

  /** Create a workspace task and force it into pending_dispatcher_action. */
  async function createInboxTask(): Promise<string> {
    // Each test gets a fresh in-memory hub, so a constant slug cannot collide.
    const workspaceId = await createWorkspace(hub, cookie, { name: 'Fail WS', slug: 'fail-ws' });
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'qr', title: 'Quarantine candidate' },
    });
    const id = (res.json() as { id: string }).id;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, id));
    return id;
  }

  it('orchestrator can fail a pending_dispatcher_action task (quarantine, issue 44)', async () => {
    const fm = await registerDevice(hub, cookie, 'fm-device', {
      agentId: 'forge-master',
      deviceType: 'orchestrator',
    });
    const taskId = await createInboxTask();

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${fm.token}` },
      payload: { reason: 'quarantined after 3 triage deferrals' },
    });
    expect(res.statusCode).toBe(200);

    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('failed');

    const history = await hub.db
      .select()
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, taskId));
    const failEvents = history.filter((h) => h.eventName === 'task.failed');
    expect(failEvents).toHaveLength(1);
    const payload = failEvents[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.['reason']).toBe('quarantined after 3 triage deferrals');
  });

  it('worker device cannot fail a pending_dispatcher_action task (issue 44)', async () => {
    const taskId = await createInboxTask();

    // deviceToken belongs to a plain worker device registered in beforeEach.
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { reason: 'should not be allowed' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('orchestrator_required');

    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('pending_dispatcher_action');
  });

  it('orchestrator still cannot fail a pending_agent task (issue 44 scope guard)', async () => {
    const fm = await registerDevice(hub, cookie, 'fm-device-2', {
      agentId: 'forge-master',
      deviceType: 'orchestrator',
    });
    const taskId = await createTask(hub, cookie); // flat task, pending_agent

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${fm.token}` },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('not_in_progress');
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
    // Second cancel: task is now cancelled (terminal) -> already_terminal
    const r2 = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    expect(r2.statusCode).toBe(409);
    expect((r2.json() as { error: string }).error).toBe('already_terminal');
  });

  it('task:cancel blocked by workspace DB deny rule returns policy_denied (Heimdall enforcement)', async () => {
    // Create a workspace-scoped deny rule for all users on task:cancel.
    // Before checkPolicy enforcement this rule is never evaluated and cancel succeeds.
    // After enforcement the rule fires and returns policy_denied.
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'user:*', action: 'task:cancel', effect: 'deny', priority: 200 },
    });

    const taskId = await createWsTask('pending_agent');
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: string; action?: string };
    expect(body.error).toBe('policy_denied');
    expect(body.action).toBe('task:cancel');
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

// ---------------------------------------------------------------------------
// Assign identifier validation (issue 45): personality NAMES are the canonical
// identifier domain (daemons claim with FORGE_DAEMON_AGENT_ID names). The assign
// endpoints must resolve workspace-agent row IDs to names, accept known names or
// live device agentIds as-is, and reject everything else with 422 unknown_agent.
// ---------------------------------------------------------------------------

describe('assign identifier validation (issue 45)', () => {
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

  async function createInboxTask(): Promise<string> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'val', title: 'Validated assignment task' },
    });
    const id = (res.json() as { id: string }).id;
    await hub.db
      .update(schema.tasks)
      .set({ status: 'pending_dispatcher_action' })
      .where(eq(schema.tasks.id, id));
    return id;
  }

  /** Register a workspace agent and return its row id. */
  async function registerWorkspaceAgent(name: string): Promise<string> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/agents`,
      headers: { cookie },
      payload: { name, personality: name, runtimeId: 'background' },
    });
    return (res.json() as { id: string }).id;
  }

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  it('device path resolves a workspace-agent row ID to the agent NAME', async () => {
    // Observed live: FM assigned the nanoid row id ('rnDR...') instead of 'furnace',
    // making the task unclaimable by any worker (workers claim by personality name).
    const rowId = await registerWorkspaceAgent('smelter');
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createInboxTask();

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: rowId },
    });
    expect(res.statusCode).toBe(200);

    const task = await hub.db
      .select({ assignedAgentId: schema.tasks.assignedAgentId, status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.status).toBe('assigned');
    expect(task?.assignedAgentId).toBe('smelter');
  });

  it('device path stores a workspace agent NAME as-is', async () => {
    await registerWorkspaceAgent('smelter');
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createInboxTask();

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'smelter' },
    });
    expect(res.statusCode).toBe(200);

    const task = await hub.db
      .select({ assignedAgentId: schema.tasks.assignedAgentId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.assignedAgentId).toBe('smelter');
  });

  it('device path accepts the agentId of an active device of the owning user', async () => {
    // 'custom-daemon' is not a registered workspace agent, but a live daemon
    // identifies as it (FORGE_DAEMON_AGENT_ID), so assignment must be claimable.
    await registerDevice(hub, cookie, 'custom-daemon-device', { agentId: 'custom-daemon' });
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createInboxTask();

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'custom-daemon' },
    });
    expect(res.statusCode).toBe(200);

    const task = await hub.db
      .select({ assignedAgentId: schema.tasks.assignedAgentId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.assignedAgentId).toBe('custom-daemon');
  });

  it('device path rejects an unknown agent identifier with 422 unknown_agent', async () => {
    const { token: fmToken } = await registerOrchestratorDevice();
    const taskId = await createInboxTask();

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'no-such-agent' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('unknown_agent');

    const task = await hub.db
      .select({ assignedAgentId: schema.tasks.assignedAgentId, status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.assignedAgentId).toBeNull();
    expect(task?.status).toBe('pending_dispatcher_action');
  });

  it('user path resolves a workspace-agent row ID to the agent NAME', async () => {
    const rowId = await registerWorkspaceAgent('smelter');
    const taskId = await createInboxTask();
    await hub.db.update(schema.tasks).set({ status: 'pending_agent' }).where(eq(schema.tasks.id, taskId));

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
      payload: { agentId: rowId },
    });
    expect(res.statusCode).toBe(200);

    const task = await hub.db
      .select({ assignedAgentId: schema.tasks.assignedAgentId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .get();
    expect(task?.assignedAgentId).toBe('smelter');
  });

  it('user path rejects an unknown agent identifier with 422 unknown_agent', async () => {
    const taskId = await createInboxTask();
    await hub.db.update(schema.tasks).set({ status: 'pending_agent' }).where(eq(schema.tasks.id, taskId));

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
      payload: { agentId: 'no-such-agent' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('unknown_agent');
  });

  it('user path can still clear assignment with agentId null (no validation)', async () => {
    const taskId = await createInboxTask();
    await hub.db.update(schema.tasks).set({ status: 'pending_agent' }).where(eq(schema.tasks.id, taskId));

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { cookie },
      payload: { agentId: null },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('review tasks', () => {
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

  it('POST workspace task with taskKind=review stores taskKind and reviewConfig', async () => {
    const reviewConfig = JSON.stringify({
      reviewer: 'temper',
      targetType: 'diff',
      focus: 'Check error handling',
    });
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: {
        projectPrefix: 'rv',
        title: 'Review: feat/review-tasks diff',
        description: 'diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts',
        taskKind: 'review',
        reviewConfig,
      },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const task = await hub.db
      .select({
        taskKind: schema.tasks.taskKind,
        reviewConfig: schema.tasks.reviewConfig,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    expect(task?.taskKind).toBe('review');
    expect(task?.reviewConfig).toBe(reviewConfig);
  });

  it('GET workspace tasks includes taskKind and reviewConfig fields', async () => {
    const reviewConfig = JSON.stringify({ reviewer: 'loki', targetType: 'diff' });
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: {
        projectPrefix: 'rv',
        title: 'Review task',
        taskKind: 'review',
        reviewConfig,
      },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { tasks } = res.json() as { tasks: Array<{ taskKind: string; reviewConfig: string | null }> };
    expect(tasks[0]?.taskKind).toBe('review');
    expect(tasks[0]?.reviewConfig).toBe(reviewConfig);
  });

  it('POST workspace task without taskKind defaults to coding', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'rv', title: 'Normal task' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const task = await hub.db
      .select({ taskKind: schema.tasks.taskKind, reviewConfig: schema.tasks.reviewConfig })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, id))
      .get();
    expect(task?.taskKind).toBe('coding');
    expect(task?.reviewConfig).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task Sequencing
// ---------------------------------------------------------------------------

describe('task sequencing', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  const TWO_PHASE_SPEC = {
    phases: [
      { title: 'Design', role: 'architect', prompt: 'Design the feature.' },
      { title: 'Implement', role: 'engineer', prompt: 'Implement the design.' },
    ],
  };

  beforeEach(async () => {
    process.env['FORGE_SEQUENCES_ENABLED'] = '1';
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
  });

  afterEach(async () => {
    delete process.env['FORGE_SEQUENCES_ENABLED'];
    await hub.close();
  });

  it('T01 - POST with sequenceSpec creates root in sequenced_running and phase-0 child', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'seq', title: 'Two-phase task', sequenceSpec: TWO_PHASE_SPEC },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    expect(id).toBe('seq-001');

    const root = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, 'seq-001')).get();
    expect(root?.status).toBe('sequenced_running');
    expect(root?.sequenceSpec).not.toBeNull();

    const phase0 = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, 'seq-001-p0')).get();
    expect(phase0).not.toBeUndefined();
    expect(phase0?.phaseIndex).toBe(0);
    expect(phase0?.status).toBe('pending_agent');
    expect(phase0?.assignedAgentId).toBe('architect');
    expect(phase0?.parentId).toBe('seq-001');
  });

  it('T02 - GET workspace task includes phases array', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'seq', title: 'Two-phase task', sequenceSpec: TWO_PHASE_SPEC },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks/seq-001`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const task = res.json() as { phases: Array<{ phaseIndex: number; status: string }> };
    expect(Array.isArray(task.phases)).toBe(true);
    expect(task.phases).toHaveLength(2);
    expect(task.phases[0]?.status).toBe('active');
    expect(task.phases[1]?.status).toBe('pending');
  });

  it('T03 - phase task does not appear in default workspace task list', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'seq', title: 'Two-phase task', sequenceSpec: TWO_PHASE_SPEC },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { tasks } = res.json() as { tasks: Array<{ id: string }> };
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain('seq-001');
    expect(ids).not.toContain('seq-001-p0');
  });

  it('T04 - completing phase-0 via workspace endpoint creates phase-1 and keeps root sequenced_running', async () => {
    const { token: archToken } = await registerDevice(hub, cookie, 'arch-device', { agentId: 'architect' });

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'seq', title: 'Two-phase task', sequenceSpec: TWO_PHASE_SPEC },
    });

    // Claim phase-0
    await hub.fastify.inject({
      method: 'POST',
      url: '/tasks/seq-001-p0/claim',
      headers: { authorization: `Bearer ${archToken}` },
    });

    // Complete phase-0
    const completeRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/seq-001-p0/complete`,
      headers: { authorization: `Bearer ${archToken}` },
      payload: { result: 'Design complete.' },
    });
    expect(completeRes.statusCode).toBe(200);

    // phase-0 should be completed
    const p0 = await hub.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, 'seq-001-p0')).get();
    expect(p0?.status).toBe('completed');

    // root should still be sequenced_running (not sequenced_complete yet)
    const root = await hub.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, 'seq-001')).get();
    expect(root?.status).toBe('sequenced_running');

    // phase-1 should now exist
    const p1 = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, 'seq-001-p1')).get();
    expect(p1).not.toBeUndefined();
    expect(p1?.phaseIndex).toBe(1);
    expect(p1?.assignedAgentId).toBe('engineer');
  });

  it('T05 - completing last phase marks root sequenced_complete', async () => {
    const { token: archToken } = await registerDevice(hub, cookie, 'arch-device', { agentId: 'architect' });
    const { token: engToken } = await registerDevice(hub, cookie, 'eng-device', { agentId: 'engineer' });

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'seq', title: 'Two-phase task', sequenceSpec: TWO_PHASE_SPEC },
    });

    // Complete phase-0
    await hub.fastify.inject({ method: 'POST', url: '/tasks/seq-001-p0/claim', headers: { authorization: `Bearer ${archToken}` } });
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/seq-001-p0/complete`,
      headers: { authorization: `Bearer ${archToken}` },
      payload: { result: 'Design done.' },
    });

    // Complete phase-1
    await hub.fastify.inject({ method: 'POST', url: '/tasks/seq-001-p1/claim', headers: { authorization: `Bearer ${engToken}` } });
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/seq-001-p1/complete`,
      headers: { authorization: `Bearer ${engToken}` },
      payload: { result: 'Implementation done.' },
    });

    const root = await hub.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, 'seq-001')).get();
    expect(root?.status).toBe('sequenced_complete');
  });

  it('T06 - cancel cascades to phase children with history events', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'seq', title: 'Two-phase task', sequenceSpec: TWO_PHASE_SPEC },
    });

    const cancelRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/seq-001/cancel`,
      headers: { cookie },
    });
    expect(cancelRes.statusCode).toBe(200);

    const p0 = await hub.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, 'seq-001-p0')).get();
    expect(p0?.status).toBe('cancelled');

    const history = await hub.db
      .select({ eventName: schema.taskHistory.eventName, payload: schema.taskHistory.payload })
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, 'seq-001-p0'));
    const cancelEvent = history.find((h) => h.eventName === 'task.phase_cancelled');
    expect(cancelEvent).not.toBeUndefined();
  });

  it('T07 - stats endpoint counts sequenced root once, not phase children', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'seq', title: 'Sequenced task', sequenceSpec: TWO_PHASE_SPEC },
    });

    const statsRes = await hub.fastify.inject({
      method: 'GET',
      url: '/tasks/stats',
      headers: { cookie },
    });
    expect(statsRes.statusCode).toBe(200);
    const { total } = statsRes.json() as { total: number };
    expect(total).toBe(1);
  });

  it('T08 - phase retry endpoint resets failed phase child, keeps root in sequenced_running', async () => {
    const { token: archToken } = await registerDevice(hub, cookie, 'arch-device', { agentId: 'architect' });

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'seq', title: 'Two-phase task', sequenceSpec: TWO_PHASE_SPEC },
    });

    // Claim and fail phase-0
    await hub.fastify.inject({ method: 'POST', url: '/tasks/seq-001-p0/claim', headers: { authorization: `Bearer ${archToken}` } });
    await hub.fastify.inject({
      method: 'POST',
      url: '/tasks/seq-001-p0/fail',
      headers: { authorization: `Bearer ${archToken}` },
      payload: { reason: 'test failure' },
    });

    const p0Before = await hub.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, 'seq-001-p0')).get();
    expect(p0Before?.status).toBe('failed');

    // Retry via phase retry endpoint
    const retryRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/seq-001/phases/0/retry`,
      headers: { cookie },
    });
    expect(retryRes.statusCode).toBe(200);

    const p0After = await hub.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, 'seq-001-p0')).get();
    expect(p0After?.status).toBe('pending_agent');

    const root = await hub.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, 'seq-001')).get();
    expect(root?.status).toBe('sequenced_running');
  });
});

// ---------------------------------------------------------------------------
// Task Dependency Graph
// ---------------------------------------------------------------------------

describe('task dependency graph', () => {
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

  it('D01 - task with unmet deps starts in waiting_on_deps', async () => {
    // Create dep task
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dep', title: 'Dependency task' },
    });

    // Create dependent task
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dep', title: 'Dependent task', dependsOn: ['dep-001'] },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const task = await hub.db.select({ status: schema.tasks.status, dependsOn: schema.tasks.dependsOn }).from(schema.tasks).where(eq(schema.tasks.id, id)).get();
    expect(task?.status).toBe('waiting_on_deps');
    expect(JSON.parse(task?.dependsOn ?? '[]')).toEqual(['dep-001']);
  });

  it('D02 - completing the dep task unblocks the waiting task', async () => {
    const { token: engToken } = await registerDevice(hub, cookie, 'eng-device', { agentId: 'engineer' });

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dep', title: 'Dependency task', assignedAgentId: 'engineer' },
    });

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dep', title: 'Dependent task', dependsOn: ['dep-001'] },
    });

    // Verify waiting_on_deps
    const before = await hub.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, 'dep-002')).get();
    expect(before?.status).toBe('waiting_on_deps');

    // Complete dep-001
    await hub.fastify.inject({ method: 'POST', url: '/tasks/dep-001/claim', headers: { authorization: `Bearer ${engToken}` } });
    await hub.fastify.inject({
      method: 'POST',
      url: '/tasks/dep-001/complete',
      headers: { authorization: `Bearer ${engToken}` },
    });

    // dep-002 is unassigned, so the dep-release routes it to the dispatcher inbox
    // (issue 2: FM-as-front-door). The previous assertion (pending_agent) encoded the bug.
    const after = await hub.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, 'dep-002')).get();
    expect(after?.status).toBe('pending_dispatcher_action');
  });

  it('D02b - dep-release routes a pre-assigned waiting task to pending_agent (issue 2)', async () => {
    const { token: engToken } = await registerDevice(hub, cookie, 'eng-device', { agentId: 'engineer' });

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dep', title: 'Dependency task', assignedAgentId: 'engineer' },
    });

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dep', title: 'Dependent pre-assigned task', dependsOn: ['dep-001'], assignedAgentId: 'furnace' },
    });

    const before = await hub.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, 'dep-002')).get();
    expect(before?.status).toBe('waiting_on_deps');

    await hub.fastify.inject({ method: 'POST', url: '/tasks/dep-001/claim', headers: { authorization: `Bearer ${engToken}` } });
    await hub.fastify.inject({
      method: 'POST',
      url: '/tasks/dep-001/complete',
      headers: { authorization: `Bearer ${engToken}` },
    });

    // Pre-assigned tasks skip the dispatcher inbox and go straight to the claimable pool.
    const after = await hub.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, 'dep-002')).get();
    expect(after?.status).toBe('pending_agent');
  });

  it('D03 - task cannot depend on a phase task (phase children are internal)', async () => {
    process.env['FORGE_SEQUENCES_ENABLED'] = '1';
    // Create a sequenced task (creates dep-001 root + dep-001-p0 phase child)
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: {
        projectPrefix: 'dep',
        title: 'Sequenced task',
        sequenceSpec: {
          phases: [
            { title: 'P0', role: 'architect', prompt: 'Phase 0.' },
            { title: 'P1', role: 'engineer', prompt: 'Phase 1.' },
          ],
        },
      },
    });
    delete process.env['FORGE_SEQUENCES_ENABLED'];

    // Try to depend on the phase child (dep-001-p0 is an internal phase ID)
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dep', title: 'Depends on phase child', dependsOn: ['dep-001-p0'] },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: string };
    expect(body.error).toBe('invalid_dep_phase_task');
  });

  it('D04 - cancelled dep sets blockedReason on waiting task', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dep', title: 'Dependency task' },
    });

    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dep', title: 'Dependent task', dependsOn: ['dep-001'] },
    });

    // Cancel the dep
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks/dep-001/cancel`,
      headers: { cookie },
    });

    // The unblocking pass runs on completion. Trigger via a separate task completion.
    const { token: engToken } = await registerDevice(hub, cookie, 'eng-device', { agentId: 'engineer' });
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dep', title: 'Trigger task', assignedAgentId: 'engineer' },
    });
    await hub.fastify.inject({ method: 'POST', url: '/tasks/dep-003/claim', headers: { authorization: `Bearer ${engToken}` } });
    await hub.fastify.inject({ method: 'POST', url: '/tasks/dep-003/complete', headers: { authorization: `Bearer ${engToken}` } });

    const blocked = await hub.db
      .select({ blockedReason: schema.tasks.blockedReason })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, 'dep-002'))
      .get();
    expect(blocked?.blockedReason).toContain('dep_cancelled');
  });

  it('D05 - unassigned task with no deps starts in pending_dispatcher_action (issue 2)', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'dep', title: 'No-dep task', dependsOn: [] },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    // FM-as-front-door (issue 2): deps are satisfied but no agent is assigned,
    // so the task goes to the dispatcher inbox rather than the claimable pool.
    const task = await hub.db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, id)).get();
    expect(task?.status).toBe('pending_dispatcher_action');
  });
});

// ---------------------------------------------------------------------------
// Reclaim sweep (M3 issue 1). The interval itself lives in app.ts; these
// tests call the exported sweepExpiredLeases function directly, matching the
// design doc's test-plan instruction (TEST_HUB_CONFIG sets
// reclaimSweepSeconds: 0 so no background timer races these assertions).
// ---------------------------------------------------------------------------

describe('sweepExpiredLeases (M3 issue 1)', () => {
  let hub: Hub;
  let cookie: string;
  let device1: { id: string; token: string };

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
    device1 = await registerDevice(hub, cookie, 'device-1');
  });

  afterEach(async () => {
    await hub.close();
  });

  /** Claim taskId with the given device token, then force its lease into the past. */
  async function claimAndExpireLease(taskId: string, deviceToken: string): Promise<void> {
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    await hub.db
      .update(schema.tasks)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.tasks.id, taskId));
  }

  it('ignores in_progress tasks whose lease has not expired', async () => {
    const taskId = await createTask(hub, cookie);
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${device1.token}` },
    });

    const result = await sweepExpiredLeases(hub.db, hub.bus, { maxReclaims: 3 });
    expect(result).toEqual({ requeued: 0, failed: 0 });

    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('in_progress');
  });

  it('requeues an unrouted expired task to pending_agent and increments reclaim_count', async () => {
    const taskId = await createTask(hub, cookie);
    await claimAndExpireLease(taskId, device1.token);

    const result = await sweepExpiredLeases(hub.db, hub.bus, { maxReclaims: 3 });
    expect(result).toEqual({ requeued: 1, failed: 0 });

    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('pending_agent');
    expect(task?.assignedDeviceId).toBeNull();
    expect(task?.leaseExpiresAt).toBeNull();
    expect(task?.reclaimCount).toBe(1);
  });

  it('requeues a routed expired task to assigned so the same worker re-claims it', async () => {
    const routedDevice = await registerDevice(hub, cookie, 'routed-device', { agentId: 'engineer' });
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'Routed task', assignedAgentId: 'engineer' },
    });
    const { id: taskId } = createRes.json() as { id: string };
    await claimAndExpireLease(taskId, routedDevice.token);

    const result = await sweepExpiredLeases(hub.db, hub.bus, { maxReclaims: 3 });
    expect(result).toEqual({ requeued: 1, failed: 0 });

    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('assigned');
    expect(task?.assignedAgentId).toBe('engineer');
    expect(task?.reclaimCount).toBe(1);
  });

  it('emits a task.lease_reclaimed bus event and history row when requeued under the cap', async () => {
    const taskId = await createTask(hub, cookie);
    await claimAndExpireLease(taskId, device1.token);

    const busEvents: Array<{ name: string; payload: Record<string, unknown> }> = [];
    hub.bus.subscribe((env) => busEvents.push({ name: env.name, payload: env.payload as Record<string, unknown> }));

    await sweepExpiredLeases(hub.db, hub.bus, { maxReclaims: 3 });

    const reclaimed = busEvents.find((e) => e.name === 'task.lease_reclaimed');
    expect(reclaimed).toBeDefined();
    expect(reclaimed?.payload['reclaimCount']).toBe(1);
    expect(reclaimed?.payload['taskId']).toBe(taskId);

    const history = await hub.db.select().from(schema.taskHistory).where(eq(schema.taskHistory.taskId, taskId));
    expect(history.filter((h) => h.eventName === 'task.lease_reclaimed')).toHaveLength(1);
  });

  it('fails a task permanently once reclaim_count would exceed maxReclaims', async () => {
    const taskId = await createTask(hub, cookie);
    await claimAndExpireLease(taskId, device1.token);
    // Simulate a task already at the cap from prior sweep passes.
    await hub.db.update(schema.tasks).set({ reclaimCount: 3 }).where(eq(schema.tasks.id, taskId));

    const busEvents: string[] = [];
    hub.bus.subscribe((env) => busEvents.push(env.name));

    const result = await sweepExpiredLeases(hub.db, hub.bus, { maxReclaims: 3 });
    expect(result).toEqual({ requeued: 0, failed: 1 });

    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('failed');
    expect(task?.assignedDeviceId).toBeNull();
    expect(task?.leaseExpiresAt).toBeNull();

    const history = await hub.db.select().from(schema.taskHistory).where(eq(schema.taskHistory.taskId, taskId));
    const failEvent = history.find((h) => h.eventName === 'task.failed');
    expect(failEvent).toBeDefined();
    expect((failEvent?.payload as Record<string, unknown>)['reason']).toBe('lease_expired_max_reclaims');

    expect(busEvents).toContain('task.failed');
    expect(busEvents).not.toContain('task.lease_reclaimed');
  });

  it('over-cap phase task failure sets the root blockedReason and writes task.phase_blocked (mirrors stale-phase bookkeeping)', async () => {
    process.env['FORGE_SEQUENCES_ENABLED'] = '1';
    try {
      const workspaceId = await createWorkspace(hub, cookie);
      const architectDevice = await registerDevice(hub, cookie, 'architect-device', { agentId: 'architect' });

      const createRes = await hub.fastify.inject({
        method: 'POST',
        url: `/workspaces/${workspaceId}/tasks`,
        headers: { cookie },
        payload: {
          projectPrefix: 'swp',
          title: 'Phase sweep task',
          sequenceSpec: {
            phases: [
              { title: 'Design', role: 'architect', prompt: 'Design the feature.' },
              { title: 'Implement', role: 'engineer', prompt: 'Implement the design.' },
            ],
          },
        },
      });
      expect(createRes.statusCode).toBe(201);
      const { id: rootId } = createRes.json() as { id: string };
      const phase0Id = `${rootId}-p0`;

      await claimAndExpireLease(phase0Id, architectDevice.token);
      await hub.db.update(schema.tasks).set({ reclaimCount: 3 }).where(eq(schema.tasks.id, phase0Id));

      const result = await sweepExpiredLeases(hub.db, hub.bus, { maxReclaims: 3 });
      expect(result).toEqual({ requeued: 0, failed: 1 });

      const phase0 = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, phase0Id)).get();
      expect(phase0?.status).toBe('failed');

      const root = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, rootId)).get();
      expect(root?.blockedReason).toBe('phase_failed:0');

      // Task creation itself may already have written a task.phase_blocked row
      // (role_unavailable:<role>, if the device-availability check at create
      // time didn't see the just-registered device yet), find the one the
      // sweep wrote rather than assuming it is the only one.
      const rootHistory = await hub.db.select().from(schema.taskHistory).where(eq(schema.taskHistory.taskId, rootId));
      const blockedEvent = rootHistory.find(
        (h) => h.eventName === 'task.phase_blocked' && (h.payload as Record<string, unknown>)['reason'] === 'phase_failed:0',
      );
      expect(blockedEvent).toBeDefined();
    } finally {
      delete process.env['FORGE_SEQUENCES_ENABLED'];
    }
  });

  it('a raced task (status changed away from in_progress before the sweep writes) is left untouched', async () => {
    const taskId = await createTask(hub, cookie);
    await claimAndExpireLease(taskId, device1.token);
    // Simulate another writer completing the task between the sweep's SELECT and UPDATE
    // by completing it directly through the route before invoking the sweep.
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/complete`,
      headers: { authorization: `Bearer ${device1.token}` },
    });

    const result = await sweepExpiredLeases(hub.db, hub.bus, { maxReclaims: 3 });
    expect(result).toEqual({ requeued: 0, failed: 0 });

    const task = await hub.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
    expect(task?.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Idempotency of terminal transitions (M3 issue 14 hub-side contract): a
// retried complete/fail call after a half-applied first attempt must return a
// benign non-5xx response, never a 500, so the daemon's retry-with-backoff
// path converges instead of looping forever.
// ---------------------------------------------------------------------------

describe('terminal transition idempotency (M3 issue 14)', () => {
  let hub: Hub;
  let cookie: string;
  let deviceToken: string;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    const admin = await setupAdmin(hub);
    cookie = admin.cookie;
    const dev = await registerDevice(hub, cookie, 'idempotency-device');
    deviceToken = dev.token;
  });

  afterEach(async () => {
    await hub.close();
  });

  async function createClaimAndComplete(): Promise<string> {
    const taskId = await createTask(hub, cookie);
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/complete`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    return taskId;
  }

  it('completing an already-completed task returns a benign non-5xx response, not a 500', async () => {
    const taskId = await createClaimAndComplete();

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/complete`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });

    expect(res.statusCode).toBeLessThan(500);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('already_completed');

    // The retry must not have produced a second history event or bus double-count.
    const history = await hub.db
      .select()
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, taskId));
    expect(history.filter((h) => h.eventName === 'task.completed')).toHaveLength(1);
  });

  it('failing an already-failed task returns a benign non-5xx response, not a 500', async () => {
    const taskId = await createTask(hub, cookie);
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { reason: 'first failure' },
    });

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { reason: 'retried after the first attempt seemingly timed out' },
    });

    expect(res.statusCode).toBeLessThan(500);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('not_in_progress');

    const history = await hub.db
      .select()
      .from(schema.taskHistory)
      .where(eq(schema.taskHistory.taskId, taskId));
    expect(history.filter((h) => h.eventName === 'task.failed')).toHaveLength(1);
  });

  it('failing an already-completed task returns a benign non-5xx response, not a 500', async () => {
    const taskId = await createClaimAndComplete();

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { reason: 'stale retry racing a completed task' },
    });

    expect(res.statusCode).toBeLessThan(500);
    expect(res.statusCode).toBe(409);
  });

  it('completing an already-failed task returns a benign non-5xx response, not a 500', async () => {
    const taskId = await createTask(hub, cookie);
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/fail`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/complete`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });

    expect(res.statusCode).toBeLessThan(500);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('task_failed');
  });
});
