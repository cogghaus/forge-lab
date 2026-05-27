import type { preHandlerHookHandler } from 'fastify';
import { TokenBucketStore } from './token-bucket.js';

export { TokenBucketStore };
export type { ConsumeResult } from './token-bucket.js';

export interface TokenBucketOptions {
  /** Maximum requests allowed per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Creates a Fastify preHandler that enforces a per-IP token-bucket rate limit.
 *
 * Denied requests receive HTTP 429 with a `Retry-After` header and a JSON body
 * of `{ error: "too_many_requests", retryAfterSeconds: number }`.
 */
export function createTokenBucketPreHandler(
  store: TokenBucketStore,
  options: TokenBucketOptions,
): preHandlerHookHandler {
  const { max, windowMs } = options;
  return async (req, reply): Promise<void> => {
    const result = store.consume(req.ip, max, windowMs);
    if (!result.allowed) {
      const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
      await reply
        .code(429)
        .header('Retry-After', String(retryAfterSeconds))
        .send({ error: 'too_many_requests', retryAfterSeconds });
      return;
    }
  };
}
