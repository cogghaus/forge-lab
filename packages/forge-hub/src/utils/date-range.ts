/**
 * Shared date-range parsing and validation for analytics endpoints.
 * Used by both /agents/performance and /workspaces/:id/analytics/overview.
 */

export interface DateRangeOk {
  ok: true;
  /** Epoch ms for start of range, or undefined if no range requested. */
  fromMs: number | undefined;
  /** Epoch ms for end of range, or undefined if no range requested. */
  toMs: number | undefined;
  /** Echoed-back from string (resolved to now ISO string when from given but to omitted). */
  fromStr: string | undefined;
  toStr: string | undefined;
}
export interface DateRangeErr {
  ok: false;
  error: string;
}

export type DateRangeResult = DateRangeOk | DateRangeErr;

const MAX_RANGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Parse and validate optional from/to query params.
 *
 * Rules:
 * - If both absent: ok, fromMs/toMs undefined (caller uses its own default range)
 * - If from present but to absent: to defaults to now
 * - from must be strictly before to
 * - Range must not exceed 365 days
 * - Both must be valid ISO 8601 strings (parseable by `new Date()`)
 */
export function parseDateRange(
  fromParam: unknown,
  toParam: unknown,
): DateRangeResult {
  if (fromParam === undefined && toParam === undefined) {
    return { ok: true, fromMs: undefined, toMs: undefined, fromStr: undefined, toStr: undefined };
  }

  let fromMs: number | undefined;
  let toMs: number | undefined;
  let toStr: string | undefined;

  if (fromParam !== undefined) {
    if (typeof fromParam !== 'string') {
      return { ok: false, error: 'invalid_date_range' };
    }
    fromMs = new Date(fromParam).getTime();
    if (isNaN(fromMs)) return { ok: false, error: 'invalid_date_range' };
  }

  if (toParam !== undefined) {
    if (typeof toParam !== 'string') {
      return { ok: false, error: 'invalid_date_range' };
    }
    toMs = new Date(toParam).getTime();
    if (isNaN(toMs)) return { ok: false, error: 'invalid_date_range' };
    toStr = toParam;
  } else if (fromMs !== undefined) {
    // Default to to = now
    toMs = Date.now();
    toStr = new Date(toMs).toISOString();
  }

  if (fromMs !== undefined && toMs !== undefined) {
    if (fromMs >= toMs) return { ok: false, error: 'invalid_date_range' };
    if (toMs - fromMs > MAX_RANGE_MS) return { ok: false, error: 'invalid_date_range' };
  }

  return {
    ok: true,
    fromMs,
    toMs,
    fromStr: fromMs !== undefined ? (fromParam as string) : undefined,
    toStr,
  };
}
