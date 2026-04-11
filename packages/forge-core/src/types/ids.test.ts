import { describe, it, expect } from 'vitest';
import { TaskIdSchema, formatTaskId, parseTaskId } from './ids.js';

describe('task IDs', () => {
  it('formats with zero-padded sequence', () => {
    expect(formatTaskId('fl', 1)).toBe('fl-001');
    expect(formatTaskId('fl', 42)).toBe('fl-042');
    expect(formatTaskId('cg', 1000)).toBe('cg-1000');
  });

  it('lowercases the project prefix', () => {
    expect(formatTaskId('FL', 5)).toBe('fl-005');
  });

  it('round-trips via parse', () => {
    const id = formatTaskId('fl', 7);
    expect(parseTaskId(id)).toEqual({ projectPrefix: 'fl', sequence: 7 });
  });

  it('rejects malformed ids', () => {
    expect(() => TaskIdSchema.parse('FL-1')).toThrow();
    expect(() => TaskIdSchema.parse('fl1')).toThrow();
    expect(() => TaskIdSchema.parse('')).toThrow();
    expect(() => TaskIdSchema.parse('toolongprefix-001')).toThrow();
  });
});
