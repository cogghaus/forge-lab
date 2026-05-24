import { describe, it, expect } from 'vitest';
import { derivePrefix } from './task-prefix.js';

describe('derivePrefix', () => {
  it('takes first letter of each hyphen-segment', () => {
    expect(derivePrefix('forge-lab')).toBe('fl');
  });

  it('single word uses first 6 chars', () => {
    expect(derivePrefix('community')).toBe('commun');
  });

  it('caps at 6 chars for many segments', () => {
    const result = derivePrefix('a-b-c-d-e-f-g');
    expect(result).toHaveLength(6);
    expect(result).toBe('abcdef');
  });

  it('pads short result to minimum 2 chars', () => {
    expect(derivePrefix('a')).toHaveLength(2);
  });

  it('strips non-alpha characters', () => {
    const result = derivePrefix('my-project-2025');
    expect(result).toMatch(/^[a-z]{2,6}$/);
  });

  it('empty slug falls back to ws', () => {
    expect(derivePrefix('')).toBe('ws');
  });

  it('always produces a string matching TaskIdSchema pattern [a-z]{2,6}', () => {
    const pattern = /^[a-z]{2,6}$/;
    const slugs = ['forge-lab', 'community', 'a-b-c-d-e-f-g', 'a', '', '123-456', 'a-', 'hello-world-foo', 'x'];
    for (const slug of slugs) {
      expect(derivePrefix(slug)).toMatch(pattern);
    }
  });
});
