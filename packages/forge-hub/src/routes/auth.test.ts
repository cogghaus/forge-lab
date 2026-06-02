import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { schema } from '@forge-lab/core';
import { createHub, type Hub } from '../app.js';
import { TEST_HUB_CONFIG, setupAdmin } from '../test-utils.js';
import { createSession, listSessions } from '../auth/sessions.js';


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

describe('PATCH /auth/password', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: '/auth/password',
      payload: { currentPassword: 'password123', newPassword: 'newpassword456' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for new password too short (< 8 chars)', async () => {
    const { cookie } = await setupAdmin(hub);
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: '/auth/password',
      headers: { cookie },
      payload: { currentPassword: 'password123', newPassword: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 401 for wrong current password', async () => {
    const { cookie } = await setupAdmin(hub);
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: '/auth/password',
      headers: { cookie },
      payload: { currentPassword: 'wrongpassword', newPassword: 'newpassword456' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: string }).error).toBe('invalid_password');
  });

  it('successfully changes password and invalidates old login', async () => {
    const { cookie } = await setupAdmin(hub);

    // Change the password
    const changeRes = await hub.fastify.inject({
      method: 'PATCH',
      url: '/auth/password',
      headers: { cookie },
      payload: { currentPassword: 'password123', newPassword: 'newpassword456' },
    });
    expect(changeRes.statusCode).toBe(200);
    expect((changeRes.json() as { ok: boolean }).ok).toBe(true);

    // Old password should no longer work for login
    const oldLoginRes = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@example.com', password: 'password123' },
    });
    expect(oldLoginRes.statusCode).toBe(401);

    // New password should work
    const newLoginRes = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@example.com', password: 'newpassword456' },
    });
    expect(newLoginRes.statusCode).toBe(200);
  });
});

describe('PATCH /auth/email', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('returns 401 when not authenticated', async () => {
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: '/auth/email',
      payload: { newEmail: 'new@example.com' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for invalid email format', async () => {
    const { cookie } = await setupAdmin(hub);
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: '/auth/email',
      headers: { cookie },
      payload: { newEmail: 'not-a-valid-email' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when email already taken', async () => {
    const { cookie } = await setupAdmin(hub);
    // Try to change to the same email already registered
    const res = await hub.fastify.inject({
      method: 'PATCH',
      url: '/auth/email',
      headers: { cookie },
      payload: { newEmail: 'admin@example.com' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('email_taken');
  });

  it('successfully changes email — new email works at login, old does not', async () => {
    const { cookie } = await setupAdmin(hub);

    // Change the email
    const changeRes = await hub.fastify.inject({
      method: 'PATCH',
      url: '/auth/email',
      headers: { cookie },
      payload: { newEmail: 'newemail@example.com' },
    });
    expect(changeRes.statusCode).toBe(200);
    expect((changeRes.json() as { ok: boolean }).ok).toBe(true);

    // Old email should no longer work for login
    const oldLoginRes = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'admin@example.com', password: 'password123' },
    });
    expect(oldLoginRes.statusCode).toBe(401);

    // New email should work
    const newLoginRes = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'newemail@example.com', password: 'password123' },
    });
    expect(newLoginRes.statusCode).toBe(200);
  });
});

describe('GET /auth/email/verify', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('returns 400 when token is missing', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/auth/email/verify',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('token_required');
  });

  it('returns 404 for unknown token', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/auth/email/verify?token=nonexistenttoken12345678901234567890',
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('invalid_token');
  });

  it('returns 410 for expired token', async () => {
    const { id } = await setupAdmin(hub);
    const token = nanoid(40);
    const expiredAt = new Date(Date.now() - 1000); // already expired

    await hub.db.insert(schema.emailVerifications).values({
      id: nanoid(),
      userId: id,
      newEmail: 'new@example.com',
      token,
      expiresAt: expiredAt,
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/auth/email/verify?token=${token}`,
    });
    expect(res.statusCode).toBe(410);
    expect((res.json() as { error: string }).error).toBe('token_expired');
  });

  it('successfully verifies token and updates email', async () => {
    const { id } = await setupAdmin(hub);
    const token = nanoid(40);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await hub.db.insert(schema.emailVerifications).values({
      id: nanoid(),
      userId: id,
      newEmail: 'verified@example.com',
      token,
      expiresAt,
    });

    const res = await hub.fastify.inject({
      method: 'GET',
      url: `/auth/email/verify?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(true);

    // Confirm the email was actually changed in the DB
    const loginRes = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'verified@example.com', password: 'password123' },
    });
    expect(loginRes.statusCode).toBe(200);
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

describe('Session management (/auth/sessions)', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: TEST_HUB_CONFIG });
  });

  afterEach(async () => {
    await hub.close();
  });

  /** Logs in an existing user again, returning the new session cookie. */
  async function login(email: string, password: string, userAgent?: string): Promise<string> {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/login',
      headers: userAgent ? { 'user-agent': userAgent } : {},
      payload: { email, password },
    });
    const setCookie = res.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
  }

  it('GET /auth/sessions requires auth', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/auth/sessions' });
    expect(res.statusCode).toBe(401);
  });

  it('lists the current session and flags it', async () => {
    const { cookie } = await setupAdmin(hub);
    const res = await hub.fastify.inject({ method: 'GET', url: '/auth/sessions', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { sessions } = res.json() as { sessions: { id: string; current: boolean }[] };
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.current).toBe(true);
  });

  it('captures user-agent and lists multiple sessions with one current', async () => {
    const { cookie } = await setupAdmin(hub);
    await login('admin@example.com', 'password123', 'Mozilla/5.0 TestBrowser');

    const res = await hub.fastify.inject({ method: 'GET', url: '/auth/sessions', headers: { cookie } });
    const { sessions } = res.json() as { sessions: { current: boolean; userAgent: string | null }[] };
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.some((s) => s.userAgent === 'Mozilla/5.0 TestBrowser')).toBe(true);
  });

  it('DELETE revokes another session', async () => {
    const { cookie } = await setupAdmin(hub);
    const otherCookie = await login('admin@example.com', 'password123', 'OtherDevice');

    let res = await hub.fastify.inject({ method: 'GET', url: '/auth/sessions', headers: { cookie } });
    const { sessions } = res.json() as { sessions: { id: string; current: boolean }[] };
    const other = sessions.find((s) => !s.current)!;

    const del = await hub.fastify.inject({
      method: 'DELETE',
      url: `/auth/sessions/${other.id}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);

    // The revoked cookie no longer authenticates.
    const check = await hub.fastify.inject({ method: 'GET', url: '/auth/me', headers: { cookie: otherCookie } });
    expect(check.statusCode).toBe(401);

    res = await hub.fastify.inject({ method: 'GET', url: '/auth/sessions', headers: { cookie } });
    expect((res.json() as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it('DELETE returns 404 for an unknown / foreign session id', async () => {
    const { cookie } = await setupAdmin(hub);
    const res = await hub.fastify.inject({
      method: 'DELETE',
      url: `/auth/sessions/${nanoid()}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('revoke-others keeps only the current session', async () => {
    const { cookie } = await setupAdmin(hub);
    await login('admin@example.com', 'password123', 'DeviceA');
    await login('admin@example.com', 'password123', 'DeviceB');

    const revoke = await hub.fastify.inject({
      method: 'POST',
      url: '/auth/sessions/revoke-others',
      headers: { cookie },
    });
    expect(revoke.statusCode).toBe(200);
    expect((revoke.json() as { revoked: number }).revoked).toBe(2);

    const res = await hub.fastify.inject({ method: 'GET', url: '/auth/sessions', headers: { cookie } });
    const { sessions } = res.json() as { sessions: { current: boolean }[] };
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.current).toBe(true);
  });

  it('caps a user\'s sessions on repeated logins (GC + prune)', async () => {
    const { id: userId } = await setupAdmin(hub); // 1 session from the login
    let lastToken = '';
    for (let i = 0; i < 25; i++) {
      const s = await createSession(hub.db, userId, 24, { userAgent: `client-${i}` });
      lastToken = s.token;
    }
    const sessions = await listSessions(hub.db, userId, lastToken);
    // Unbounded growth is prevented: count never exceeds the cap (20).
    expect(sessions.length).toBe(20);
    // The most recent login is retained and flagged current.
    expect(sessions.some((s) => s.current)).toBe(true);
  });

  it('prunes expired sessions on login', async () => {
    const { id: userId } = await setupAdmin(hub);
    // An already-expired session (negative TTL).
    await createSession(hub.db, userId, -1, { userAgent: 'stale' });
    // A fresh login triggers pruneUserSessions, deleting the expired row.
    const fresh = await createSession(hub.db, userId, 24, { userAgent: 'fresh' });
    const rows = await hub.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userId))
      .all();
    expect(rows.some((r) => r.userAgent === 'stale')).toBe(false);
    expect(rows.some((r) => r.userAgent === 'fresh')).toBe(true);
    expect(fresh.token).toBeTruthy();
  });
});
