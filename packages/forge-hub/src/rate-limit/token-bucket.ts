/**
 * Token bucket rate limiter store.
 *
 * Each key (typically an IP address) gets its own bucket with a fixed capacity.
 * Tokens refill continuously at `capacity / windowMs` tokens per millisecond.
 * A request costs 1 token; if none are available the request is denied with a
 * `retryAfterMs` value indicating when the next token will be ready.
 */

export interface ConsumeResult {
  allowed: boolean;
  /** Milliseconds until 1 token is available. 0 when allowed. */
  retryAfterMs: number;
}

interface BucketEntry {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketStore {
  private readonly buckets = new Map<string, BucketEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * @param maxIdleMs - Entries not accessed within this window are pruned.
   *   Defaults to 5 minutes.
   */
  constructor(private readonly maxIdleMs = 5 * 60_000) {
    this.cleanupTimer = setInterval(() => {
      this.pruneStale();
    }, maxIdleMs);
    // Do not prevent the process from exiting while the timer is active.
    this.cleanupTimer.unref();
  }

  /**
   * Attempt to consume 1 token from the bucket for the given key.
   *
   * @param key      - Identifies the rate-limited actor (e.g. IP address).
   * @param capacity - Maximum tokens the bucket can hold.
   * @param windowMs - Time in milliseconds to refill the bucket from 0 to capacity.
   */
  consume(key: string, capacity: number, windowMs: number): ConsumeResult {
    if (capacity <= 0 || windowMs <= 0) {
      // Guard against division by zero; treat as fully rate-limited.
      return { allowed: false, retryAfterMs: windowMs > 0 ? windowMs : 60_000 };
    }
    const now = Date.now();
    const refillRatePerMs = capacity / windowMs;

    let entry = this.buckets.get(key);
    if (entry === undefined) {
      // First request: start with a full bucket minus the consumed token.
      this.buckets.set(key, { tokens: capacity - 1, lastRefillMs: now });
      return { allowed: true, retryAfterMs: 0 };
    }

    // Refill based on elapsed time since last request.
    const elapsed = now - entry.lastRefillMs;
    const refilled = Math.min(capacity, entry.tokens + elapsed * refillRatePerMs);
    entry.lastRefillMs = now;

    if (refilled >= 1) {
      entry.tokens = refilled - 1;
      return { allowed: true, retryAfterMs: 0 };
    }

    // Not enough tokens. Store the partially-refilled amount and report wait time.
    entry.tokens = refilled;
    const retryAfterMs = Math.ceil((1 - refilled) / refillRatePerMs);
    return { allowed: false, retryAfterMs };
  }

  /** Number of tracked buckets (useful for testing). */
  size(): number {
    return this.buckets.size;
  }

  /** Cancel the cleanup interval. Call when the hub closes. */
  destroy(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private pruneStale(): void {
    const cutoff = Date.now() - this.maxIdleMs;
    for (const [key, entry] of this.buckets) {
      if (entry.lastRefillMs < cutoff) {
        this.buckets.delete(key);
      }
    }
  }
}
