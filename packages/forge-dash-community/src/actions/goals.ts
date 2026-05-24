'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { hubFetch } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

export async function createGoalAction(
  workspaceId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const title = (formData.get('title') as string | null)?.trim();
  const description = (formData.get('description') as string | null)?.trim() || null;
  const parentId = (formData.get('parentId') as string | null)?.trim() || undefined;
  if (!title) return { error: 'Title is required.' };

  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ id?: string; error?: string }>(
    `/workspaces/${workspaceId}/goals`,
    {
      method: 'POST',
      body: { title, description, parentId },
      cookie: `${SESSION_COOKIE}=${session}`,
    },
  );

  if (!res.ok) return { error: 'Failed to create goal.' };

  revalidatePath(`/workspaces/${workspaceId}/goals`);
  redirect(`/workspaces/${workspaceId}/goals`);
}

export async function updateGoalStatusAction(
  workspaceId: string,
  goalId: string,
  status: 'active' | 'completed' | 'cancelled',
): Promise<{ error?: string }> {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ ok?: boolean; error?: string }>(
    `/workspaces/${workspaceId}/goals/${goalId}`,
    {
      method: 'PATCH',
      body: { status },
      cookie: `${SESSION_COOKIE}=${session}`,
    },
  );

  if (!res.ok) return { error: 'Failed to update goal.' };

  revalidatePath(`/workspaces/${workspaceId}/goals`);
  return {};
}
