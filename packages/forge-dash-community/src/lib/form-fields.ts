export function normalizeOptional(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function resolveSelection(
  keys: 'all' | Iterable<string | number> | null | undefined,
  fallback: string,
): string {
  if (!keys || keys === 'all') return fallback;
  const first = [...keys][0];
  return first !== undefined ? String(first) : fallback;
}
