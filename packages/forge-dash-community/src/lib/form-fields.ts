export function normalizeOptional(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
