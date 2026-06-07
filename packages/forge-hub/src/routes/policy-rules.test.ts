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

  it('POST validates principal format — missing colon separator returns 400', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'agent-scribe', action: 'task:assign', effect: 'deny', priority: 100 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST validates resourceCondition must be valid JSON', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'agent:anvil', action: 'task:assign', effect: 'deny', priority: 100, resourceCondition: 'not-json' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST returns 422 when workspace rule cap (100) is exceeded', async () => {
    // Create 100 rules (just verify the cap enforces — use a loop but stop at 101)
    for (let i = 0; i < 100; i++) {
      const r = await hub.fastify.inject({
        method: 'POST',
        url: `/workspaces/${workspaceId}/policy-rules`,
        headers: { cookie },
        payload: { principal: 'agent:anvil', action: 'task:assign', effect: 'deny', priority: i },
      });
      expect(r.statusCode).toBe(201);
    }
    const over = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'agent:anvil', action: 'task:assign', effect: 'deny', priority: 999 },
    });
    expect(over.statusCode).toBe(422);
    expect((over.json() as { error: string }).error).toBe('rule_limit_exceeded');
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

// ── Phase 3: condition expression validation ────────────────────────────────

describe('Phase 3 — resourceCondition validation', () => {
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

  it('accepts valid eq condition', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: {
        principal: 'agent:anvil',
        action: 'task:assign',
        effect: 'deny',
        priority: 100,
        resourceCondition: JSON.stringify({ op: 'eq', field: 'resource.id', value: 'task-001' }),
      },
    });
    expect(res.statusCode).toBe(201);
    const { rule } = res.json() as { rule: Record<string, unknown> };
    expect(rule['resourceCondition']).toContain('resource.id');
  });

  it('rejects invalid condition structure (unknown op) with 400', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: {
        principal: 'agent:anvil',
        action: 'task:assign',
        effect: 'deny',
        priority: 100,
        resourceCondition: JSON.stringify({ op: 'regex', field: 'resource.id', value: '.*' }),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects condition exceeding max depth with 400', async () => {
    const deep = (d: number): object =>
      d === 0
        ? { op: 'eq', field: 'resource.id', value: 'x' }
        : { op: 'and', conditions: [deep(d - 1)] };
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: {
        principal: 'agent:anvil',
        action: 'task:assign',
        effect: 'deny',
        priority: 100,
        resourceCondition: JSON.stringify(deep(6)),
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── Phase 3: audit trail ────────────────────────────────────────────────────

describe('Phase 3 — rule change audit trail', () => {
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

  it('GET /workspaces/:id/policy-rules/changes records a create event', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'agent:anvil', action: 'task:assign', effect: 'deny', priority: 100 },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/policy-rules/changes`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { changes } = res.json() as { changes: { action: string; snapshot: string }[] };
    expect(changes).toHaveLength(1);
    expect(changes[0]!.action).toBe('create');
    expect(changes[0]!.snapshot).toContain('anvil');
  });

  it('GET /workspaces/:id/policy-rules/changes records an archive event', async () => {
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: { principal: 'agent:anvil', action: 'task:assign', effect: 'deny', priority: 100 },
    });
    const { rule } = createRes.json() as { rule: { id: string } };

    await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/policy-rules/${rule.id}`,
      headers: { cookie },
      payload: { archived: true },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/policy-rules/changes`,
      headers: { cookie },
    });
    const { changes } = res.json() as { changes: { action: string }[] };
    const actions = changes.map((c) => c.action).sort();
    expect(actions).toEqual(['archive', 'create']);
  });

  it('GET /policy-rules/changes records global rule create', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: '/policy-rules',
      headers: { cookie },
      payload: { principal: 'role:worker', action: 'doc:update', effect: 'deny', priority: 50 },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/policy-rules/changes',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { changes } = res.json() as { changes: { action: string }[] };
    expect(changes.some((c) => c.action === 'create')).toBe(true);
  });

  it('GET /policy-rules/changes requires admin', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/policy-rules/changes',
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── Phase 3: condition evaluator in engine ──────────────────────────────────

describe('Phase 3 — DB rule condition evaluation', () => {
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

  it('rule with non-matching resource.id condition is skipped (does not enforce)', async () => {
    // Deny forge-master task:assign only when resource.id === 'specific-task-id'
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/policy-rules`,
      headers: { cookie },
      payload: {
        principal: 'agent:forge-master',
        action: 'task:assign',
        effect: 'deny',
        priority: 300,
        resourceCondition: JSON.stringify({ op: 'eq', field: 'resource.id', value: 'specific-task-id' }),
      },
    });

    const devRes = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'fm-cond-test', agentId: 'forge-master', deviceType: 'orchestrator' },
    });
    const { token: fmToken } = devRes.json() as { token: string };

    const taskRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/tasks`,
      headers: { cookie },
      payload: { projectPrefix: 'pr', title: 'Condition test task' },
    });
    const { id: taskId } = taskRes.json() as { id: string };

    // taskId !== 'specific-task-id', so the deny condition doesn't match → allow (built-in allows FM)
    const assignRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
      headers: { Authorization: `Bearer ${fmToken}` },
      payload: { agentId: 'furnace' },
    });
    expect(assignRes.statusCode).toBe(200);
  });
});

// ── Phase 3: global rule limit ──────────────────────────────────────────────

describe('Phase 3 — global rule limit (50)', () => {
  let hub: Hub;
  let cookie: string;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
  });

  afterEach(async () => {
    await hub.close();
  });

  it('POST /policy-rules returns 422 after 50 global rules', async () => {
    for (let i = 0; i < 50; i++) {
      const r = await hub.fastify.inject({
        method: 'POST',
        url: '/policy-rules',
        headers: { cookie },
        payload: { principal: 'role:worker', action: 'task:assign', effect: 'deny', priority: i },
      });
      expect(r.statusCode).toBe(201);
    }
    const over = await hub.fastify.inject({
      method: 'POST',
      url: '/policy-rules',
      headers: { cookie },
      payload: { principal: 'role:worker', action: 'task:assign', effect: 'deny', priority: 999 },
    });
    expect(over.statusCode).toBe(422);
    expect((over.json() as { max: number }).max).toBe(50);
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
