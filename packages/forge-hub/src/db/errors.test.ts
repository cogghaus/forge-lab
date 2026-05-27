import { describe, it, expect } from 'vitest';
import { hasUniqueConstraint } from './errors.js';

/**
 * Regression tests for hasUniqueConstraint.
 *
 * drizzle-orm@0.45 introduced DrizzleQueryError, which wraps the original
 * libsql/SQLite error in .cause. Before this utility existed, routes
 * checked err.message directly and returned 500 instead of 409 after
 * the drizzle-orm bump.
 */
describe('hasUniqueConstraint', () => {
  it('returns true when the error message contains the UNIQUE constraint text', () => {
    const err = new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: workspaces.slug');
    expect(hasUniqueConstraint(err, 'workspaces.slug')).toBe(true);
  });

  it('returns true when the original error is wrapped in a DrizzleQueryError-style cause chain', () => {
    // Simulates drizzle-orm@0.45 DrizzleQueryError wrapping a LibsqlError
    const cause = new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: workspaces.slug');
    const wrapper = new Error('Failed query: insert into "workspaces" ...\nparams: ...');
    (wrapper as Error & { cause: unknown }).cause = cause;
    expect(hasUniqueConstraint(wrapper, 'workspaces.slug')).toBe(true);
  });

  it('returns false when the error does not mention UNIQUE constraint', () => {
    const err = new Error('some other database error');
    expect(hasUniqueConstraint(err, 'workspaces.slug')).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(hasUniqueConstraint(null)).toBe(false);
    expect(hasUniqueConstraint(undefined)).toBe(false);
    expect(hasUniqueConstraint('string error')).toBe(false);
    expect(hasUniqueConstraint(42)).toBe(false);
  });

  it('matches any UNIQUE constraint when no column is specified', () => {
    const err = new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: docs.key');
    expect(hasUniqueConstraint(err)).toBe(true);
  });

  it('returns false when a different column is specified', () => {
    const err = new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: workspaces.slug');
    expect(hasUniqueConstraint(err, 'docs.key')).toBe(false);
  });
});
