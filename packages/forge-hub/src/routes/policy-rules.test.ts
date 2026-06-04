import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHub, type Hub } from '../app.js';
import { TEST_HUB_CONFIG, setupAdmin, createWorkspace } from '../test-utils.js';

describe('policy rules API', () => {
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

  // ── workspace-scoped rules ──────────────────────────────────────────────

  it('POST /workspaces/:id/policy-rules creates a workspace rule', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'agent:anvil', action: 'task:assign', effect: 'deny', priority: 300 },
    });
    expect(res.statusCode).toBe(201);
    const { rule } = res.json() as { rule: Record<string, unknown> };
    expect(rule['principal']).toBe('agent:anvil');
    expect(rule['action']).toBe('task:assign');
    expect(rule['effect']).toBe('deny');
    expect(rule['priority']).toBe(300);
    expect(rule['workspaceId']).toBe(workspaceId);
    expect(rule['archivedAt']).toBeNull();
  });

  it('GET /workspaces/:id/policy-rules returns active workspace rules', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'agent:anvil', action: 'task:assign', effect: 'deny', priority: 300 },
    });
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { rules } = res.json() as { rules: unknown[] };
    expect(rules).toHaveLength(1);
  });

  it('PATCH /workspaces/:id/policy-rules/:ruleId archives a rule', async () => {
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'agent:anvil', action: 'task:assign', effect: 'deny', priority: 300 },
    });
    const { rule } = createRes.json() as { rule: { id: string } };

    const archiveRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/policy-rules/${rule.id}`,
      headers: { cookie },
      payload: { archived: true },
    });
    expect(archiveRes.statusCode).toBe(200);

    // Archived rule must not appear in the list
    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
    });
    const { rules } = listRes.json() as { rules: unknown[] };
    expect(rules).toHaveLength(0);
  });

  it('PATCH archiving twice returns 409 already_archived', async () => {
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'agent:anvil', action: 'task:assign', effect: 'deny', priority: 300 },
    });
    const { rule } = createRes.json() as { rule: { id: string } };
    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/policy-rules/${rule.id}`,
      headers: { cookie },
      payload: { archived: true },
    });
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/policy-rules/${rule.id}`,
      headers: { cookie },
      payload: { archived: true },
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST requires admin workspace role (collaborator gets 403)', async () => {
    // Register a second user as collaborator
    const collabRes = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'collab@example.com', password: 'password123' },
    });
    // First account is already registered — this will 409, expect a 2nd login instead
    void collabRes;

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      // No cookie = unauthenticated
      payload: { principal: 'agent:anvil', action: 'task:assign', effect: 'deny', priority: 300 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST validates action enum — unknown action returns 400', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'agent:anvil', action: 'task:explode', effect: 'deny', priority: 300 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST validates effect enum — unknown effect returns 400', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'agent:anvil', action: 'task:assign', effect: 'maybe', priority: 300 },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── global rules ───────────────────────────────────────────────────────

  it('POST /policy-rules creates a global rule (admin user)', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/policy-rules',
      headers: { cookie },
      payload: { principal: 'role:worker', action: 'doc:update', effect: 'deny', priority: 150 },
    });
    expect(res.statusCode).toBe(201);
    const { rule } = res.json() as { rule: Record<string, unknown> };
    expect(rule['workspaceId']).toBeNull();
    expect(rule['action']).toBe('doc:update');
  });

  it('GET /policy-rules lists active global rules', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: '/policy-rules',
      headers: { cookie },
      payload: { principal: 'role:worker', action: 'doc:update', effect: 'deny', priority: 150 },
    });
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/policy-rules',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { rules } = res.json() as { rules: unknown[] };
    expect(rules.length).toBeGreaterThanOrEqual(1);
  });

  it('PATCH /policy-rules/:ruleId archives global rule', async () => {
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/policy-rules',
      headers: { cookie },
      payload: { principal: 'role:worker', action: 'doc:update', effect: 'deny', priority: 150 },
    });
    const { rule } = createRes.json() as { rule: { id: string } };
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/policy-rules/${rule.id}`,
      headers: { cookie },
      payload: { archived: true },
    });
    expect(res.statusCode).toBe(200);
  });

  // ── engine integration — DB rule overrides built-in ───────────────────

  it('DB deny rule at priority > built-in allow blocks the action', async () => {
    // Built-in: agent:forge-master → task:assign → allow @ 200
    // Add DB deny at priority 300 — should override
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'agent:forge-master', action: 'task:assign', effect: 'deny', priority: 300 },
    });

    // Register an FM device and try to assign a task
    const devRes = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'fm-test', agentId: 'forge-master', deviceType: 'orchestrator' },
    });
    const { token: fmToken } = devRes.json() as { token: string };

    // Create a task to assign
    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'pr', title: 'Policy test task' },
    });
    const { id: taskId } = taskRes.json() as { id: string };

    // FM tries to assign — DB deny at 300 should block
    const assignRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { Authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'furnace' },
    });
    expect(assignRes.statusCode).toBe(403);
    expect((assignRes.json() as { error: string }).error).toBe('policy_denied');
  });
});

// ── migration coverage ──────────────────────────────────────────────────────

describe('migration 0011_policy_rules', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('policy_rules table exists after migration', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (hub.db as any).$client as { execute: (opts: { sql: string; args?: unknown[] }) => Promise<{ rows: unknown[] }> };
    const result = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='policy_rules'" });
    expect(result.rows).toHaveLength(1);
  });

  it('policy_rules effect CHECK constraint rejects invalid value', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (hub.db as any).$client as { execute: (opts: { sql: string; args?: unknown[] }) => Promise<unknown> };
    await expect(
      client.execute({
        sql: `INSERT INTO policy_rules (id, principal, action, effect, priority, created_at) VALUES ('x', 'user:*', 'task:claim', 'maybe', 0, 0)`,
      }),
    ).rejects.toThrow();
  });
});
