import { describe, it, expect } from 'vitest';
import { authedUrl, taskBranch } from './repo.js';

describe('authedUrl', () => {
  it('injects an x-access-token credential into an https URL', () => {
    expect(authedUrl('https://github.com/sugar-crash-studios/hal.git', 'ghp_abc')).toBe(
      'https://x-access-token:ghp_abc@github.com/sugar-crash-studios/hal.git',
    );
  });

  it('url-encodes a token with special characters', () => {
    expect(authedUrl('https://github.com/o/r', 'a/b+c')).toBe(
      'https://x-access-token:a%2Fb%2Bc@github.com/o/r',
    );
  });

  it('is case-insensitive on the scheme', () => {
    expect(authedUrl('HTTPS://github.com/o/r', 't')).toBe('https://x-access-token:t@github.com/o/r');
  });

  it('leaves a non-https URL unchanged (no token leak into ssh/file URLs)', () => {
    expect(authedUrl('git@github.com:o/r.git', 't')).toBe('git@github.com:o/r.git');
    expect(authedUrl('file:///tmp/repo', 't')).toBe('file:///tmp/repo');
  });
});

describe('taskBranch', () => {
  it('namespaces the task id under forge/', () => {
    expect(taskBranch('hal-001')).toBe('forge/hal-001');
  });
});
