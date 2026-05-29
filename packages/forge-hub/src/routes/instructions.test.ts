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

  const devRes = await hub.fastify.inject({
    method: 'POST',
    url: '/devices',
    headers: { cookie },
    payload: { name: 'daemon-1', hostname: 'server', platform: 'linux' },
  });
  const { token: deviceToken } = devRes.json() as { token: string };

  // Create a task to attach instructions to
  const taskRes = await hub.fastify.inject({
    method: 'POST',
    url: '/tasks',
    headers: { cookie },
    payload: { projectPrefix: 'fl', title: 'Test task' },
  });
  const { id: taskId } = taskRes.json() as { id: string };

  return { cookie, deviceToken, taskId };
}

describe('/tasks/:taskId/instructions routes', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('GET instructions requires auth', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/tasks/FL-001/instructions',
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST instructions requires user auth', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks/FL-001/instructions',
      payload: { priority: 'stop', body: 'halt immediately' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST instructions returns 404 for unknown task', async () => {
    const { cookie } = await setup(hub);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks/xx-999/instructions',
      headers: { cookie },
      payload: { priority: 'stop', body: 'halt' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates an instruction and device can list + ack it', async () => {
    const { cookie, deviceToken, taskId } = await setup(hub);

    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/instructions`,
      headers: { cookie },
      payload: { priority: 'redirect', body: 'focus on the login flow instead' },
    });
    expect(createRes.statusCode).toBe(201);
    const { id: instrId } = createRes.json() as { id: string };

    // Device lists
    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/instructions`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const { instructions } = listRes.json() as { instructions: { id: string; acknowledgedAt: null }[] };
    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.acknowledgedAt).toBeNull();

    // Device acks
    const ackRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/instructions/${instrId}/ack`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(ackRes.statusCode).toBe(200);

    // Ack is idempotent
    const ack2Res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/instructions/${instrId}/ack`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(ack2Res.statusCode).toBe(200);

    // Check acknowledgedAt is now set
    const listRes2 = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/instructions`,
      headers: { cookie },
    });
    const { instructions: updated } = listRes2.json() as {
      instructions: { acknowledgedAt: string | null }[];
    };
    expect(updated[0]!.acknowledgedAt).not.toBeNull();
  });

  it('ack with wrong taskId returns 404', async () => {
    const { cookie, deviceToken, taskId } = await setup(hub);

    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/instructions`,
      headers: { cookie },
      payload: { priority: 'stop', body: 'stop now' },
    });
    const { id: instrId } = createRes.json() as { id: string };

    // Create a second task
    const taskRes2 = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: { projectPrefix: 'fl', title: 'Another task' },
    });
    const { id: otherId } = taskRes2.json() as { id: string };

    const ackRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${otherId}/instructions/${instrId}/ack`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(ackRes.statusCode).toBe(404);
  });

  it('rogue device cannot ack instruction on a task assigned to another device', async () => {
    const { cookie, deviceToken, taskId } = await setup(hub);

    // device1 claims the task
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });

    // User creates an instruction
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/instructions`,
      headers: { cookie },
      payload: { priority: 'stop', body: 'stop now' },
    });
    const { id: instrId } = createRes.json() as { id: string };

    // Register a second (rogue) device
    const dev2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'rogue', hostname: 'evil', platform: 'linux' },
    });
    const { token: rogueToken } = dev2Res.json() as { token: string };

    // Rogue device tries to ack — should be 403
    const ackRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/instructions/${instrId}/ack`,
      headers: { authorization: `Bearer ${rogueToken}` },
    });
    expect(ackRes.statusCode).toBe(403);
  });

  it('rogue device cannot read instructions for a task assigned to another device', async () => {
    const { cookie, deviceToken, taskId } = await setup(hub);

    // device1 claims the task
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });

    // Register a second (rogue) device
    const dev2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'rogue', hostname: 'evil', platform: 'linux' },
    });
    const { token: rogueToken } = dev2Res.json() as { token: string };

    // Rogue device tries to list — should be 403
    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/instructions`,
      headers: { authorization: `Bearer ${rogueToken}` },
    });
    expect(listRes.statusCode).toBe(403);
  });

  it('assigned device CAN read and ack its own task instructions', async () => {
    const { cookie, deviceToken, taskId } = await setup(hub);

    // device1 claims the task
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });

    // User creates an instruction
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/instructions`,
      headers: { cookie },
      payload: { priority: 'redirect', body: 'focus on login' },
    });
    const { id: instrId } = createRes.json() as { id: string };

    // Assigned device reads
    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/instructions`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(listRes.statusCode).toBe(200);

    // Assigned device acks
    const ackRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/instructions/${instrId}/ack`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(ackRes.statusCode).toBe(200);
  });

  it('user with device token can ack instruction even when device is not the assigned device', async () => {
    const { cookie, deviceToken, taskId } = await setup(hub);

    // device1 claims the task
    await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/claim`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });

    // User creates an instruction
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/instructions`,
      headers: { cookie },
      payload: { priority: 'stop', body: 'stop now' },
    });
    const { id: instrId } = createRes.json() as { id: string };

    // Register a second device and get its token
    const dev2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'other-device', hostname: 'other', platform: 'linux' },
    });
    const { token: token2 } = dev2Res.json() as { token: string };

    // User sends request with BOTH cookie AND a device token that is NOT the assigned device
    // The user auth should win and the ack should succeed
    const ackRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/instructions/${instrId}/ack`,
      headers: { cookie, authorization: `Bearer ${token2}` },
    });
    expect(ackRes.statusCode).toBe(200);
  });

  it('POST instruction with body exceeding max length returns 400', async () => {
    const { cookie, taskId } = await setup(hub);

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/instructions`,
      headers: { cookie },
      payload: { priority: 'stop', body: 'x'.repeat(50_001) },
    });
    expect(res.statusCode).toBe(400);
  });
});
