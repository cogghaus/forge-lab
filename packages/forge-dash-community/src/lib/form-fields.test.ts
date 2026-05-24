import { describe, it, expect } from 'vitest';
import { normalizeOptional, resolveSelection } from './form-fields.js';

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

describe('resolveSelection', () => {
  it('returns the first key from a Set', () => {
    expect(resolveSelection(new Set(['high']), 'normal')).toBe('high');
  });

  it('returns fallback when Set is empty', () => {
    expect(resolveSelection(new Set(), 'normal')).toBe('normal');
  });

  it('returns fallback when selection is "all"', () => {
    expect(resolveSelection('all', 'normal')).toBe('normal');
  });

  it('returns fallback when selection is null', () => {
    expect(resolveSelection(null, 'normal')).toBe('normal');
  });

  it('returns fallback when selection is undefined', () => {
    expect(resolveSelection(undefined, 'normal')).toBe('normal');
  });

  it('converts numeric keys to string', () => {
    expect(resolveSelection(new Set([42]), 'default')).toBe('42');
  });

  it('regression: HeroUI Select onSelectionChange must resolve to string for hidden input', () => {
    const onSelectionChange = (keys: 'all' | Iterable<string | number>) => {
      return resolveSelection(keys, 'normal');
    };
    expect(onSelectionChange(new Set(['urgent']))).toBe('urgent');
    expect(onSelectionChange(new Set())).toBe('normal');
  });
});
