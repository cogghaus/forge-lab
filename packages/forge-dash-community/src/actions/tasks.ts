'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { hubFetch } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

export async function createTaskAction(
  workspaceId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const title = (formData.get('title') as string | null)?.trim();
  const projectPrefix = (formData.get('projectPrefix') as string | null)?.trim();
  const description = (formData.get('description') as string | null)?.trim() || null;
  if (!title || !projectPrefix) return { error: 'Title and project prefix are required.' };

  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ id?: string; error?: string }>(
    `/workspaces/${workspaceId}/tasks`,
    {
      method: 'POST',
      body: { title, projectPrefix, description },
      cookie: `${SESSION_COOKIE}=${session}`,
    },
  );

  if (!res.ok) return { error: 'Failed to create task.' };

  revalidatePath(`/workspaces/${workspaceId}`);
  redirect(`/workspaces/${workspaceId}`);
}

export async function updateTaskStatusAction(
  workspaceId: string,
  taskId: string,
  status: 'cancelled' | 'pending_agent',
): Promise<{ error?: string }> {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ ok?: boolean; error?: string }>(
    `/workspaces/${workspaceId}/tasks/${taskId}`,
    {
      method: 'PATCH',
      body: { status },
      cookie: `${SESSION_COOKIE}=${session}`,
    },
  );

  if (!res.ok) {
    const errMsg = (res.data as { error?: string } | null)?.error;
    return { error: errMsg === 'invalid_transition' ? 'That status change is not allowed.' : 'Failed to update task.' };
  }

  revalidatePath(`/workspaces/${workspaceId}/tasks/${taskId}`);
  revalidatePath(`/workspaces/${workspaceId}`);
  return {};
}
