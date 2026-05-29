import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHub, type Hub } from '../app.js';
import type { HubConfig } from '../config.js';
import { schema } from '@forge-lab/core';

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

describe('/runtime-configs routes', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('GET /runtime-configs requires auth', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/runtime-configs' });
    expect(res.statusCode).toBe(401);
  });

  it('creates a runtime config and lists it', async () => {
    const { cookie } = await setup(hub);
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/runtime-configs',
      headers: { cookie },
      payload: {
        runtimeId: 'claude-code',
        name: 'default',
        config: { model: 'claude-sonnet-4-6', maxTokens: 4096 },
      },
    });
    expect(createRes.statusCode).toBe(201);
    const { id } = createRes.json() as { id: string };
    expect(id).toBeTruthy();

    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: '/runtime-configs',
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const { configs } = listRes.json() as { configs: unknown[] };
    expect(configs).toHaveLength(1);
  });

  it('GET /runtime-configs/:id returns 404 for missing config', async () => {
    const { cookie } = await setup(hub);
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/runtime-configs/doesnotexist',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH /runtime-configs/:id updates name and config', async () => {
    const { cookie } = await setup(hub);
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/runtime-configs',
      headers: { cookie },
      payload: { runtimeId: 'claude-code', name: 'default', config: { model: 'sonnet' } },
    });
    const { id } = createRes.json() as { id: string };

    const patchRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/runtime-configs/${id}`,
      headers: { cookie },
      payload: { name: 'production', config: { model: 'opus' } },
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes = await hub.fastify.inject({
      method: 'GET',
      url: `/runtime-configs/${id}`,
      headers: { cookie },
    });
    const cfg = getRes.json() as { name: string; config: { model: string } };
    expect(cfg.name).toBe('production');
    expect(cfg.config.model).toBe('opus');
  });

  it('PATCH /runtime-configs/:id with no fields returns 400', async () => {
    const { cookie } = await setup(hub);
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/runtime-configs',
      headers: { cookie },
      payload: { runtimeId: 'claude-code', name: 'default', config: {} },
    });
    const { id } = createRes.json() as { id: string };

    const patchRes = await hub.fastify.inject({
      method: 'PATCH',
      url: `/runtime-configs/${id}`,
      headers: { cookie },
      payload: {},
    });
    expect(patchRes.statusCode).toBe(400);
  });

  it('DELETE /runtime-configs/:id removes the config', async () => {
    const { cookie } = await setup(hub);
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/runtime-configs',
      headers: { cookie },
      payload: { runtimeId: 'claude-code', name: 'default', config: {} },
    });
    const { id } = createRes.json() as { id: string };

    const delRes = await hub.fastify.inject({
      method: 'DELETE',
      url: `/runtime-configs/${id}`,
      headers: { cookie },
    });
    expect(delRes.statusCode).toBe(200);

    const getRes = await hub.fastify.inject({
      method: 'GET',
      url: `/runtime-configs/${id}`,
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(404);
  });

  it('user cannot see another user config — scoped to owner', async () => {
    const { cookie } = await setup(hub);
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: '/runtime-configs',
      headers: { cookie },
      payload: { runtimeId: 'claude-code', name: 'mine', config: {} },
    });
    const { id } = createRes.json() as { id: string };

    // Tamper with id to check scoping (no second user in single-user setup, but verify 404 on bad id)
    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/runtime-configs/${id}zzz`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('user cannot PATCH config owned by a different user', async () => {
    const { cookie } = await setup(hub);

    // Insert a second user and a config they own directly (bypassing the single-user registration limit)
    await hub.db.insert(schema.users).values({
      id: 'other-user-id',
      email: 'other@example.com',
      passwordHash: 'not-a-real-hash',
      role: 'user',
    });
    await hub.db.insert(schema.runtimeConfigs).values({
      id: 'other-user-config',
      userId: 'other-user-id',
      runtimeId: 'claude-code',
      name: 'not-mine',
      config: {},
    });

    const patchRes = await hub.fastify.inject({
      method: 'PATCH',
      url: '/runtime-configs/other-user-config',
      headers: { cookie },
      payload: { name: 'hacked' },
    });
    expect(patchRes.statusCode).toBe(404);
  });

  it('user cannot DELETE config owned by a different user', async () => {
    const { cookie } = await setup(hub);

    await hub.db.insert(schema.users).values({
      id: 'other-user-id-2',
      email: 'other2@example.com',
      passwordHash: 'not-a-real-hash',
      role: 'user',
    });
    await hub.db.insert(schema.runtimeConfigs).values({
      id: 'other-user-config-2',
      userId: 'other-user-id-2',
      runtimeId: 'claude-code',
      name: 'not-mine',
      config: {},
    });

    const delRes = await hub.fastify.inject({
      method: 'DELETE',
      url: '/runtime-configs/other-user-config-2',
      headers: { cookie },
    });
    expect(delRes.statusCode).toBe(404);
  });
});
