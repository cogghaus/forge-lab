import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHub, type Hub } from '../app.js';
import type { HubConfig } from '../config.js';
import { nanoid } from 'nanoid';
import { schema } from '@forge-lab/core';
import { createSession } from '../auth/sessions.js';
import { hashPassword } from '../auth/password.js';

const testConfig: HubConfig = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl: ':memory:',
  sessionSecret: 'test-secret-with-at-least-32-characters-xxxx',
  sessionTtlHours: 24,
  bcryptCost: 10,
  cookieSecure: false,
};

async function setupAdmin(hub: Hub): Promise<{ cookie: string }> {
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

describe('POST /devices', () => {
  let hub: Hub;
  let cookie: string;

  beforeEach(async () => {
    hub = await createHub({ config: testConfig });
    ({ cookie } = await setupAdmin(hub));
  });

  afterEach(async () => {
    await hub.close();
  });

  it('registers a worker device and returns id + token', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'my-worker', hostname: 'box1', platform: 'linux' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; token: string };
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('my-worker');
    expect(body.token).toBeTruthy();
  });

  it('registers an orchestrator device with agentId and deviceType', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: {
        name: 'forge-master',
        hostname: 'orchestrator-1',
        platform: 'linux',
        agentId: 'forge-master',
        deviceType: 'orchestrator',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; token: string };
    expect(body.id).toBeTruthy();
    expect(body.token).toBeTruthy();
  });

  it('returns 400 when name is empty string', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 when not authenticated', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      payload: { name: 'bad-device' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /devices', () => {
  let hub: Hub;
  let cookie: string;

  beforeEach(async () => {
    hub = await createHub({ config: testConfig });
    ({ cookie } = await setupAdmin(hub));
  });

  afterEach(async () => {
    await hub.close();
  });

  it('returns empty list when no devices registered', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/devices',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { devices: unknown[] };
    expect(body.devices).toHaveLength(0);
  });

  it('returns devices with deviceType and agentId fields', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: {
        name: 'orchestrator-1',
        hostname: 'orch-host',
        platform: 'linux',
        agentId: 'forge-master',
        deviceType: 'orchestrator',
      },
    });
    await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'worker-1', hostname: 'worker-host', platform: 'win32' },
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/devices',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      devices: Array<{
        id: string;
        name: string;
        hostname: string | null;
        platform: string | null;
        lastSeen: string | null;
        createdAt: string;
        deviceType: string;
        agentId: string | null;
      }>;
    };
    expect(body.devices).toHaveLength(2);

    const orch = body.devices.find((d) => d.name === 'orchestrator-1');
    expect(orch).toBeDefined();
    expect(orch!.deviceType).toBe('orchestrator');
    expect(orch!.agentId).toBe('forge-master');
    expect(orch!.hostname).toBe('orch-host');

    const worker = body.devices.find((d) => d.name === 'worker-1');
    expect(worker).toBeDefined();
    expect(worker!.deviceType).toBe('worker');
    expect(worker!.agentId).toBeNull();
  });

  it('only returns devices belonging to the authenticated user', async () => {
    // Register a device as user1 (registered via API in beforeEach)
    await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'user1-device' },
    });

    // Insert user2 directly — registration API is single-user-only
    const user2Id = nanoid();
    const user2Hash = await hashPassword('password123', 10);
    await hub.db.insert(schema.users).values({
      id: user2Id,
      email: 'user2@example.com',
      passwordHash: user2Hash,
      role: 'user',
    });

    // Create a session for user2 directly via the sessions module
    const session2 = await createSession(hub.db, user2Id, 24);
    const cookie2 = `session=${session2.token}`;

    // Insert a device owned by user2 directly
    await hub.db.insert(schema.devices).values({
      id: nanoid(),
      userId: user2Id,
      name: 'user2-device',
      tokenHash: 'fake-hash-' + nanoid(),
      deviceType: 'worker',
      agentId: null,
    });

    // user1 sees only their own device
    const res1 = await hub.fastify.inject({
      method: 'GET',
      url: '/devices',
      headers: { cookie },
    });
    const body1 = res1.json() as { devices: Array<{ name: string }> };
    expect(body1.devices).toHaveLength(1);
    expect(body1.devices[0]!.name).toBe('user1-device');

    // user2 sees only their own device
    const res2 = await hub.fastify.inject({
      method: 'GET',
      url: '/devices',
      headers: { cookie: cookie2 },
    });
    const body2 = res2.json() as { devices: Array<{ name: string }> };
    expect(body2.devices).toHaveLength(1);
    expect(body2.devices[0]!.name).toBe('user2-device');
  });

  it('returns 401 when not authenticated', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/devices',
    });
    expect(res.statusCode).toBe(401);
  });
});
