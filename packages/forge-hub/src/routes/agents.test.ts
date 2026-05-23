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
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe('ws-agent');
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
