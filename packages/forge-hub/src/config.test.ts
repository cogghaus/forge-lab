import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

// Test fixture only, not a real credential.
const BASE_ENV = { FORGE_HUB_SESSION_SECRET: 'test-secret-with-at-least-32-characters-xxxx' };

function cookieSecureFor(value: string | undefined): boolean {
  const env: NodeJS.ProcessEnv = { ...BASE_ENV };
  if (value !== undefined) env['FORGE_HUB_COOKIE_SECURE'] = value;
  return loadConfig(env).cookieSecure;
}

// ---------------------------------------------------------------------------
// Security finding 5 (NEXT-UP.md): the session cookie's Secure flag defaults
// on, and FORGE_HUB_COOKIE_SECURE is parsed explicitly. z.coerce.boolean()
// turned 'false' and '0' into true, so the flag could not be disabled.
// ---------------------------------------------------------------------------

describe('loadConfig cookieSecure (finding 5)', () => {
  it('defaults to true when FORGE_HUB_COOKIE_SECURE is unset', () => {
    expect(cookieSecureFor(undefined)).toBe(true);
  });

  it('treats an empty FORGE_HUB_COOKIE_SECURE as unset (true)', () => {
    expect(cookieSecureFor('')).toBe(true);
  });

  it.each(['true', '1'])('parses %j as true', (value) => {
    expect(cookieSecureFor(value)).toBe(true);
  });

  it.each(['false', '0'])('parses %j as false', (value) => {
    expect(cookieSecureFor(value)).toBe(false);
  });

  it.each(['yes', 'no', 'off', 'FALSE', 'True', ' true'])(
    'rejects ambiguous value %j instead of guessing',
    (value) => {
      expect(() => cookieSecureFor(value)).toThrow();
    },
  );
});
