/**
 * Error detection utilities for database errors.
 *
 * drizzle-orm@0.45 introduced DrizzleQueryError, which wraps the original
 * libsql/SQLite error in .cause. Checking err.message alone is no longer
 * sufficient — we must traverse the full cause chain to find the underlying
 * database error.
 */

/**
 * Returns true if any error in the cause chain indicates a SQLite UNIQUE
 * constraint violation on the given column path (e.g. "workspaces.slug").
 * If no column is specified, any UNIQUE constraint failure matches.
 */
export function hasUniqueConstraint(err: unknown, column?: string): boolean {
  if (!(err instanceof Error)) return false;
  const needle = column ? `UNIQUE constraint failed: ${column}` : 'UNIQUE constraint failed';
  if (err.message.includes(needle)) return true;
  // drizzle-orm@0.45+ wraps the original error in .cause
  return hasUniqueConstraint((err as Error & { cause?: unknown }).cause, column);
}
