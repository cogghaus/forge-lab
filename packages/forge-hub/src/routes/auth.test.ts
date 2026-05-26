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

async function registerAndLogin(
  hub: Hub,
  email = 'admin@example.com',
  password = 'password123',
): Promise<{ cookie: string; id: string }> {
  const regRes = await hub.fastify.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password },
  });
  const { id } = regRes.json() as { id: string };
  const loginRes = await hub.fastify.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  const setCookie = loginRes.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
  return { cookie, id };
}

describe('POST /auth/register', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: testConfig });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('first registration succeeds and returns id + role', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'admin@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; email: string; role: string };
    expect(body.id).toBeTruthy();
    expect(body.email).toBe('admin@example.com');
    expect(body.role).toBe('admin');
  });

  it('second registration returns 403 registration_disabled', async () => {
    await hub.fastify.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'admin@example.com', password: 'password123' },
    });
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'user2@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('registration_disabled');
  });

  it('returns 400 for invalid email', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'not-an-email', password: 'password123' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /auth/login', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: testConfig });
    await hub.fastify.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'admin@example.com', password: 'password123' },
    });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('valid credentials return 200 and set session cookie', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; email: string; role: string };
    expect(body.email).toBe('admin@example.com');
    expect(body.role).toBe('admin');
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieStr).toContain('session=');
  });

  it('wrong password returns 401', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@example.com', password: 'wrongpassword123' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('unknown email returns 401', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /auth/me', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: testConfig });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('returns user id, email, and role when authenticated', async () => {
    const { cookie, id } = await registerAndLogin(hub);
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; email: string; role: string };
    expect(body.id).toBe(id);
    expect(body.email).toBe('admin@example.com');
    expect(body.role).toBe('admin');
  });

  it('returns 401 when not authenticated', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/auth/me',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: testConfig });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('clears session cookie and returns ok', async () => {
    const { cookie } = await registerAndLogin(hub);
    const logoutRes = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect((logoutRes.json() as { ok: boolean }).ok).toBe(true);

    // Subsequent authenticated request should fail
    const meRes = await hub.fastify.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie },
    });
    expect(meRes.statusCode).toBe(401);
  });
});
