/** Derive a URL-safe workspace slug from a name. Shared by the create action
 * (server fallback) and the dialog (live preview) so the two never diverge. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}
