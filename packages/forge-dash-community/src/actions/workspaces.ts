'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { hubFetch } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { slugify } from '@/lib/slug';

export async function createWorkspaceAction(
  formData: FormData,
): Promise<{ error?: string; id?: string }> {
  const name = (formData.get('name') as string | null)?.trim();
  // Slug defaults to a slugified name when left blank.
  const slug = (formData.get('slug') as string | null)?.trim() || (name ? slugify(name) : '');
  const description = (formData.get('description') as string | null)?.trim() || undefined;
  const repoUrl = (formData.get('repoUrl') as string | null)?.trim() || undefined;
  const repoBranch = (formData.get('repoBranch') as string | null)?.trim() || undefined;
  if (!name) return { error: 'Name is required.' };
  if (!slug) return { error: 'Could not derive a slug — add one manually.' };
  if (repoBranch && !repoUrl) return { error: 'Repo branch needs a repo URL.' };

  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ id?: string; error?: string }>('/workspaces', {
    method: 'POST',
    body: {
      name,
      slug,
      description,
      ...(repoUrl ? { repoUrl } : {}),
      ...(repoBranch ? { repoBranch } : {}),
    },
    cookie: `${SESSION_COOKIE}=${session}`,
  });

  if (!res.ok) {
    const err = (res.data as { error?: string }).error;
    if (err === 'slug_taken') return { error: 'That slug is already taken.' };
    // Zod validation failures surface as a 400 with no friendly error code.
    // Don't presume which field — a repo URL (if any) must be https, the slug
    // must be lowercase alphanumeric/hyphens, the branch a valid git name.
    if (res.status === 400) return { error: 'Invalid input — check the slug, branch, and repo URL (https only).' };
    return { error: 'Failed to create workspace.' };
  }

  revalidatePath('/workspaces');
  // Guard against an empty/non-JSON 200 body (res.data null) — the client falls
  // back to a refresh when no id is returned.
  return { id: res.data?.id };
}
