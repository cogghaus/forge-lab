import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHub, type Hub } from './app.js';
import type { HubConfig } from './config.js';

const testConfig: HubConfig = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl: ':memory:',
  sessionSecret: 'test-secret-with-at-least-32-characters-xxxx',
  sessionTtlHours: 24,
  bcryptCost: 10,
  cookieSecure: false,
};

describe('forge-hub smoke', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('registers first user as admin', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'admin@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { role: string };
    expect(body.role).toBe('admin');
  });

  it('rejects second registration', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'admin@example.com', password: 'password123' },
    });
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'second@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('login sets session cookie and subsequent request is authenticated', async () => {
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
    expect(loginRes.statusCode).toBe(200);
    const setCookie = loginRes.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieValue).toMatch(/^session=/);

    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: '/devices',
      headers: { cookie: cookieValue!.split(';')[0]! },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toEqual({ devices: [] });
  });

  it('unauthenticated /devices returns 401', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/devices' });
    expect(res.statusCode).toBe(401);
  });

  it('device register + token works for /tasks list', async () => {
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

    const regRes = await hub.fastify.inject({
      method: 'POST',
      url: '/devices',
      headers: { cookie },
      payload: { name: 'desktop', hostname: 'workstation', platform: 'win32' },
    });
    expect(regRes.statusCode).toBe(201);
    const { token } = regRes.json() as { token: string };
    expect(token).toBeTruthy();

    const listRes = await hub.fastify.inject({
      method: 'GET',
      url: '/tasks',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toEqual({ tasks: [] });
  });
});
