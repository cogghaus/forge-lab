'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { hubFetch } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { slugify } from '@/lib/slug';

/** Which field an error attaches to, so the dialog can render it inline. */
export type WorkspaceErrorField = 'name' | 'slug' | 'repoUrl' | 'repoBranch' | 'form';

export interface CreateWorkspaceResult {
  error?: string;
  field?: WorkspaceErrorField;
  id?: string;
}

export async function createWorkspaceAction(
  formData: FormData,
): Promise<CreateWorkspaceResult> {
  const name = (formData.get('name') as string | null)?.trim();
  // Slug defaults to a slugified name when left blank.
  const slug = (formData.get('slug') as string | null)?.trim() || (name ? slugify(name) : '');
  const description = (formData.get('description') as string | null)?.trim() || undefined;
  const repoUrl = (formData.get('repoUrl') as string | null)?.trim() || undefined;
  const repoBranch = (formData.get('repoBranch') as string | null)?.trim() || undefined;
  if (!name) return { error: 'Name is required.', field: 'name' };
  if (!slug) return { error: 'Could not derive a slug — add one manually.', field: 'slug' };
  if (repoUrl && !/^https:\/\//i.test(repoUrl)) {
    return { error: 'Repo URL must be an https:// URL.', field: 'repoUrl' };
  }
  if (repoBranch && !repoUrl) return { error: 'Add a repo URL, or clear the branch.', field: 'repoUrl' };

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
    if (err === 'slug_taken') return { error: 'That slug is already taken.', field: 'slug' };
    // Zod validation failures surface as a 400 with no friendly error code.
    // Client-side validation catches repo/slug shape pre-submit, so a 400 here
    // is most likely the slug; attach it there.
    if (res.status === 400) {
      return { error: 'Invalid — use lowercase letters, numbers, and hyphens.', field: 'slug' };
    }
    return { error: 'Failed to create workspace.', field: 'form' };
  }

  revalidatePath('/workspaces');
  // Guard against an empty/non-JSON 200 body (res.data null) — the client falls
  // back to a refresh when no id is returned.
  return { id: res.data?.id };
}
