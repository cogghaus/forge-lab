import { z } from 'zod';

/**
 * Strict boolean env var, shared by forge-hub and forge-daemon (hub security
 * finding 5). z.coerce.boolean() is NOT used: it is Boolean(value), so 'false'
 * and '0' coerce to true. Accepts only '1'/'true' (true) and '0'/'false'
 * (false); unset or empty takes the default. Anything else is rejected at boot
 * rather than guessed, so a typo cannot silently flip a security flag. Real
 * booleans pass through for callers that build config objects directly.
 */
export function envBoolean(defaultValue: boolean) {
  return z.preprocess(
    (val) => (val === undefined || val === '' ? defaultValue : val),
    z.union([
      z.boolean(),
      z.enum(['1', 'true', '0', 'false']).transform((v) => v === '1' || v === 'true'),
    ]),
  );
}
