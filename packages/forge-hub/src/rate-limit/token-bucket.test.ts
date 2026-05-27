import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TokenBucketStore } from './token-bucket.js';

describe('TokenBucketStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the first request from a new key', () => {
    const store = new TokenBucketStore();
    const result = store.consume('1.2.3.4', 10, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
    store.destroy();
  });

  it('allows up to capacity requests without denial', () => {
    const store = new TokenBucketStore();
    for (let i = 0; i < 10; i++) {
      const result = store.consume('1.2.3.4', 10, 60_000);
      expect(result.allowed).toBe(true);
    }
    store.destroy();
  });

  it('denies the request that exceeds capacity', () => {
    const store = new TokenBucketStore();
    for (let i = 0; i < 10; i++) {
      store.consume('1.2.3.4', 10, 60_000);
    }
    const result = store.consume('1.2.3.4', 10, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    store.destroy();
  });

  it('reports a positive retryAfterMs on denial', () => {
    const store = new TokenBucketStore();
    for (let i = 0; i < 10; i++) {
      store.consume('1.2.3.4', 10, 60_000);
    }
    const result = store.consume('1.2.3.4', 10, 60_000);
    // 10 req/60_000ms = 1 req per 6000ms; retry should be at most one interval.
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(6000);
    store.destroy();
  });

  it('refills tokens over time and allows requests again', () => {
    const store = new TokenBucketStore();
    // Drain the bucket completely.
    for (let i = 0; i < 10; i++) {
      store.consume('1.2.3.4', 10, 60_000);
    }
    // Advance by one refill interval (60_000ms / 10 = 6000ms per token).
    vi.advanceTimersByTime(6001);
    const result = store.consume('1.2.3.4', 10, 60_000);
    expect(result.allowed).toBe(true);
    store.destroy();
  });

  it('does not affect buckets for different keys', () => {
    const store = new TokenBucketStore();
    for (let i = 0; i < 10; i++) {
      store.consume('1.2.3.4', 10, 60_000);
    }
    // A different IP should still have a full bucket.
    const result = store.consume('5.6.7.8', 10, 60_000);
    expect(result.allowed).toBe(true);
    store.destroy();
  });

  it('tracks bucket count via size()', () => {
    const store = new TokenBucketStore();
    expect(store.size()).toBe(0);
    store.consume('1.2.3.4', 10, 60_000);
    expect(store.size()).toBe(1);
    store.consume('5.6.7.8', 10, 60_000);
    expect(store.size()).toBe(2);
    store.destroy();
  });

  it('prunes stale entries after the idle window', () => {
    const store = new TokenBucketStore(1000);
    store.consume('1.2.3.4', 10, 60_000);
    expect(store.size()).toBe(1);
    // The cleanup interval fires at t=1000. At that point cutoff = Date.now() - 1000 = 0
    // and entry.lastRefillMs = 0, so 0 < 0 is false and the entry survives.
    // At the second firing (t=2000) cutoff = 1000 and entry.lastRefillMs = 0, so it is pruned.
    vi.advanceTimersByTime(2001);
    expect(store.size()).toBe(0);
    store.destroy();
  });

  it('destroy() stops the cleanup timer', () => {
    const store = new TokenBucketStore(500);
    store.consume('1.2.3.4', 10, 60_000);
    store.destroy();
    // After destroy, advancing time should NOT trigger cleanup.
    vi.advanceTimersByTime(1000);
    expect(store.size()).toBe(1); // entry still present - no cleanup ran
  });
});
