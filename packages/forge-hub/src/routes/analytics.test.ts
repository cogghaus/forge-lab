import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHub, type Hub } from '../app.js';
import { schema } from '@forge-lab/core';
import { TEST_HUB_CONFIG, setupAdmin, createWorkspace } from '../test-utils.js';

// ---------------------------------------------------------------------------
// GET /workspaces/:id/analytics/overview
// ---------------------------------------------------------------------------

interface OverviewResponse {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  pendingTasks: number;
  inProgressTasks: number;
  cancelledTasks: number;
  completionRate: number;
  avgCompletionTimeMs: number | null;
  period: { from: string | null; to: string | null };
}

describe('GET /workspaces/:id/analytics/overview', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  beforeEach(async () => {
    hub = await createHub({ config: { ...TEST_HUB_CONFIG } });
    ({ cookie } = await setupAdmin(hub));
    workspaceId = await createWorkspace(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  it('requires auth - 401 without session', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/analytics/overview`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for non-existent workspace (membership guard)', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/workspaces/nonexistent/analytics/overview',
      headers: { cookie },
    });
    // requireWorkspaceMember returns 403 for non-member/non-existent workspaces
    // (avoids leaking which workspace IDs exist)
    expect(res.statusCode).toBe(403);
  });

  it('returns all-zero stats when no tasks exist and no date params', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/analytics/overview`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OverviewResponse;
    expect(body.totalTasks).toBe(0);
    expect(body.completedTasks).toBe(0);
    expect(body.failedTasks).toBe(0);
    expect(body.pendingTasks).toBe(0);
    expect(body.inProgressTasks).toBe(0);
    expect(body.cancelledTasks).toBe(0);
    expect(body.completionRate).toBe(0);
    expect(body.avgCompletionTimeMs).toBeNull();
    expect(body.period.from).toBeNull();
    expect(body.period.to).toBeNull();
  });

  it('returns correct all-time stats with tasks in workspace', async () => {
    const now = Date.now();
    await hub.db.insert(schema.tasks).values([
      {
        id: 'fl-001',
        projectPrefix: 'fl',
        title: 'T1',
        status: 'completed',
        assignedAt: new Date(now - 60_000),
        completedAt: new Date(now - 30_000),
        createdBy: 'user:test',
        workspaceId,
      },
      {
        id: 'fl-002',
        projectPrefix: 'fl',
        title: 'T2',
        status: 'completed',
        assignedAt: new Date(now - 120_000),
        completedAt: new Date(now - 60_000),
        createdBy: 'user:test',
        workspaceId,
      },
      {
        id: 'fl-003',
        projectPrefix: 'fl',
        title: 'T3',
        status: 'failed',
        createdBy: 'user:test',
        workspaceId,
      },
      {
        id: 'fl-004',
        projectPrefix: 'fl',
        title: 'T4',
        status: 'in_progress',
        createdBy: 'user:test',
        workspaceId,
      },
    ]);

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/analytics/overview`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OverviewResponse;
    expect(body.totalTasks).toBe(4);
    expect(body.completedTasks).toBe(2);
    expect(body.failedTasks).toBe(1);
    expect(body.inProgressTasks).toBe(1);
    expect(body.pendingTasks).toBe(0);
    expect(body.cancelledTasks).toBe(0);
    // completionRate = 2/4 = 0.5
    expect(body.completionRate).toBe(0.5);
    // avg of 30s and 60s = 45000ms (timestamps stored as epoch ms integers)
    expect(body.avgCompletionTimeMs).toBeGreaterThan(0);
    expect(body.avgCompletionTimeMs).toBeLessThan(120_000);
  });

  it('filters to date range when from and to provided', async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    // Task inside range (3 days ago)
    const inRange = new Date(now - 3 * dayMs);
    // Task outside range (20 days ago)
    const outOfRange = new Date(now - 20 * dayMs);

    await hub.db.insert(schema.tasks).values([
      {
        id: 'fl-001',
        projectPrefix: 'fl',
        title: 'Recent',
        status: 'completed',
        createdAt: inRange,
        assignedAt: new Date(inRange.getTime() - 30_000),
        completedAt: inRange,
        createdBy: 'user:test',
        workspaceId,
      },
      {
        id: 'fl-002',
        projectPrefix: 'fl',
        title: 'Old',
        status: 'completed',
        createdAt: outOfRange,
        createdBy: 'user:test',
        workspaceId,
      },
      // Cancelled task inside range — should appear in cancelledTasks
      {
        id: 'fl-003',
        projectPrefix: 'fl',
        title: 'Cancelled recent',
        status: 'cancelled',
        createdAt: inRange,
        createdBy: 'user:test',
        workspaceId,
      },
      // Cancelled task outside range — must NOT appear in cancelledTasks
      {
        id: 'fl-004',
        projectPrefix: 'fl',
        title: 'Cancelled old',
        status: 'cancelled',
        createdAt: outOfRange,
        createdBy: 'user:test',
        workspaceId,
      },
    ]);

    const from = new Date(now - 7 * dayMs).toISOString();
    const to = new Date(now + dayMs).toISOString();

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/analytics/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OverviewResponse;
    // Only in-range tasks: 1 completed + 1 cancelled
    expect(body.totalTasks).toBe(2);
    expect(body.completedTasks).toBe(1);
    expect(body.cancelledTasks).toBe(1);
    expect(body.period.from).toBe(from);
    expect(body.period.to).toBe(to);
  });

  it('returns zero stats for valid date range with no tasks in period', async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const from = new Date(now - 7 * dayMs).toISOString();
    const to = new Date(now + dayMs).toISOString();

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/analytics/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OverviewResponse;
    expect(body.totalTasks).toBe(0);
    expect(body.cancelledTasks).toBe(0);
    expect(body.completionRate).toBe(0);
    expect(body.avgCompletionTimeMs).toBeNull();
  });

  it('returns 400 when from is after to', async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const from = new Date(now + dayMs).toISOString(); // future
    const to = new Date(now - dayMs).toISOString();   // past

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/analytics/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when range exceeds 365 days', async () => {
    const now = Date.now();
    const from = new Date(now - 366 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(now).toISOString();

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/analytics/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('includes cancelledTasks count in overview response', async () => {
    await hub.db.insert(schema.tasks).values([
      { id: 'fl-001', projectPrefix: 'fl', title: 'Done', status: 'completed', createdBy: 'user:test', workspaceId },
      { id: 'fl-002', projectPrefix: 'fl', title: 'Zap1', status: 'cancelled', createdBy: 'user:test', workspaceId },
      { id: 'fl-003', projectPrefix: 'fl', title: 'Zap2', status: 'cancelled', createdBy: 'user:test', workspaceId },
    ]);

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/analytics/overview`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OverviewResponse;
    expect(body.totalTasks).toBe(3);
    expect(body.cancelledTasks).toBe(2);
    expect(body.completedTasks).toBe(1);
  });

  it('defaults to = now when only from is provided', async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const from = new Date(now - 7 * dayMs).toISOString();

    // Insert a task created 3 days ago
    await hub.db.insert(schema.tasks).values({
      id: 'fl-001',
      projectPrefix: 'fl',
      title: 'Recent task',
      status: 'completed',
      createdAt: new Date(now - 3 * dayMs),
      createdBy: 'user:test',
      workspaceId,
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/analytics/overview?from=${encodeURIComponent(from)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OverviewResponse;
    // Task within from..now should be counted
    expect(body.totalTasks).toBe(1);
    expect(body.period.from).toBe(from);
    expect(body.period.to).toBeDefined();
    expect(body.period.to).not.toBeNull();
  });
});
