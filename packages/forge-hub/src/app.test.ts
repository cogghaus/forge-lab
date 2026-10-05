import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  appBaseUrl: 'http://localhost:3001',
  reclaimSweepSeconds: 0,
};

// Test fixture only, not a real credential.
const TEST_WAKER_TOKEN = 'waker-test-token-0123456789abcdef';

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

// ---------------------------------------------------------------------------
// Issue 15: fail fast on :memory: outside tests. NODE_ENV and
// FORGE_HUB_ALLOW_MEMORY_DB are mutated per-test and restored in afterEach so
// this suite cannot leak state into other test files.
// ---------------------------------------------------------------------------

describe('createHub - database safety guard (issue 15)', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalAllow = process.env['FORGE_HUB_ALLOW_MEMORY_DB'];
  let hub: Hub | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (hub) {
      await hub.close();
      hub = undefined;
    }
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalNodeEnv;
    if (originalAllow === undefined) delete process.env['FORGE_HUB_ALLOW_MEMORY_DB'];
    else process.env['FORGE_HUB_ALLOW_MEMORY_DB'] = originalAllow;
    if (tmpDir) {
      // Windows can briefly hold the sqlite file handle open just after
      // raw.close() returns; cleanup is best-effort and must never fail the test.
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore, OS temp dir, not correctness-critical
      }
      tmpDir = undefined;
    }
  });

  it('throws when databaseUrl is :memory: and NODE_ENV=production', async () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['FORGE_HUB_ALLOW_MEMORY_DB'];
    await expect(createHub({ config: { ...testConfig, databaseUrl: ':memory:' } })).rejects.toThrow(
      /FORGE_HUB_DATABASE_URL/,
    );
  });

  it('does not throw when FORGE_HUB_ALLOW_MEMORY_DB=1 even in production', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['FORGE_HUB_ALLOW_MEMORY_DB'] = '1';
    // Production also requires a waker token (security finding 4).
    hub = await createHub({
      config: { ...testConfig, databaseUrl: ':memory:', wakerToken: TEST_WAKER_TOKEN },
    });
    // Reaching here without a throw is the assertion; also sanity-check the
    // hub actually came up and can serve a request.
    const res = await hub.fastify.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('does not throw for a persistent databaseUrl in production', async () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['FORGE_HUB_ALLOW_MEMORY_DB'];
    tmpDir = mkdtempSync(join(tmpdir(), 'forge-hub-issue15-'));
    const dbPath = join(tmpDir, 'hub.db');
    hub = await createHub({
      config: { ...testConfig, databaseUrl: `file:${dbPath}`, wakerToken: TEST_WAKER_TOKEN },
    });
    const res = await hub.fastify.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('does not throw outside production (NODE_ENV unset) even with :memory:', async () => {
    delete process.env['NODE_ENV'];
    delete process.env['FORGE_HUB_ALLOW_MEMORY_DB'];
    hub = await createHub({ config: { ...testConfig, databaseUrl: ':memory:' } });
    const res = await hub.fastify.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Security finding 4 (NEXT-UP.md): the waker endpoint must not silently go
// public when FORGE_HUB_WAKER_TOKEN is omitted. Production refuses to boot,
// mirroring the issue 15 in-memory DB guard above.
// ---------------------------------------------------------------------------

describe('createHub - waker token guard (finding 4)', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalAllow = process.env['FORGE_HUB_ALLOW_MEMORY_DB'];
  let hub: Hub | undefined;

  afterEach(async () => {
    if (hub) {
      await hub.close();
      hub = undefined;
    }
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalNodeEnv;
    if (originalAllow === undefined) delete process.env['FORGE_HUB_ALLOW_MEMORY_DB'];
    else process.env['FORGE_HUB_ALLOW_MEMORY_DB'] = originalAllow;
  });

  // Resolve to the rejection message, or to 'booted' (keeping the hub for
  // afterEach cleanup) so a regression reads as a plain assertion failure.
  async function bootOutcome(config: HubConfig): Promise<string> {
    return createHub({ config }).then(
      (h) => {
        hub = h;
        return 'booted';
      },
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
  }

  it('throws in production when wakerToken is unset', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['FORGE_HUB_ALLOW_MEMORY_DB'] = '1';
    expect(await bootOutcome({ ...testConfig })).toMatch(/FORGE_HUB_WAKER_TOKEN/);
  });

  it('throws in production when wakerToken is an empty string', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['FORGE_HUB_ALLOW_MEMORY_DB'] = '1';
    expect(await bootOutcome({ ...testConfig, wakerToken: '' })).toMatch(/FORGE_HUB_WAKER_TOKEN/);
  });

  it('boots in production when wakerToken is set', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['FORGE_HUB_ALLOW_MEMORY_DB'] = '1';
    hub = await createHub({ config: { ...testConfig, wakerToken: TEST_WAKER_TOKEN } });
    const res = await hub.fastify.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});
