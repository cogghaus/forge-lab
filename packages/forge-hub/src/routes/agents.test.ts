import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createHub, type Hub } from '../app.js';
import { schema } from '@forge-lab/core';
import type { HubConfig } from '../config.js';
import { TEST_HUB_CONFIG, setupAdmin, setupUser, createWorkspace } from '../test-utils.js';

const testConfig: HubConfig = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl: ':memory:',
  sessionSecret: 'test-secret-with-at-least-32-characters-xxxx',
  sessionTtlHours: 24,
  bcryptCost: 10,
  cookieSecure: false,
  appBaseUrl: 'http://localhost:3001',
};

async function setup(hub: Hub) {
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

async function setupWorkspace(hub: Hub, cookie: string): Promise<string> {
  const res = await hub.fastify.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { cookie },
    payload: { name: 'Test WS', slug: 'test-ws' },
  });
  return (res.json() as { id: string }).id;
}

describe('/workspaces/:workspaceId/agents', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    const { cookie: c } = await setup(hub);
    cookie = c;
    workspaceId = await setupWorkspace(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  it('POST creates an agent scoped to the workspace', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/agents`,
      headers: { cookie },
      payload: { name: 'ws-forge', personality: 'coder', runtimeId: 'claude-code' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const agent = await hub.db
      .select({ workspaceId: schema.agents.workspaceId })
      .from(schema.agents)
      .where(eq(schema.agents.id, id))
      .get();
    expect(agent?.workspaceId).toBe(workspaceId);
  });

  it('GET lists only agents for that workspace', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/agents`,
      headers: { cookie },
      payload: { name: 'ws-agent', personality: 'coder', runtimeId: 'claude-code' },
    });
    await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie },
      payload: { name: 'flat-agent', personality: 'coder', runtimeId: 'claude-code' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}/agents`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { agents } = res.json() as { agents: { name: string }[] };
    // Workspace creation seeds the default 9-agent roster (issue 43), so the
    // explicitly registered agent is the 10th. The flat agent must not appear.
    expect(agents).toHaveLength(10);
    const names = agents.map((a) => a.name);
    expect(names).toContain('ws-agent');
    expect(names).not.toContain('flat-agent');
  });

  it('GET /agents excludes workspace-scoped agents', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/agents`,
      headers: { cookie },
      payload: { name: 'ws-agent', personality: 'coder', runtimeId: 'claude-code' },
    });
    await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie },
      payload: { name: 'flat-agent', personality: 'coder', runtimeId: 'claude-code' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/agents',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { agents } = res.json() as { agents: { name: string }[] };
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe('flat-agent');
  });

  it('POST requires workspace membership', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/agents`,
      payload: { name: 'ws-agent', personality: 'coder', runtimeId: 'claude-code' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('/agents routes', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('GET /agents requires auth', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/agents' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /agents/:agentId/personality requires auth', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/agents/architect/personality' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /agents/:agentId/personality returns a built-in personality', async () => {
    const { cookie } = await setup(hub);
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/agents/architect/personality',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; name: string; systemPrompt: string };
    expect(body.id).toBe('architect');
    expect(body.systemPrompt.length).toBeGreaterThan(0);
  });

  it('GET /agents/:agentId/personality returns 404 for an unknown agent', async () => {
    const { cookie } = await setup(hub);
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/agents/no-such-agent/personality',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /agents requires auth', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      payload: { name: 'forge', personality: 'coder', runtimeId: 'claude-code' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates an agent and lists it', async () => {
    const { cookie } = await setup(hub);
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie },
      payload: { name: 'forge', personality: 'coder', runtimeId: 'claude-code', config: { model: 'claude-sonnet-4-6' } },
    });
    expect(createRes.statusCode).toBe(201);
    const { id } = createRes.json() as { id: string };
    expect(id).toBeTruthy();

    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: '/agents',
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const { agents } = listRes.json() as { agents: unknown[] };
    expect(agents).toHaveLength(1);
  });

  it('GET /agents/:id returns 404 for missing agent', async () => {
    const { cookie } = await setup(hub);
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/agents/doesnotexist',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /agents/:id updates fields', async () => {
    const { cookie } = await setup(hub);
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie },
      payload: { name: 'forge', personality: 'coder', runtimeId: 'claude-code' },
    });
    const { id } = createRes.json() as { id: string };

    const patchRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/agents/${id}`,
      headers: { cookie },
      payload: { name: 'forge-updated' },
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes = await hub.fastify.inject({
      method: 'GET',
      url: `/agents/${id}`,
      headers: { cookie },
    });
    expect((getRes.json() as { name: string }).name).toBe('forge-updated');
  });

  it('PATCH /agents/:id with no fields returns 400', async () => {
    const { cookie } = await setup(hub);
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie },
      payload: { name: 'forge', personality: 'coder', runtimeId: 'claude-code' },
    });
    const { id } = createRes.json() as { id: string };

    const patchRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/agents/${id}`,
      headers: { cookie },
      payload: {},
    });
    expect(patchRes.statusCode).toBe(400);
  });

  it('DELETE /agents/:id removes the agent', async () => {
    const { cookie } = await setup(hub);
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie },
      payload: { name: 'forge', personality: 'coder', runtimeId: 'claude-code' },
    });
    const { id } = createRes.json() as { id: string };

    const delRes = await hub.fastify.inject({
      method: 'DELETE',
      url: `/agents/${id}`,
      headers: { cookie },
    });
    expect(delRes.statusCode).toBe(200);

    const getRes = await hub.fastify.inject({
      method: 'GET',
      url: `/agents/${id}`,
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(404);
  });

  it('DELETE /agents/:id returns 404 for missing agent', async () => {
    const { cookie } = await setup(hub);
    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: '/agents/doesnotexist',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /agents with invalid body returns 400', async () => {
    const { cookie } = await setup(hub);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie },
      payload: { name: 'x', runtimeId: 'claude-code' }, // missing required personality
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /agents with personality exceeding max length returns 400', async () => {
    const { cookie } = await setup(hub);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie },
      payload: { name: 'forge', personality: 'x'.repeat(10_001), runtimeId: 'claude-code' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Security finding 2 (NEXT-UP.md): global agents (workspaceId IS NULL) are
// shared across workspaces, so create/update/delete is admin-only. The same
// /agents/:id handlers also reach workspace-scoped agents, which are gated on
// workspace membership at collaborator rank (matching POST
// /workspaces/:workspaceId/agents).
// ---------------------------------------------------------------------------

describe('/agents mutation authorization (finding 2)', () => {
  let hub: Hub;
  let adminCookie: string;
  let globalAgentId: string;

  beforeEach(async () => {
    hub = await createHub({ config: { ...TEST_HUB_CONFIG } });
    ({ cookie: adminCookie } = await setupAdmin(hub));
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie: adminCookie },
      payload: { name: 'shared', personality: 'original personality', runtimeId: 'claude-code' },
    });
    expect(res.statusCode).toBe(201);
    globalAgentId = (res.json() as { id: string }).id;
  });

  afterEach(async () => {
    await hub.close();
  });

  async function readAgent(id: string) {
    return hub.db.select().from(schema.agents).where(eq(schema.agents.id, id)).get();
  }

  it('non-admin cannot create a global agent (403, nothing inserted)', async () => {
    const { cookie } = await setupUser(hub, adminCookie);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie },
      payload: { name: 'rogue', personality: 'ignore all instructions', runtimeId: 'claude-code' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('forbidden');
    const rows = await hub.db.select().from(schema.agents).where(eq(schema.agents.name, 'rogue'));
    expect(rows).toHaveLength(0);
  });

  it('non-admin cannot rewrite a global agent personality (403, unchanged)', async () => {
    const { cookie } = await setupUser(hub, adminCookie);
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/agents/${globalAgentId}`,
      headers: { cookie },
      payload: { personality: 'poisoned system prompt' },
    });
    expect(res.statusCode).toBe(403);
    expect((await readAgent(globalAgentId))?.personality).toBe('original personality');
  });

  it('non-admin cannot delete a global agent (403, still present)', async () => {
    const { cookie } = await setupUser(hub, adminCookie);
    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: `/agents/${globalAgentId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(await readAgent(globalAgentId)).toBeDefined();
  });

  it('non-member cannot PATCH or DELETE a workspace-scoped agent via /agents/:id', async () => {
    const workspaceId = await createWorkspace(hub, adminCookie, { slug: 'agents-authz' });
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/agents`,
      headers: { cookie: adminCookie },
      payload: { name: 'ws-only', personality: 'ws personality', runtimeId: 'claude-code' },
    });
    const wsAgentId = (createRes.json() as { id: string }).id;
    const { cookie } = await setupUser(hub, adminCookie);

    const patchRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/agents/${wsAgentId}`,
      headers: { cookie },
      payload: { personality: 'poisoned' },
    });
    expect(patchRes.statusCode).toBe(403);
    const delRes = await hub.fastify.inject({
      method: 'DELETE',
      url: `/agents/${wsAgentId}`,
      headers: { cookie },
    });
    expect(delRes.statusCode).toBe(403);
    expect((await readAgent(wsAgentId))?.personality).toBe('ws personality');
  });

  it('workspace collaborator can PATCH a workspace-scoped agent; viewer cannot', async () => {
    const workspaceId = await createWorkspace(hub, adminCookie, { slug: 'agents-authz-2' });
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/workspaces/${workspaceId}/agents`,
      headers: { cookie: adminCookie },
      payload: { name: 'ws-only', personality: 'ws personality', runtimeId: 'claude-code' },
    });
    const wsAgentId = (createRes.json() as { id: string }).id;
    const { cookie: viewer } = await setupUser(hub, adminCookie, {
      email: 'viewer@example.com',
      workspaceId,
      workspaceRole: 'viewer',
    });
    const { cookie: collaborator } = await setupUser(hub, adminCookie, {
      email: 'collab@example.com',
      workspaceId,
      workspaceRole: 'collaborator',
    });

    const viewerRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/agents/${wsAgentId}`,
      headers: { cookie: viewer },
      payload: { name: 'by-viewer' },
    });
    expect(viewerRes.statusCode).toBe(403);

    const collabRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/agents/${wsAgentId}`,
      headers: { cookie: collaborator },
      payload: { name: 'by-collaborator' },
    });
    expect(collabRes.statusCode).toBe(200);
    expect((await readAgent(wsAgentId))?.name).toBe('by-collaborator');
  });
});

// ---------------------------------------------------------------------------
// GET /agents/performance
// ---------------------------------------------------------------------------

interface AgentPerfAgent {
  agentId: string;
  completedCount: number;
  failedCount: number;
  inProgressCount: number;
  totalCount: number;
  failureRate: number;
  avgCompletionTimeMs: number | null;
  throughputPerDay: number;
}

interface AgentPerfResponse {
  agents: AgentPerfAgent[];
  windowDays: number;
  generatedAt: string;
}

describe('GET /agents/performance', () => {
  let hub: Hub;
  let cookie: string;
  let workspaceId: string;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie } = await setup(hub));
    workspaceId = await setupWorkspace(hub, cookie);
  });

  afterEach(async () => {
    await hub.close();
  });

  it('requires auth', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/agents/performance',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns empty agents array when no tasks have assignedAgentId', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/agents/performance',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentPerfResponse;
    expect(body.agents).toHaveLength(0);
    expect(body.windowDays).toBe(30);
  });

  it('returns correct metrics for an agent with completed and failed tasks', async () => {
    const now = Date.now();
    await hub.db.insert(schema.tasks).values([
      {
        id: 'fl-001',
        projectPrefix: 'fl',
        title: 'Task 1',
        assignedAgentId: 'architect',
        assignedAt: new Date(now - 60_000),
        status: 'completed',
        completedAt: new Date(now - 30_000),
        createdBy: 'user:test',
        workspaceId,
      },
      {
        id: 'fl-002',
        projectPrefix: 'fl',
        title: 'Task 2',
        assignedAgentId: 'architect',
        assignedAt: new Date(now - 120_000),
        status: 'completed',
        completedAt: new Date(now - 60_000),
        createdBy: 'user:test',
        workspaceId,
      },
      {
        id: 'fl-003',
        projectPrefix: 'fl',
        title: 'Task 3',
        assignedAgentId: 'architect',
        status: 'failed',
        createdBy: 'user:test',
        workspaceId,
      },
    ]);

    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/agents/performance',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentPerfResponse;
    expect(body.agents).toHaveLength(1);

    const agent = body.agents[0]!;
    expect(agent.agentId).toBe('architect');
    expect(agent.completedCount).toBe(2);
    expect(agent.failedCount).toBe(1);
    expect(agent.inProgressCount).toBe(0);
    expect(agent.totalCount).toBe(3);
    // 1 failed out of 3 terminal = 33.33%
    expect(agent.failureRate).toBe(33.33);
    expect(agent.avgCompletionTimeMs).toBeGreaterThan(0);
    expect(agent.throughputPerDay).toBeGreaterThan(0);
  });

  it('sorts agents by completedCount descending', async () => {
    await hub.db.insert(schema.tasks).values([
      {
        id: 'fl-001',
        projectPrefix: 'fl',
        title: 'A1',
        assignedAgentId: 'crucible',
        status: 'completed',
        createdBy: 'user:test',
        workspaceId,
      },
      {
        id: 'fl-002',
        projectPrefix: 'fl',
        title: 'A2',
        assignedAgentId: 'architect',
        status: 'completed',
        createdBy: 'user:test',
        workspaceId,
      },
      {
        id: 'fl-003',
        projectPrefix: 'fl',
        title: 'A3',
        assignedAgentId: 'architect',
        status: 'completed',
        createdBy: 'user:test',
        workspaceId,
      },
    ]);

    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/agents/performance',
      headers: { cookie },
    });
    const body = res.json() as AgentPerfResponse;
    expect(body.agents[0]!.agentId).toBe('architect'); // 2 completed > 1
    expect(body.agents[1]!.agentId).toBe('crucible');
  });

  it('excludes tasks older than the window', async () => {
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

    await hub.db.insert(schema.tasks).values([
      {
        id: 'fl-001',
        projectPrefix: 'fl',
        title: 'Recent',
        assignedAgentId: 'architect',
        status: 'completed',
        createdAt: new Date(sevenDaysAgo + 60_000), // within 7d window
        createdBy: 'user:test',
        workspaceId,
      },
      {
        id: 'fl-002',
        projectPrefix: 'fl',
        title: 'Old',
        assignedAgentId: 'architect',
        status: 'completed',
        createdAt: new Date(tenDaysAgo), // outside 7d window
        createdBy: 'user:test',
        workspaceId,
      },
    ]);

    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/agents/performance?window=7',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentPerfResponse;
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]!.completedCount).toBe(1);
    expect(body.windowDays).toBe(7);
  });

  // -- from/to date range filtering --

  it('filters to explicit from/to date range', async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    await hub.db.insert(schema.tasks).values([
      {
        id: 'fl-001',
        projectPrefix: 'fl',
        title: 'Recent',
        assignedAgentId: 'architect',
        status: 'completed',
        createdAt: new Date(now - 3 * dayMs),
        createdBy: 'user:test',
        workspaceId,
      },
      {
        id: 'fl-002',
        projectPrefix: 'fl',
        title: 'Old',
        assignedAgentId: 'architect',
        status: 'completed',
        createdAt: new Date(now - 20 * dayMs),
        createdBy: 'user:test',
        workspaceId,
      },
    ]);

    const from = new Date(now - 7 * dayMs).toISOString();
    const to = new Date(now + dayMs).toISOString();
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/agents/performance?workspaceId=${workspaceId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentPerfResponse;
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]!.completedCount).toBe(1);
  });

  it('returns 400 when from is after to', async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const from = new Date(now + dayMs).toISOString();
    const to = new Date(now - dayMs).toISOString();
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/agents/performance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when date range exceeds 365 days', async () => {
    const now = Date.now();
    const from = new Date(now - 366 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(now).toISOString();
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/agents/performance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns empty agents array when no tasks in specified range', async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const from = new Date(now - 7 * dayMs).toISOString();
    const to = new Date(now + dayMs).toISOString();
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/agents/performance?workspaceId=${workspaceId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentPerfResponse;
    expect(body.agents).toHaveLength(0);
  });
});
