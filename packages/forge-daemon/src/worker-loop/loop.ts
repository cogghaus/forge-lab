export interface WorkerLoopOptions {
  /** How long to wait between successful poll calls (ms). Default: 5000 */
  pollIntervalMs?: number;
  /** Maximum backoff after repeated errors (ms). Default: 60000 */
  maxBackoffMs?: number;
  /** Signal to abort the loop. */
  signal: AbortSignal;
  /** Called each poll cycle. Errors are caught and backed off. */
  poll: () => Promise<void>;
  logger?: { error(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Runs `poll` in a loop with interval-based scheduling and exponential backoff
 * on errors. Resolves cleanly when `signal` is aborted — including mid-sleep.
 */
export async function runWorkerLoop(opts: WorkerLoopOptions): Promise<void> {
  const { pollIntervalMs = 5000, maxBackoffMs = 60000, signal, poll, logger } = opts;
  let backoff = pollIntervalMs;

  while (!signal.aborted) {
    try {
      await poll();
      backoff = pollIntervalMs;
    } catch (err) {
      logger?.error('worker loop poll error', { error: String(err) });
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
    if (!signal.aborted) {
      await sleepWithAbort(backoff, signal);
    }
  }
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      // Remove the abort listener so it doesn't accumulate on long-lived signals.
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });

    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
  });
}
