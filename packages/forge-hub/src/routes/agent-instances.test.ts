import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHub, type Hub } from '../app.js';
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

  const devRes = await hub.fastify.inject({
    method: 'POST',
    url: '/devices',
    headers: { cookie },
    payload: { name: 'daemon-1', hostname: 'server', platform: 'linux' },
  });
  const { token } = devRes.json() as { token: string };

  const agentRes = await hub.fastify.inject({
    method: 'POST',
    url: '/agents',
    headers: { cookie },
    payload: { name: 'forge', personality: 'coder', runtimeId: 'claude-code' },
  });
  const { id: agentId } = agentRes.json() as { id: string };

  return { cookie, deviceToken: token, agentId };
}

describe('/agent-instances routes', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('POST /agent-instances requires device auth', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/agent-instances',
      payload: { agentId: 'fake' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /agent-instances requires auth', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/agent-instances' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /agent-instances returns 404 for unknown agent', async () => {
    const { deviceToken } = await setup(hub);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/agent-instances',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { agentId: 'doesnotexist' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('device creates instance, user sees it', async () => {
    const { cookie, deviceToken, agentId } = await setup(hub);
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agent-instances',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { agentId, status: 'spawning' },
    });
    expect(createRes.statusCode).toBe(201);
    const { id } = createRes.json() as { id: string };
    expect(id).toBeTruthy();

    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: '/agent-instances',
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const { instances } = listRes.json() as { instances: unknown[] };
    expect(instances).toHaveLength(1);
  });

  it('device only sees its own instances', async () => {
    const { deviceToken, agentId } = await setup(hub);
    await hub.fastify.inject({
      method: 'POST',
      url: '/agent-instances',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { agentId },
    });

    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: '/agent-instances',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const { instances } = listRes.json() as { instances: unknown[] };
    expect(instances).toHaveLength(1);
  });

  it('PATCH /agent-instances/:id updates status and sets endedAt on terminal transition', async () => {
    const { cookie, deviceToken, agentId } = await setup(hub);
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agent-instances',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { agentId, status: 'running' },
    });
    const { id } = createRes.json() as { id: string };

    const patchRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/agent-instances/${id}`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { status: 'stopped' },
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes = await hub.fastify.inject({
      method: 'GET',
      url: `/agent-instances/${id}`,
      headers: { cookie },
    });
    const instance = getRes.json() as { status: string; endedAt: string | null };
    expect(instance.status).toBe('stopped');
    expect(instance.endedAt).not.toBeNull();
  });

  it('device cannot PATCH another device instance', async () => {
    const { cookie, agentId } = await setup(hub);

    // Register a second device
    const dev2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'daemon-2', hostname: 'other', platform: 'linux' },
    });
    const { token: token2 } = dev2Res.json() as { token: string };

    // dev2 creates an instance
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agent-instances',
      headers: { authorization: `Bearer ${token2}` },
      payload: { agentId },
    });
    const { id } = createRes.json() as { id: string };

    // Register a third device
    const dev3Res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'daemon-3', hostname: 'other2', platform: 'linux' },
    });
    const { token: token3 } = dev3Res.json() as { token: string };

    // dev3 tries to PATCH dev2's instance — should be 403
    const patchRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/agent-instances/${id}`,
      headers: { authorization: `Bearer ${token3}` },
      payload: { status: 'stopped' },
    });
    expect(patchRes.statusCode).toBe(403);
  });

  it('stopped instance cannot be re-activated', async () => {
    const { deviceToken, agentId } = await setup(hub);

    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agent-instances',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { agentId, status: 'running' },
    });
    const { id } = createRes.json() as { id: string };

    // Stop the instance
    await hub.fastify.inject({
      method: 'PATCH',
      url: `/agent-instances/${id}`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { status: 'stopped' },
    });

    // Try to re-activate — should be 409
    const reactivateRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/agent-instances/${id}`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { status: 'running' },
    });
    expect(reactivateRes.statusCode).toBe(409);
  });

  it('PATCH /agent-instances/:id with invalid body returns 400', async () => {
    const { deviceToken, agentId } = await setup(hub);

    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agent-instances',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { agentId },
    });
    const { id } = createRes.json() as { id: string };

    const patchRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/agent-instances/${id}`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { status: 'not-a-valid-status' },
    });
    expect(patchRes.statusCode).toBe(400);
  });
});
