'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { hubFetch } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

export async function createWorkspaceAction(formData: FormData): Promise<{ error?: string }> {
  const name = (formData.get('name') as string | null)?.trim();
  const slug = (formData.get('slug') as string | null)?.trim();
  if (!name || !slug) return { error: 'Name and slug are required.' };

  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ id?: string; error?: string }>('/workspaces', {
    method: 'POST',
    body: { name, slug },
    cookie: `${SESSION_COOKIE}=${session}`,
  });

  if (!res.ok) {
    const err = (res.data as { error?: string }).error;
    return { error: err === 'slug_taken' ? 'That slug is already taken.' : 'Failed to create workspace.' };
  }

  revalidatePath('/workspaces');
  redirect('/workspaces');
}
