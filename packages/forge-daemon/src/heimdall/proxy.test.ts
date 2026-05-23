import { describe, it, expect } from 'vitest';
import { platform } from 'node:os';
import path from 'node:path';
import { checkOperation, createPolicy } from './proxy.js';

const WORKDIR = path.resolve('/workspace/project');

describe('checkOperation — no policy (pass-through)', () => {
  it('allows read', () => {
    expect(checkOperation({ type: 'read', path: '/etc/passwd' })).toEqual({ allow: true });
  });

  it('allows write', () => {
    expect(checkOperation({ type: 'write', path: '/tmp/out.txt' })).toEqual({ allow: true });
  });

  it('allows execute with no path', () => {
    expect(checkOperation({ type: 'execute' })).toEqual({ allow: true });
  });
});

describe('checkOperation — with policy', () => {
  it('allows read inside workdir', () => {
    const policy = createPolicy(WORKDIR);
    expect(
      checkOperation({ type: 'read', path: path.join(WORKDIR, 'src', 'index.ts') }, policy),
    ).toEqual({ allow: true });
  });

  it('allows write inside workdir', () => {
    const policy = createPolicy(WORKDIR);
    expect(
      checkOperation({ type: 'write', path: path.join(WORKDIR, 'output', 'result.txt') }, policy),
    ).toEqual({ allow: true });
  });

  it('allows access to the workdir root itself', () => {
    const policy = createPolicy(WORKDIR);
    expect(checkOperation({ type: 'read', path: WORKDIR }, policy)).toEqual({ allow: true });
  });

  it('denies read outside workdir', () => {
    const policy = createPolicy(WORKDIR);
    // Use a path that is clearly outside the workdir on any platform.
    const outsidePath = platform() === 'win32'
      ? 'C:\\Windows\\System32\\secret.txt'
      : '/etc/passwd';
    const result = checkOperation({ type: 'read', path: outsidePath }, policy);
    expect(result.allow).toBe(false);
    // reason contains the resolved (normalized) path
    expect(result.reason).toContain(path.resolve(outsidePath));
  });

  it('denies write to sibling directory', () => {
    const policy = createPolicy(WORKDIR);
    const sibling = path.resolve('/workspace/other-project/secret.txt');
    const result = checkOperation({ type: 'write', path: sibling }, policy);
    expect(result.allow).toBe(false);
  });

  it('rejects path traversal escaping the workdir', () => {
    const policy = createPolicy(WORKDIR);
    const traversal = path.join(WORKDIR, '..', '..', 'etc', 'passwd');
    const result = checkOperation({ type: 'read', path: traversal }, policy);
    expect(result.allow).toBe(false);
  });

  it('allows execute with no path even under policy', () => {
    const policy = createPolicy(WORKDIR);
    expect(checkOperation({ type: 'execute' }, policy)).toEqual({ allow: true });
  });

  it('supports multiple allowed roots', () => {
    const policy = { allowedPaths: [WORKDIR, '/shared/assets'] };
    expect(
      checkOperation({ type: 'read', path: '/shared/assets/logo.png' }, policy),
    ).toEqual({ allow: true });
    expect(
      checkOperation({ type: 'read', path: '/shared/secrets/key.pem' }, policy).allow,
    ).toBe(false);
  });
});

describe('createPolicy', () => {
  it('returns a policy with the given workdir as the only allowed root', () => {
    const policy = createPolicy('/my/workdir');
    expect(policy.allowedPaths).toHaveLength(1);
    expect(policy.allowedPaths[0]).toBe('/my/workdir');
  });
});
