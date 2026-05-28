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
  const goalId = (formData.get('goalId') as string | null)?.trim() || null;
  const priority = (formData.get('priority') as string | null)?.trim() || undefined;
  if (!title || !projectPrefix) return { error: 'Title and project prefix are required.' };

  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ id?: string; error?: string }>(
    `/workspaces/${workspaceId}/tasks`,
    {
      method: 'POST',
      body: { title, projectPrefix, description, goalId, priority },
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
    if (errMsg === 'invalid_transition') return { error: 'That status change is not allowed.' };
    if (errMsg === 'status_changed') return { error: 'Task status changed — refresh and try again.' };
    return { error: 'Failed to update task.' };
  }

  revalidatePath(`/workspaces/${workspaceId}/tasks/${taskId}`);
  revalidatePath(`/workspaces/${workspaceId}`);
  return {};
}

export async function cancelTaskAction(
  workspaceId: string,
  taskId: string,
  reason?: string,
): Promise<{ error?: string }> {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ id?: string; error?: string }>(
    `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
    {
      method: 'POST',
      body: reason ? { reason } : undefined,
      cookie: `${SESSION_COOKIE}=${session}`,
    },
  );

  if (!res.ok) {
    const errMsg = (res.data as { error?: string } | null)?.error;
    if (errMsg === 'already_terminal') return { error: 'Task is already in a terminal state.' };
    if (errMsg === 'status_changed') return { error: 'Task status changed. Refresh and try again.' };
    if (errMsg === 'invalid_transition') return { error: 'This task cannot be cancelled in its current state.' };
    return { error: 'Failed to cancel task.' };
  }

  revalidatePath(`/workspaces/${workspaceId}/tasks/${taskId}`);
  revalidatePath(`/workspaces/${workspaceId}`);
  return {};
}

export async function retryTaskAction(
  workspaceId: string,
  taskId: string,
  priority?: string,
): Promise<{ error?: string }> {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ id?: string; error?: string }>(
    `/workspaces/${workspaceId}/tasks/${taskId}/retry`,
    {
      method: 'POST',
      body: priority ? { priority } : undefined,
      cookie: `${SESSION_COOKIE}=${session}`,
    },
  );

  if (!res.ok) {
    const errMsg = (res.data as { error?: string } | null)?.error;
    if (errMsg === 'not_failed') return { error: 'Task is not in a failed state.' };
    if (errMsg === 'status_changed') return { error: 'Task status changed. Refresh and try again.' };
    return { error: 'Failed to retry task.' };
  }

  revalidatePath(`/workspaces/${workspaceId}/tasks/${taskId}`);
  revalidatePath(`/workspaces/${workspaceId}`);
  return {};
}

export async function reassignTaskAction(
  workspaceId: string,
  taskId: string,
  agentId: string | null,
): Promise<{ error?: string }> {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ ok?: boolean; error?: string }>(
    `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
    {
      method: 'PATCH',
      body: { agentId },
      cookie: `${SESSION_COOKIE}=${session}`,
    },
  );

  if (!res.ok) {
    const errMsg = (res.data as { error?: string } | null)?.error;
    if (errMsg === 'not_assignable') return { error: 'Task cannot be reassigned in its current state.' };
    return { error: 'Failed to reassign task.' };
  }

  revalidatePath(`/workspaces/${workspaceId}/tasks/${taskId}`);
  revalidatePath(`/workspaces/${workspaceId}`);
  return {};
}
