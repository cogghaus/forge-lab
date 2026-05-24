import { describe, it, expect } from 'vitest';
import { normalizeOptional } from './form-fields.js';

describe('normalizeOptional', () => {
  it('returns undefined for null input', () => {
    expect(normalizeOptional(null)).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(normalizeOptional('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string', () => {
    expect(normalizeOptional('   ')).toBeUndefined();
  });

  it('returns trimmed string for non-empty value', () => {
    expect(normalizeOptional('  hello  ')).toBe('hello');
  });

  it('returns string as-is when no whitespace', () => {
    expect(normalizeOptional('Phase 2 goals')).toBe('Phase 2 goals');
  });

  it('never returns null (regression: goal description sent null to hub)', () => {
    const result = normalizeOptional(null);
    expect(result).not.toBeNull();
  });
});
