import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHub, type Hub } from '../app.js';
import type { HubConfig } from '../config.js';
import { TEST_HUB_CONFIG, setupAdmin, createWorkspace } from '../test-utils.js';

const testConfig: HubConfig = TEST_HUB_CONFIG;

async function setupUser(hub: Hub, adminCookie: string, email = 'user@example.com'): Promise<{ cookie: string }> {
  const inviteRes = await hub.fastify.inject({
    method: 'POST',
    url: '/admin/invites',
    headers: { cookie: adminCookie },
    payload: {},
  });
  const { token } = inviteRes.json() as { token: string };
  const acceptRes = await hub.fastify.inject({
    method: 'POST',
    url: `/invites/${token}/accept`,
    payload: { email, password: 'password456' },
  });
  const setCookie = acceptRes.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;
  return { cookie };
}

describe('POST /admin/invites', () => {
  let hub: Hub;
  let adminCookie: string;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie: adminCookie } = await setupAdmin(hub));
  });
  afterEach(async () => { await hub.close(); });

  it('creates invite and returns token', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie: adminCookie },
      payload: { email: 'pam@example.com', expiresInHours: 24 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; token: string; email: string; expiresAt: number };
    expect(body.token).toBeTruthy();
    expect(body.email).toBe('pam@example.com');
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when non-admin user calls it', async () => {
    const { cookie: userCookie } = await setupUser(hub, adminCookie);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie: userCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for unknown workspaceId', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie: adminCookie },
      payload: { workspaceId: 'nonexistent', workspaceRole: 'collaborator' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates invite with workspaceId and role', async () => {
    const workspaceId = await createWorkspace(hub, adminCookie);
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie: adminCookie },
      payload: { workspaceId, workspaceRole: 'collaborator' },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('GET /invites/:token', () => {
  let hub: Hub;
  let adminCookie: string;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie: adminCookie } = await setupAdmin(hub));
  });
  afterEach(async () => { await hub.close(); });

  it('returns invite info for valid token', async () => {
    const inviteRes = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie: adminCookie },
      payload: { email: 'pam@example.com' },
    });
    const { token } = inviteRes.json() as { token: string };

    const res = await hub.fastify.inject({ method: 'GET', url: `/invites/${token}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { email: string };
    expect(body.email).toBe('pam@example.com');
  });

  it('returns 404 for unknown token', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/invites/bad-token' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 410 for already accepted invite', async () => {
    const inviteRes = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie: adminCookie },
      payload: {},
    });
    const { token } = inviteRes.json() as { token: string };

    await hub.fastify.inject({
      method: 'POST',
      url: `/invites/${token}/accept`,
      payload: { email: 'new@example.com', password: 'password123' },
    });

    const res = await hub.fastify.inject({ method: 'GET', url: `/invites/${token}` });
    expect(res.statusCode).toBe(410);
  });
});

describe('POST /invites/:token/accept', () => {
  let hub: Hub;
  let adminCookie: string;

  beforeEach(async () => {
    hub = await createHub({ config: { ...testConfig } });
    ({ cookie: adminCookie } = await setupAdmin(hub));
  });
  afterEach(async () => { await hub.close(); });

  it('creates user and returns session cookie', async () => {
    const inviteRes = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie: adminCookie },
      payload: {},
    });
    const { token } = inviteRes.json() as { token: string };

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/invites/${token}/accept`,
      payload: { email: 'new@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { email: string; role: string };
    expect(body.email).toBe('new@example.com');
    expect(body.role).toBe('user');
    expect(res.headers['set-cookie']).toBeTruthy();
  });

  it('returns 404 for unknown token', async () => {
    const res = await hub.fastify.inject({
      method: 'POST',
      url: '/invites/bad-token/accept',
      payload: { email: 'new@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 410 when invite already accepted', async () => {
    const inviteRes = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie: adminCookie },
      payload: {},
    });
    const { token } = inviteRes.json() as { token: string };

    await hub.fastify.inject({
      method: 'POST',
      url: `/invites/${token}/accept`,
      payload: { email: 'first@example.com', password: 'password123' },
    });

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/invites/${token}/accept`,
      payload: { email: 'second@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(410);
  });

  it('returns 403 when email does not match invite email constraint', async () => {
    const inviteRes = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie: adminCookie },
      payload: { email: 'pam@example.com' },
    });
    const { token } = inviteRes.json() as { token: string };

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/invites/${token}/accept`,
      payload: { email: 'notpam@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 409 when email already registered', async () => {
    const inviteRes = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie: adminCookie },
      payload: {},
    });
    const { token } = inviteRes.json() as { token: string };

    const res = await hub.fastify.inject({
      method: 'POST',
      url: `/invites/${token}/accept`,
      payload: { email: 'admin@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('concurrent double-accept with different emails: only one succeeds', async () => {
    const inviteRes = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie: adminCookie },
      payload: {},
    });
    const { token } = inviteRes.json() as { token: string };

    const [res1, res2] = await Promise.all([
      hub.fastify.inject({
        method: 'POST',
        url: `/invites/${token}/accept`,
        payload: { email: 'racer1@example.com', password: 'password123' },
      }),
      hub.fastify.inject({
        method: 'POST',
        url: `/invites/${token}/accept`,
        payload: { email: 'racer2@example.com', password: 'password123' },
      }),
    ]);

    const statuses = [res1.statusCode, res2.statusCode].sort();
    expect(statuses).toEqual([201, 410]);
  });

  it('adds accepted user to workspace when invite includes workspaceId', async () => {
    const workspaceId = await createWorkspace(hub, adminCookie);
    const inviteRes = await hub.fastify.inject({
      method: 'POST',
      url: '/admin/invites',
      headers: { cookie: adminCookie },
      payload: { workspaceId, workspaceRole: 'collaborator' },
    });
    const { token } = inviteRes.json() as { token: string };

    const acceptRes = await hub.fastify.inject({
      method: 'POST',
      url: `/invites/${token}/accept`,
      payload: { email: 'collab@example.com', password: 'password123' },
    });
    expect(acceptRes.statusCode).toBe(201);

    const setCookie = acceptRes.headers['set-cookie'];
    const userCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0]!;

    const wsRes = await hub.fastify.inject({
      method: 'GET',
      url: `/workspaces/${workspaceId}`,
      headers: { cookie: userCookie },
    });
    expect(wsRes.statusCode).toBe(200);
    const ws = wsRes.json() as { role: string };
    expect(ws.role).toBe('collaborator');
  });
});
