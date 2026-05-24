export function derivePrefix(slug: string): string {
  const parts = slug.toLowerCase().replace(/[^a-z-]/g, '').split('-').filter(Boolean);
  if (parts.length >= 2) {
    return parts.map((p) => p[0] ?? '').join('').slice(0, 6).padEnd(2, 'x');
  }
  return (parts[0] ?? 'ws').slice(0, 6).padEnd(2, 'x');
}
