import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHub, type Hub } from '../app.js';
import { TEST_HUB_CONFIG, setupAdmin } from '../test-utils.js';


describe('POST /auth/register', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
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

  it('returns 400 for password shorter than 8 characters', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'admin@example.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /auth/login', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
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
    hub = await createHub({ config: TEST_HUB_CONFIG });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('returns user id, email, and role when authenticated', async () => {
    const { cookie, id } = await setupAdmin(hub);
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

  it('returns 401 with a bogus session token', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: 'session=this-is-not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('clears session cookie and returns ok', async () => {
    const { cookie } = await setupAdmin(hub);
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

  it('returns 200 ok even when called without a session cookie', async () => {
    // POST /auth/logout is not protected — graceful no-op when unauthenticated
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/logout',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);
  });
});
