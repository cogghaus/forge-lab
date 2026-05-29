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

  const taskRes = await hub.fastify.inject({
    method: 'POST',
    url: '/tasks',
    headers: { cookie },
    payload: { projectPrefix: 'fl', title: 'Test task' },
  });
  const { id: taskId } = taskRes.json() as { id: string };

  return { cookie, deviceToken, taskId };
}

describe('/tasks/:taskId/comments routes', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('GET comments requires auth', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/tasks/FL-001/comments',
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST comments requires auth', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks/FL-001/comments',
      payload: { body: 'hello' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST comments returns 404 for unknown task', async () => {
    const { cookie } = await setup(hub);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/tasks/xx-999/comments',
      headers: { cookie },
      payload: { body: 'hello' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('user posts a comment and it appears in list', async () => {
    const { cookie, taskId } = await setup(hub);

    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/comments`,
      headers: { cookie },
      payload: { body: 'looks good to me' },
    });
    expect(createRes.statusCode).toBe(201);
    const { id } = createRes.json() as { id: string };
    expect(id).toBeTruthy();

    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/comments`,
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const { comments } = listRes.json() as {
      comments: { authorType: string; body: string }[];
    };
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe('user');
    expect(comments[0]!.body).toBe('looks good to me');
  });

  it('device posts a comment with default system authorType', async () => {
    const { cookie, deviceToken, taskId } = await setup(hub);

    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/comments`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { body: 'task completed successfully' },
    });
    expect(createRes.statusCode).toBe(201);

    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/comments`,
      headers: { cookie },
    });
    const { comments } = listRes.json() as { comments: { authorType: string }[] };
    expect(comments[0]!.authorType).toBe('system');
  });

  it('device posts a comment attributed to an agent', async () => {
    const { cookie, deviceToken, taskId } = await setup(hub);

    // Create an agent and a real instance owned by this device
    const agentRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie },
      payload: { name: 'forge', personality: 'coder', runtimeId: 'claude-code' },
    });
    const { id: agentId } = agentRes.json() as { id: string };

    const instanceRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agent-instances',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { agentId },
    });
    const { id: instanceId } = instanceRes.json() as { id: string };

    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/comments`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { body: 'running tests now', authorType: 'agent', authorId: instanceId },
    });
    expect(createRes.statusCode).toBe(201);

    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/comments`,
      headers: { cookie },
    });
    const { comments } = listRes.json() as {
      comments: { authorType: string; authorId: string }[];
    };
    expect(comments[0]!.authorType).toBe('agent');
    expect(comments[0]!.authorId).toBe(instanceId);
  });

  it('device cannot forge comment authorId for another device instance', async () => {
    const { cookie, deviceToken, taskId } = await setup(hub);

    // Create a second device and its instance
    const dev2Res = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'daemon-2', hostname: 'other', platform: 'linux' },
    });
    const { token: token2 } = dev2Res.json() as { token: string };

    const agentRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie },
      payload: { name: 'forge', personality: 'coder', runtimeId: 'claude-code' },
    });
    const { id: agentId } = agentRes.json() as { id: string };

    const instanceRes = await hub.fastify.inject({
      method: 'POST',
      url: '/agent-instances',
      headers: { authorization: `Bearer ${token2}` },
      payload: { agentId },
    });
    const { id: otherInstanceId } = instanceRes.json() as { id: string };

    // device 1 tries to post comment claiming it's dev2's instance — should be 403
    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/comments`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { body: 'impersonating', authorType: 'agent', authorId: otherInstanceId },
    });
    expect(createRes.statusCode).toBe(403);
  });

  it('device cannot post comment with completely fake authorId', async () => {
    const { deviceToken, taskId } = await setup(hub);

    const createRes = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/comments`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { body: 'hacked', authorType: 'agent', authorId: 'fake-instance-id' },
    });
    expect(createRes.statusCode).toBe(403);
  });

  it('POST comment with body exceeding max length returns 400', async () => {
    const { cookie, taskId } = await setup(hub);

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/tasks/${taskId}/comments`,
      headers: { cookie },
      payload: { body: 'x'.repeat(50_001) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('multiple comments are returned in creation order', async () => {
    const { cookie, taskId } = await setup(hub);

    for (const body of ['first', 'second', 'third']) {
      await hub.fastify.inject({
        method: 'POST',
        url: `/tasks/${taskId}/comments`,
        headers: { cookie },
        payload: { body },
      });
    }

    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: `/tasks/${taskId}/comments`,
      headers: { cookie },
    });
    const { comments } = listRes.json() as { comments: { body: string }[] };
    expect(comments.map((c) => c.body)).toEqual(['first', 'second', 'third']);
  });
});
