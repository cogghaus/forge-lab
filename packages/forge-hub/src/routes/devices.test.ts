import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHub, type Hub } from '../app.js';
import { nanoid } from 'nanoid';
import { schema } from '@forge-lab/core';
import { createSession } from '../auth/sessions.js';
import { hashPassword } from '../auth/password.js';
import { TEST_HUB_CONFIG, setupAdmin, registerDevice } from '../test-utils.js';


describe('POST /devices', () => {
  let hub: Hub;
  let cookie: string;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
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
    hub = await createHub({ config: TEST_HUB_CONFIG });
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

// ── Helper: confirm a device token is (or isn't) accepted ────────────────────
// POST /agent-instances with requireDevice preHandler.
// Valid device → 404 (agent not found). Deregistered/missing → 401.
async function probeDeviceAuth(hub: Hub, token: string): Promise<number> {
  const res = await hub.fastify.inject({
    method: 'POST',
    url: '/agent-instances',
    headers: { authorization: `Bearer ${token}` },
    payload: { agentId: '__probe__' },
  });
  return res.statusCode;
}

describe('GET /devices — status filtering', () => {
  let hub: Hub;
  let cookie: string;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
  });

  afterEach(async () => {
    await hub.close();
  });

  it('hides deregistered device from default GET /devices response', async () => {
    const { id } = await registerDevice(hub, cookie, 'temp-worker');
    await hub.fastify.inject({ method: 'DELETE', url: `/devices/${id}`, headers: { cookie } });
    const res = await hub.fastify.inject({ method: 'GET', url: '/devices', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { devices: Array<{ id: string }> };
    expect(body.devices.find((d) => d.id === id)).toBeUndefined();
  });

  it('includes deregistered device when ?includeDeregistered=true', async () => {
    const { id } = await registerDevice(hub, cookie, 'temp-worker');
    await hub.fastify.inject({ method: 'DELETE', url: `/devices/${id}`, headers: { cookie } });
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/devices?includeDeregistered=true',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { devices: Array<{ id: string; status: string }> };
    const found = body.devices.find((d) => d.id === id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('deregistered');
  });
});

describe('DELETE /devices/:deviceId', () => {
  let hub: Hub;
  let cookie: string;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
  });

  afterEach(async () => {
    await hub.close();
  });

  it('returns 204 and device token can no longer authenticate', async () => {
    const { id, token } = await registerDevice(hub, cookie, 'worker-del');
    expect(await probeDeviceAuth(hub, token)).not.toBe(401);

    const delRes = await hub.fastify.inject({
      method: 'DELETE',
      url: `/devices/${id}`,
      headers: { cookie },
    });
    expect(delRes.statusCode).toBe(204);
    expect(await probeDeviceAuth(hub, token)).toBe(401);
  });

  it('returns 404 when device does not exist', async () => {
    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: '/devices/nonexistent-id',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when device belongs to a different user', async () => {
    const { id } = await registerDevice(hub, cookie, 'owned-device');

    const user2Id = nanoid();
    const user2Hash = await hashPassword('password123', 10);
    await hub.db.insert(schema.users).values({
      id: user2Id,
      email: 'user2-del@example.com',
      passwordHash: user2Hash,
      role: 'user',
    });
    const session2 = await createSession(hub.db, user2Id, 24);
    const cookie2 = `session=${session2.token}`;

    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: `/devices/${id}`,
      headers: { cookie: cookie2 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    const { id } = await registerDevice(hub, cookie, 'worker-unauth');
    const res = await hub.fastify.inject({ method: 'DELETE', url: `/devices/${id}` });
    expect(res.statusCode).toBe(401);
  });

  it('calling DELETE twice on same device returns 404 on second call', async () => {
    const { id } = await registerDevice(hub, cookie, 'worker-twice');
    const first = await hub.fastify.inject({
      method: 'DELETE', url: `/devices/${id}`, headers: { cookie },
    });
    expect(first.statusCode).toBe(204);
    const second = await hub.fastify.inject({
      method: 'DELETE', url: `/devices/${id}`, headers: { cookie },
    });
    expect(second.statusCode).toBe(404);
  });
});

describe('PATCH /devices/:deviceId', () => {
  let hub: Hub;
  let cookie: string;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
  });

  afterEach(async () => {
    await hub.close();
  });

  it('returns 200 with updated name', async () => {
    const { id } = await registerDevice(hub, cookie, 'old-name');
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/devices/${id}`,
      headers: { cookie },
      payload: { name: 'new-name' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; name: string };
    expect(body.name).toBe('new-name');

    const listRes = await hub.fastify.inject({ method: 'GET', url: '/devices', headers: { cookie } });
    const list = listRes.json() as { devices: Array<{ id: string; name: string }> };
    expect(list.devices.find((d) => d.id === id)?.name).toBe('new-name');
  });

  it('returns 400 for empty name', async () => {
    const { id } = await registerDevice(hub, cookie, 'valid-name');
    const res = await hub.fastify.inject({
      method: 'PATCH', url: `/devices/${id}`, headers: { cookie }, payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for name exceeding 64 chars', async () => {
    const { id } = await registerDevice(hub, cookie, 'valid-name');
    const res = await hub.fastify.inject({
      method: 'PATCH', url: `/devices/${id}`, headers: { cookie }, payload: { name: 'a'.repeat(65) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for name with invalid characters', async () => {
    const { id } = await registerDevice(hub, cookie, 'valid-name');
    const spaceRes = await hub.fastify.inject({
      method: 'PATCH', url: `/devices/${id}`, headers: { cookie }, payload: { name: 'name with spaces' },
    });
    expect(spaceRes.statusCode).toBe(400);

    const underscoreRes = await hub.fastify.inject({
      method: 'PATCH', url: `/devices/${id}`, headers: { cookie }, payload: { name: 'name_underscore' },
    });
    expect(underscoreRes.statusCode).toBe(400);
  });

  it('returns 404 when device does not exist', async () => {
    const res = await hub.fastify.inject({
      method: 'PATCH', url: '/devices/nonexistent', headers: { cookie }, payload: { name: 'any-name' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when device belongs to a different user', async () => {
    const { id } = await registerDevice(hub, cookie, 'owner-device');

    const user2Id = nanoid();
    await hub.db.insert(schema.users).values({
      id: user2Id,
      email: 'user2-patch@example.com',
      passwordHash: await hashPassword('pw', 10),
      role: 'user',
    });
    const session2 = await createSession(hub.db, user2Id, 24);

    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: `/devices/${id}`,
      headers: { cookie: `session=${session2.token}` },
      payload: { name: 'hijacked' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    const { id } = await registerDevice(hub, cookie, 'auth-device');
    const res = await hub.fastify.inject({
      method: 'PATCH', url: `/devices/${id}`, payload: { name: 'new-name' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /devices/:deviceId/rotate-token', () => {
  let hub: Hub;
  let cookie: string;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
    ({ cookie } = await setupAdmin(hub));
  });

  afterEach(async () => {
    await hub.close();
  });

  it('returns 200 with a new plaintext token different from the original', async () => {
    const { id, token: originalToken } = await registerDevice(hub, cookie, 'rotate-me');
    const res = await hub.fastify.inject({
      method: 'POST', url: `/devices/${id}/rotate-token`, headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string };
    expect(body.token).toBeTruthy();
    expect(body.token).not.toBe(originalToken);
  });

  it('old token no longer authenticates after rotation', async () => {
    const { id, token: oldToken } = await registerDevice(hub, cookie, 'rotate-old');
    expect(await probeDeviceAuth(hub, oldToken)).not.toBe(401);

    await hub.fastify.inject({
      method: 'POST', url: `/devices/${id}/rotate-token`, headers: { cookie },
    });
    expect(await probeDeviceAuth(hub, oldToken)).toBe(401);
  });

  it('new token authenticates after rotation', async () => {
    const { id } = await registerDevice(hub, cookie, 'rotate-new');
    const rotateRes = await hub.fastify.inject({
      method: 'POST', url: `/devices/${id}/rotate-token`, headers: { cookie },
    });
    const { token: newToken } = rotateRes.json() as { token: string };
    expect(await probeDeviceAuth(hub, newToken)).not.toBe(401);
  });

  it('returns 410 when rotating token for a deregistered device', async () => {
    const { id } = await registerDevice(hub, cookie, 'rotate-dereg');
    await hub.fastify.inject({ method: 'DELETE', url: `/devices/${id}`, headers: { cookie } });

    const res = await hub.fastify.inject({
      method: 'POST', url: `/devices/${id}/rotate-token`, headers: { cookie },
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe('device_deregistered');
  });

  it('returns 404 when device does not exist', async () => {
    const res = await hub.fastify.inject({
      method: 'POST', url: '/devices/nonexistent/rotate-token', headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when device belongs to a different user', async () => {
    const { id } = await registerDevice(hub, cookie, 'rotate-other');

    const user2Id = nanoid();
    await hub.db.insert(schema.users).values({
      id: user2Id,
      email: 'user2-rotate@example.com',
      passwordHash: await hashPassword('pw', 10),
      role: 'user',
    });
    const session2 = await createSession(hub.db, user2Id, 24);

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/devices/${id}/rotate-token`,
      headers: { cookie: `session=${session2.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    const { id } = await registerDevice(hub, cookie, 'rotate-noauth');
    const res = await hub.fastify.inject({
      method: 'POST', url: `/devices/${id}/rotate-token`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 429 after exceeding rate limit (6th call)', async () => {
    const { id } = await registerDevice(hub, cookie, 'rotate-rl');
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const r = await hub.fastify.inject({
        method: 'POST', url: `/devices/${id}/rotate-token`, headers: { cookie },
      });
      lastStatus = r.statusCode;
    }
    expect(lastStatus).toBe(429);
  });

  it('two simultaneous rotations complete without corruption — original token becomes invalid', async () => {
    const { id, token: originalToken } = await registerDevice(hub, cookie, 'rotate-concurrent');
    const [r1, r2] = await Promise.all([
      hub.fastify.inject({ method: 'POST', url: `/devices/${id}/rotate-token`, headers: { cookie } }),
      hub.fastify.inject({ method: 'POST', url: `/devices/${id}/rotate-token`, headers: { cookie } }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    // Original token must be invalid after either rotation
    expect(await probeDeviceAuth(hub, originalToken)).toBe(401);
  });
});
