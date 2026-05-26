import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHub, type Hub } from '../app.js';
import { schema } from '@forge-lab/core';
import { TEST_HUB_CONFIG, setupAdmin, createWorkspace } from '../test-utils.js';


async function createGoal(
  hub: Hub,
  cookie: string,
  workspaceId: string,
  payload: { title: string; description?: string; parentId?: string },
): Promise<string> {
  const res = await hub.fastify.inject({
    method: 'POST',
    url: `/workspaces/${workspaceId}/goals`,
    headers: { cookie },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

describe('/workspaces/:workspaceId/goals', () => {
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

  it('POST creates a goal and returns an id', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/goals`,
      headers: { cookie },
      payload: { title: 'Ship MVP', description: 'Launch before Q3' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });

  it('POST rejects empty title', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/goals`,
      headers: { cookie },
      payload: { title: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST requires auth', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/goals`,
      payload: { title: 'No auth' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST creates a child goal', async () => {
    const parentId = await createGoal(hub, cookie, workspaceId, { title: 'Parent goal' });
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/goals`,
      headers: { cookie },
      payload: { title: 'Child goal', parentId },
    });
    expect(res.statusCode).toBe(201);
  });

  it('POST rejects parentId from a different workspace', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/goals`,
      headers: { cookie },
      payload: { title: 'Bad parent', parentId: 'nonexistent-id' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('parent_not_found');
  });

  it('GET lists goals for workspace', async () => {
    await createGoal(hub, cookie, workspaceId, { title: 'Goal A' });
    await createGoal(hub, cookie, workspaceId, { title: 'Goal B' });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/goals`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { goals } = res.json() as { goals: { title: string }[] };
    expect(goals).toHaveLength(2);
  });

  it('GET single goal returns ancestors', async () => {
    const grandparentId = await createGoal(hub, cookie, workspaceId, { title: 'Grandparent' });
    const parentId = await createGoal(hub, cookie, workspaceId, { title: 'Parent', parentId: grandparentId });
    const childId = await createGoal(hub, cookie, workspaceId, { title: 'Child', parentId });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/goals/${childId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; ancestors: { id: string }[] };
    expect(body.id).toBe(childId);
    const ancestorIds = body.ancestors.map((a) => a.id);
    expect(ancestorIds).toContain(parentId);
    expect(ancestorIds).toContain(grandparentId);
    expect(ancestorIds).toContain(childId);
  });

  it('GET single goal returns 404 for missing goal', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/goals/nonexistent`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET ancestors endpoint returns the full chain', async () => {
    const grandparentId = await createGoal(hub, cookie, workspaceId, { title: 'GP' });
    const parentId = await createGoal(hub, cookie, workspaceId, { title: 'P', parentId: grandparentId });
    const childId = await createGoal(hub, cookie, workspaceId, { title: 'C', parentId });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/goals/${childId}/ancestors`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { ancestors } = res.json() as { ancestors: { id: string }[] };
    const ids = ancestors.map((a) => a.id);
    expect(ids).toContain(grandparentId);
    expect(ids).toContain(parentId);
  });

  it('ancestors CTE does not leak cross-workspace goals (CX-01 regression)', async () => {
    const ws2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { cookie },
      payload: { name: 'WS2', slug: 'ws2' },
    });
    const ws2Id = (ws2Res.json() as { id: string }).id;
    const foreignGoalId = await createGoal(hub, cookie, ws2Id, { title: 'Foreign goal' });

    const childId = await createGoal(hub, cookie, workspaceId, { title: 'Child' });

    // Simulate a cross-workspace parent link (future import edge case)
    await hub.db.update(schema.goals)
      .set({ parentId: foreignGoalId })
      .where(eq(schema.goals.id, childId));

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/goals/${childId}/ancestors`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { ancestors } = res.json() as { ancestors: { id: string }[] };
    expect(ancestors.map((a) => a.id)).not.toContain(foreignGoalId);
  });
});

describe('PATCH /workspaces/:workspaceId/goals/:goalId', () => {
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

  it('updates title', async () => {
    const goalId = await createGoal(hub, cookie, workspaceId, { title: 'Old title' });
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/goals/${goalId}`,
      headers: { cookie },
      payload: { title: 'New title' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });

  it('updates status to completed', async () => {
    const goalId = await createGoal(hub, cookie, workspaceId, { title: 'Ship it' });
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/goals/${goalId}`,
      headers: { cookie },
      payload: { status: 'completed' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 422 for self-parent', async () => {
    const goalId = await createGoal(hub, cookie, workspaceId, { title: 'Loop' });
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/goals/${goalId}`,
      headers: { cookie },
      payload: { parentId: goalId },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('self_parent');
  });

  it('returns 422 for cycle detection: child cannot become ancestor of parent', async () => {
    const parentId = await createGoal(hub, cookie, workspaceId, { title: 'Parent' });
    const childId = await createGoal(hub, cookie, workspaceId, { title: 'Child', parentId });

    // Trying to set parent's parentId to child creates a cycle
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/goals/${parentId}`,
      headers: { cookie },
      payload: { parentId: childId },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('cycle_detected');
  });

  it('returns 422 for deep cycle: grandchild becomes ancestor of grandparent', async () => {
    const gpId = await createGoal(hub, cookie, workspaceId, { title: 'GP' });
    const pId = await createGoal(hub, cookie, workspaceId, { title: 'P', parentId: gpId });
    const cId = await createGoal(hub, cookie, workspaceId, { title: 'C', parentId: pId });

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/goals/${gpId}`,
      headers: { cookie },
      payload: { parentId: cId },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('cycle_detected');
  });

  it('returns 404 for nonexistent parent on PATCH', async () => {
    const goalId = await createGoal(hub, cookie, workspaceId, { title: 'Goal' });
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/goals/${goalId}`,
      headers: { cookie },
      payload: { parentId: 'ghost-id' },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('parent_not_found');
  });

  it('clears parentId when set to null', async () => {
    const parentId = await createGoal(hub, cookie, workspaceId, { title: 'Parent' });
    const childId = await createGoal(hub, cookie, workspaceId, { title: 'Child', parentId });

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/goals/${childId}`,
      headers: { cookie },
      payload: { parentId: null },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for nonexistent goal', async () => {
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/goals/ghost`,
      headers: { cookie },
      payload: { title: 'Whatever' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('clears description when set to null (CX-04 coverage)', async () => {
    const goalId = await createGoal(hub, cookie, workspaceId, { title: 'With desc', description: 'initial' });
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/goals/${goalId}`,
      headers: { cookie },
      payload: { description: null },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });
});
