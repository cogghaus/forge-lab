import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('rate limiting on auth endpoints', () => {
  let hub: Hub;

  beforeEach(async () => {
    // Do NOT enable fake timers here — faking setTimeout/setImmediate
    // disrupts Fastify's internal async plumbing and hangs the hub startup.
    hub = await createHub({ config: TEST_HUB_CONFIG });
  });

  afterEach(async () => {
    vi.useRealTimers(); // restore in case the refill test left fake timers active
    await hub.close();
  });

  it('returns 429 after 10 POST /auth/login requests from the same IP', async () => {
    // Exhaust the 10-request bucket. No user registered, so each returns 401.
    for (let i = 0; i < 10; i++) {
      const res = await hub.fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'attacker@example.com', password: 'password123' },
      });
      expect(res.statusCode).toBe(401);
    }
    // 11th request must be rate-limited.
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'attacker@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(429);
    const body = res.json() as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe('too_many_requests');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('returns 429 after 10 POST /auth/register requests from the same IP', async () => {
    // Exhaust the bucket. First registration succeeds (201), rest return 403 or 429.
    for (let i = 0; i < 10; i++) {
      await hub.fastify.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: `user${i}@example.com`, password: 'password123' },
      });
    }
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'user11@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(429);
  });

  it('allows requests again after tokens refill', async () => {
    // Drain the bucket.
    for (let i = 0; i < 10; i++) {
      await hub.fastify.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'attacker@example.com', password: 'password123' },
      });
    }
    // Confirm bucket is exhausted.
    const denied = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'attacker@example.com', password: 'password123' },
    });
    expect(denied.statusCode).toBe(429);

    // Fake only Date (not setTimeout/setImmediate) so the token bucket sees
    // advanced time without disrupting Fastify's async internals.
    // One token refills every 60_000ms / 10 = 6_000ms.
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + 6001);

    const allowed = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'attacker@example.com', password: 'password123' },
    });
    // Rate limit lifted; request reaches the route handler (returns 401 - no user).
    expect(allowed.statusCode).toBe(401);

    vi.useRealTimers();
  });
});
