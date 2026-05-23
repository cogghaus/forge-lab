import { setMaxListeners } from 'node:events';
import { describe, it, expect } from 'vitest';
import { runWorkerLoop } from './loop.js';

describe('runWorkerLoop', () => {
  it('calls poll repeatedly until signal is aborted', async () => {
    const ctrl = new AbortController();
    let callCount = 0;

    const loopPromise = runWorkerLoop({
      signal: ctrl.signal,
      pollIntervalMs: 15,
      poll: async () => {
        callCount++;
      },
    });

    await new Promise((r) => setTimeout(r, 80));
    ctrl.abort();
    await loopPromise;

    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('returns immediately when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let called = false;

    await runWorkerLoop({
      signal: ctrl.signal,
      pollIntervalMs: 1000,
      poll: async () => {
        called = true;
      },
    });

    expect(called).toBe(false);
  });

  it('resolves quickly when aborted mid-sleep', async () => {
    const ctrl = new AbortController();
    let pollCount = 0;
    const start = Date.now();

    const loopPromise = runWorkerLoop({
      signal: ctrl.signal,
      pollIntervalMs: 10000,
      poll: async () => {
        pollCount++;
      },
    });

    await new Promise((r) => setTimeout(r, 30));
    ctrl.abort();
    await loopPromise;

    expect(Date.now() - start).toBeLessThan(300);
    expect(pollCount).toBe(1);
  });

  it('applies exponential backoff on poll errors', async () => {
    const ctrl = new AbortController();
    const timestamps: number[] = [];
    let failsRemaining = 3;

    const loopPromise = runWorkerLoop({
      signal: ctrl.signal,
      pollIntervalMs: 10,
      maxBackoffMs: 200,
      poll: async () => {
        timestamps.push(Date.now());
        if (failsRemaining-- > 0) throw new Error('poll failed');
      },
    });

    await new Promise((r) => setTimeout(r, 400));
    ctrl.abort();
    await loopPromise;

    expect(timestamps.length).toBeGreaterThanOrEqual(3);
    if (timestamps.length >= 3) {
      const gap1 = timestamps[1]! - timestamps[0]!;
      const gap2 = timestamps[2]! - timestamps[1]!;
      expect(gap2).toBeGreaterThan(gap1);
    }
  });

  it('resets backoff to pollIntervalMs after a successful poll', async () => {
    const ctrl = new AbortController();
    const timestamps: number[] = [];
    let callCount = 0;

    const loopPromise = runWorkerLoop({
      signal: ctrl.signal,
      pollIntervalMs: 10,
      maxBackoffMs: 500,
      poll: async () => {
        timestamps.push(Date.now());
        callCount++;
        if (callCount === 1) throw new Error('first call fails');
        // second call succeeds — backoff resets to 10ms
      },
    });

    await new Promise((r) => setTimeout(r, 200));
    ctrl.abort();
    await loopPromise;

    expect(callCount).toBeGreaterThanOrEqual(3);
    // Gap between call 2 and call 3 should be ~10ms (reset), not 40ms (doubled again)
    if (timestamps.length >= 3) {
      const gapAfterReset = timestamps[2]! - timestamps[1]!;
      expect(gapAfterReset).toBeLessThan(50);
    }
  });

  it('does not leak abort listeners across natural timer expirations', async () => {
    const ctrl = new AbortController();
    setMaxListeners(5, ctrl.signal);

    const warnings: string[] = [];
    const onWarning = (w: Error & { name?: string }) => {
      if (w.name === 'MaxListenersExceededWarning') warnings.push(w.message);
    };
    process.on('warning', onWarning);

    const loopPromise = runWorkerLoop({
      signal: ctrl.signal,
      pollIntervalMs: 10,
      poll: async () => {},
    });

    await new Promise((r) => setTimeout(r, 120));
    ctrl.abort();
    await loopPromise;
    process.off('warning', onWarning);

    expect(warnings).toHaveLength(0);
  });

  it('logs errors via the logger option', async () => {
    const ctrl = new AbortController();
    const errors: string[] = [];

    const loopPromise = runWorkerLoop({
      signal: ctrl.signal,
      pollIntervalMs: 10,
      poll: async () => {
        throw new Error('boom');
      },
      logger: {
        error: (msg) => errors.push(msg),
      },
    });

    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    await loopPromise;

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('poll error');
  });
});
