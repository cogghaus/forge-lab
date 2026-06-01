import { describe, it, expect } from 'vitest';
import {
  rankAtLeast,
  WorkspaceSlugSchema,
  CreateWorkspaceInputSchema,
  WorkspaceRoleSchema,
} from './workspace.js';

describe('rankAtLeast', () => {
  it('owner satisfies every role', () => {
    expect(rankAtLeast('owner', 'owner')).toBe(true);
    expect(rankAtLeast('owner', 'admin')).toBe(true);
    expect(rankAtLeast('owner', 'collaborator')).toBe(true);
    expect(rankAtLeast('owner', 'viewer')).toBe(true);
  });

  it('admin satisfies admin and below but not owner', () => {
    expect(rankAtLeast('admin', 'owner')).toBe(false);
    expect(rankAtLeast('admin', 'admin')).toBe(true);
    expect(rankAtLeast('admin', 'collaborator')).toBe(true);
    expect(rankAtLeast('admin', 'viewer')).toBe(true);
  });

  it('collaborator satisfies collaborator and viewer only', () => {
    expect(rankAtLeast('collaborator', 'owner')).toBe(false);
    expect(rankAtLeast('collaborator', 'admin')).toBe(false);
    expect(rankAtLeast('collaborator', 'collaborator')).toBe(true);
    expect(rankAtLeast('collaborator', 'viewer')).toBe(true);
  });

  it('viewer satisfies only viewer', () => {
    expect(rankAtLeast('viewer', 'owner')).toBe(false);
    expect(rankAtLeast('viewer', 'admin')).toBe(false);
    expect(rankAtLeast('viewer', 'collaborator')).toBe(false);
    expect(rankAtLeast('viewer', 'viewer')).toBe(true);
  });
});

describe('WorkspaceSlugSchema', () => {
  it('accepts valid slugs', () => {
    expect(() => WorkspaceSlugSchema.parse('a')).not.toThrow();
    expect(() => WorkspaceSlugSchema.parse('adam')).not.toThrow();
    expect(() => WorkspaceSlugSchema.parse('my-workspace')).not.toThrow();
    expect(() => WorkspaceSlugSchema.parse('forge-lab-2')).not.toThrow();
    expect(() => WorkspaceSlugSchema.parse('a'.repeat(50))).not.toThrow();
  });

  it('rejects leading hyphen', () => {
    expect(() => WorkspaceSlugSchema.parse('-adam')).toThrow();
  });

  it('rejects trailing hyphen', () => {
    expect(() => WorkspaceSlugSchema.parse('adam-')).toThrow();
  });

  it('rejects uppercase', () => {
    expect(() => WorkspaceSlugSchema.parse('Adam')).toThrow();
  });

  it('rejects spaces', () => {
    expect(() => WorkspaceSlugSchema.parse('my workspace')).toThrow();
  });

  it('rejects slug over 50 chars', () => {
    expect(() => WorkspaceSlugSchema.parse('a'.repeat(51))).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => WorkspaceSlugSchema.parse('')).toThrow();
  });
});

describe('CreateWorkspaceInputSchema', () => {
  it('accepts valid input', () => {
    expect(() =>
      CreateWorkspaceInputSchema.parse({ name: 'My Workspace', slug: 'my-workspace' }),
    ).not.toThrow();
  });

  it('accepts optional description', () => {
    expect(() =>
      CreateWorkspaceInputSchema.parse({
        name: 'My Workspace',
        slug: 'my-workspace',
        description: 'A description',
      }),
    ).not.toThrow();
  });

  it('rejects empty name', () => {
    expect(() =>
      CreateWorkspaceInputSchema.parse({ name: '', slug: 'my-workspace' }),
    ).toThrow();
  });

  it('rejects name over 100 chars', () => {
    expect(() =>
      CreateWorkspaceInputSchema.parse({ name: 'a'.repeat(101), slug: 'my-workspace' }),
    ).toThrow();
  });

  it('rejects description over 500 chars', () => {
    expect(() =>
      CreateWorkspaceInputSchema.parse({
        name: 'My Workspace',
        slug: 'my-workspace',
        description: 'a'.repeat(501),
      }),
    ).toThrow();
  });

  it('rejects invalid slug', () => {
    expect(() =>
      CreateWorkspaceInputSchema.parse({ name: 'My Workspace', slug: '-bad-slug' }),
    ).toThrow();
  });

  it('accepts an https repo binding', () => {
    expect(() =>
      CreateWorkspaceInputSchema.parse({
        name: 'HAL',
        slug: 'hal',
        repoUrl: 'https://github.com/sugar-crash-studios/hal.git',
        repoBranch: 'main',
      }),
    ).not.toThrow();
  });

  it('rejects a non-https repo URL', () => {
    expect(() =>
      CreateWorkspaceInputSchema.parse({
        name: 'HAL',
        slug: 'hal',
        repoUrl: 'git@github.com:sugar-crash-studios/hal.git',
      }),
    ).toThrow();
  });

  it('rejects a branch name with whitespace', () => {
    expect(() =>
      CreateWorkspaceInputSchema.parse({
        name: 'HAL',
        slug: 'hal',
        repoUrl: 'https://github.com/sugar-crash-studios/hal',
        repoBranch: 'bad branch',
      }),
    ).toThrow();
  });
});

describe('WorkspaceRoleSchema', () => {
  it('accepts all valid roles', () => {
    for (const role of ['owner', 'admin', 'collaborator', 'viewer'] as const) {
      expect(() => WorkspaceRoleSchema.parse(role)).not.toThrow();
    }
  });

  it('rejects unknown role', () => {
    expect(() => WorkspaceRoleSchema.parse('superadmin')).toThrow();
    expect(() => WorkspaceRoleSchema.parse('')).toThrow();
  });
});
