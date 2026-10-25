import { describe, it, expect } from 'vitest';
import { envBoolean } from './env-boolean.js';

describe('envBoolean', () => {
  it('maps 1/true to true and 0/false to false', () => {
    const schema = envBoolean(false);
    expect(schema.parse('1')).toBe(true);
    expect(schema.parse('true')).toBe(true);
    expect(schema.parse('0')).toBe(false);
    expect(schema.parse('false')).toBe(false);
  });

  it('uses the default when unset or empty', () => {
    expect(envBoolean(true).parse(undefined)).toBe(true);
    expect(envBoolean(true).parse('')).toBe(true);
    expect(envBoolean(false).parse(undefined)).toBe(false);
  });

  it('rejects anything else instead of guessing', () => {
    for (const val of ['no', 'yes', 'off', 'on', 'TRUE', ' true']) {
      expect(() => envBoolean(true).parse(val)).toThrow();
    }
  });

  it('passes real booleans through', () => {
    expect(envBoolean(true).parse(false)).toBe(false);
  });
});
