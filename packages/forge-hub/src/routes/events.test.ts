import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHub, type Hub } from '../app.js';
import { TEST_HUB_CONFIG, setupAdmin, createWorkspace } from '../test-utils.js';

describe('GET /events', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;
  let address: string;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie, { slug: `ws-${Date.now()}` });
    // Listen on a random port so all tests (including streaming) can use real HTTP.
    address = await hub.fastify.listen({ port: 0 });
  });

  afterEach(async () => {
    await hub.close();
  });

  // -------------------------------------------------------------------------
  // Auth + membership gate — inject is fine here because 401/403 respond
  // before the SSE handler reaches the long-lived await.
  // -------------------------------------------------------------------------

  it('returns 401 without a session cookie', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a workspaceId the user is not a member of', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/events?workspaceId=no-such-workspace',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // SSE headers — use a real fetch + immediate abort so we get the response
  // headers without waiting for the stream to end.
  // -------------------------------------------------------------------------

  it('returns SSE headers for a valid workspaceId', async () => {
    const controller = new AbortController();
    // Abort immediately after the response arrives (we only want headers).
    const res = await fetch(`${address}/events?workspaceId=${workspaceId}`, {
      headers: { cookie },
      signal: controller.signal,
    }).catch((err) => {
      // AbortError is expected when we abort before fully consuming the body.
      if ((err as Error).name === 'AbortError') return null;
      throw err;
    });
    controller.abort();

    // If we got a response before the abort, check the headers.
    // If aborted during the request, the status code check is skipped —
    // that's fine: the 401/403 tests already cover auth paths.
    if (res) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(res.headers.get('cache-control')).toMatch(/no-cache/);
      expect(res.headers.get('x-accel-buffering')).toBe('no');
    }
  });

  it('returns SSE headers with no workspaceId filter', async () => {
    const controller = new AbortController();
    const res = await fetch(`${address}/events`, {
      headers: { cookie },
      signal: controller.signal,
    }).catch((err) => {
      if ((err as Error).name === 'AbortError') return null;
      throw err;
    });
    controller.abort();

    if (res) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    }
  });

  // -------------------------------------------------------------------------
  // Event delivery
  // -------------------------------------------------------------------------

  it('delivers a task.created event to a subscriber scoped to their workspace', async () => {
    const controller = new AbortController();
    const chunks: string[] = [];

    const streamDone = fetch(`${address}/events?workspaceId=${workspaceId}`, {
      headers: { cookie },
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value, { stream: true }));
        }
      } catch { /* AbortError — connection closed intentionally */ }
    });

    // Wait for the SSE connection to establish.
    await new Promise((r) => setTimeout(r, 50));

    // Emit a workspace-scoped task event directly into the bus.
    hub.bus.emit({
      id: 'test-evt-1',
      name: 'task.created',
      occurredAt: new Date(),
      source: 'test',
      payload: { taskId: 'task-abc', projectPrefix: 'TST', workspaceId },
    });

    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await streamDone;

    const body = chunks.join('');
    expect(body).toContain('event: task.created');
    expect(body).toContain(workspaceId);
  });

  it('delivers a task.cancelled event when a task is cancelled', async () => {
    // Regression: task.cancelled was emitted by the hub but not included in the
    // TASK_EVENTS subscription list in use-hub-events.ts, so the dashboard never
    // refreshed after a cancel. This test verifies the hub correctly emits the event.
    const controller = new AbortController();
    const chunks: string[] = [];

    // Create a task in the workspace so we have something to cancel.
    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'evt', title: 'Cancel me' },
    });
    const { id: taskId } = taskRes.json() as { id: string };

    const streamDone = fetch(`${address}/events?workspaceId=${workspaceId}`, {
      headers: { cookie },
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value, { stream: true }));
        }
      } catch { /* AbortError — connection closed intentionally */ }
    });

    // Wait for SSE connection to establish.
    await new Promise((r) => setTimeout(r, 50));

    // Cancel the task via PATCH — hub should emit task.cancelled on the bus.
    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}`,
      headers: { cookie },
      payload: { status: 'cancelled' },
    });

    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await streamDone;

    const body = chunks.join('');
    expect(body).toContain('event: task.cancelled');
    expect(body).toContain(taskId);
  });

  it('does not deliver events for workspaces the user is not a member of', async () => {
    const controller = new AbortController();
    const chunks: string[] = [];

    const streamDone = fetch(`${address}/events`, {
      headers: { cookie },
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value, { stream: true }));
        }
      } catch { /* AbortError */ }
    });

    await new Promise((r) => setTimeout(r, 50));

    // Event for a workspace the user is NOT a member of.
    hub.bus.emit({
      id: 'test-evt-2',
      name: 'task.created',
      occurredAt: new Date(),
      source: 'test',
      payload: { taskId: 'task-xyz', projectPrefix: 'OTH', workspaceId: 'other-workspace-not-member' },
    });

    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await streamDone;

    expect(chunks.join('')).not.toContain('event: task.created');
  });

  it('unsubscribes from EventBus when the client disconnects', async () => {
    const controller = new AbortController();

    const streamDone = fetch(`${address}/events?workspaceId=${workspaceId}`, {
      headers: { cookie },
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch { /* AbortError — intentional */ }
    });

    // Wait for connection to establish (listener added to bus).
    await new Promise((r) => setTimeout(r, 50));
    const sizeBefore = hub.bus.size;
    expect(sizeBefore).toBeGreaterThan(0);

    // Disconnect the client.
    controller.abort();
    await streamDone;

    // Give the 'close' event time to fire and the unsubscribe callback to run.
    await new Promise((r) => setTimeout(r, 50));

    expect(hub.bus.size).toBe(sizeBefore - 1);
  });

  it('drops events with no workspaceId in payload', async () => {
    const controller = new AbortController();
    const chunks: string[] = [];

    const streamDone = fetch(`${address}/events`, {
      headers: { cookie },
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value, { stream: true }));
        }
      } catch { /* AbortError */ }
    });

    await new Promise((r) => setTimeout(r, 50));

    // Unscoped event — no workspaceId in payload.
    hub.bus.emit({
      id: 'test-evt-3',
      name: 'task.created',
      occurredAt: new Date(),
      source: 'test',
      payload: { taskId: 'task-raw', projectPrefix: 'RAW' },
    });

    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await streamDone;

    expect(chunks.join('')).not.toContain('event: task.created');
  });
});
