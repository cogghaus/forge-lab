/**
 * Shared test utilities for forge-hub route tests.
 *
 * Import from here instead of duplicating these helpers across test files.
 */
import type { Hub } from './app.js';

export const TEST_HUB_CONFIG = {
  port: 0,
  host: '127.0.0.1',
  databaseUrl: ':memory:',
  sessionSecret: 'test-secret-with-at-least-32-characters-xxxx',
  sessionTtlHours: 24,
  bcryptCost: 10,
  cookieSecure: false,
  appBaseUrl: 'http://localhost:3001',
  // Reclaim sweep interval defaults to 60s (see config.ts); tests that don't
  // exercise the lease sweep should not have a background timer running.
  // Tests covering the sweep itself call sweepExpiredLeases directly instead
  // of relying on the interval.
  reclaimSweepSeconds: 0,
} as const;

/** Register the first (admin) user and log in. Returns session cookie. */
export async function setupAdmin(
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

/** Register a device and return its id + token. */
export async function registerDevice(
  hub: Hub,
  cookie: string,
  name: string,
  opts: { agentId?: string; deviceType?: 'worker' | 'orchestrator' } = {},
): Promise<{ id: string; token: string }> {
  const res = await hub.fastify.inject({
    method: 'POST',
    url: '/devices',
    headers: { cookie },
    payload: {
      name,
      hostname: 'host',
      platform: 'win32',
      ...opts,
    },
  });
  const body = res.json() as { id: string; token: string };
  return { id: body.id, token: body.token };
}

/** Create a task (unscoped) and return its id. */
export async function createTask(
  hub: Hub,
  cookie: string,
  opts: { projectPrefix?: string; title?: string } = {},
): Promise<string> {
  const res = await hub.fastify.inject({
    method: 'POST',
    url: '/tasks',
    headers: { cookie },
    payload: {
      projectPrefix: opts.projectPrefix ?? 'fl',
      title: opts.title ?? 'Test task',
    },
  });
  return (res.json() as { id: string }).id;
}

/** Create a workspace and return its id. */
export async function createWorkspace(
  hub: Hub,
  cookie: string,
  opts: { name?: string; slug?: string } = {},
): Promise<string> {
  const res = await hub.fastify.inject({
    method: 'POST',
    url: '/workspaces',
    headers: { cookie },
    payload: {
      name: opts.name ?? 'Test WS',
      slug: opts.slug ?? 'test-ws',
    },
  });
  return (res.json() as { id: string }).id;
}
