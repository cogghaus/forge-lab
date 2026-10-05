import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodeCrypto from 'node:crypto';
import { createHub, type Hub } from '../app.js';
import { TEST_HUB_CONFIG } from '../test-utils.js';

// Wrap timingSafeEqual so the suite can assert the token check goes through it
// (security finding 4b). Everything else in node:crypto stays real.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

// Test fixture only, not a real credential.
const WAKER_TOKEN = 'waker-test-token-0123456789abcdef';

// ---------------------------------------------------------------------------
// Security finding 4 (NEXT-UP.md): /waker/has-work must fail closed when no
// token is configured, and compare the token in constant time.
// ---------------------------------------------------------------------------

describe('GET /waker/has-work with a configured token (finding 4)', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: { ...TEST_HUB_CONFIG, wakerToken: WAKER_TOKEN } });
    vi.mocked(nodeCrypto.timingSafeEqual).mockClear();
  });

  afterEach(async () => {
    await hub.close();
  });

  it('returns 200 with the correct bearer token', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/waker/has-work',
      headers: { authorization: `Bearer ${WAKER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pending: 0, byRole: {} });
  });

  it('returns 401 without an authorization header', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/waker/has-work' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a wrong token of the same length', async () => {
    const wrong = WAKER_TOKEN.slice(0, -1) + (WAKER_TOKEN.endsWith('x') ? 'y' : 'x');
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/waker/has-work',
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 (not 500) for tokens of a different length', async () => {
    for (const presented of ['short', `${WAKER_TOKEN}-and-more`, '']) {
      const res = await hub.fastify.inject({
        method: 'GET',
        url: '/waker/has-work',
        headers: { authorization: `Bearer ${presented}` },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('compares via crypto.timingSafeEqual over equal-length buffers, even on length mismatch', async () => {
    await hub.fastify.inject({
      method: 'GET',
      url: '/waker/has-work',
      headers: { authorization: 'Bearer short' },
    });
    const spy = vi.mocked(nodeCrypto.timingSafeEqual);
    expect(spy).toHaveBeenCalledTimes(1);
    const [a, b] = spy.mock.calls[0]! as [Buffer, Buffer];
    expect(a.length).toBe(b.length);
  });
});

describe('GET /waker/has-work without a configured token (finding 4, fail closed)', () => {
  let hub: Hub;

  beforeEach(async () => {
    hub = await createHub({ config: { ...TEST_HUB_CONFIG } });
  });

  afterEach(async () => {
    await hub.close();
  });

  it('refuses unauthenticated requests instead of serving them', async () => {
    const res = await hub.fastify.inject({ method: 'GET', url: '/waker/has-work' });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe('waker_token_not_configured');
  });

  it('refuses requests carrying any bearer token', async () => {
    const res = await hub.fastify.inject({
      method: 'GET',
      url: '/waker/has-work',
      headers: { authorization: 'Bearer anything' },
    });
    expect(res.statusCode).toBe(503);
  });
});
