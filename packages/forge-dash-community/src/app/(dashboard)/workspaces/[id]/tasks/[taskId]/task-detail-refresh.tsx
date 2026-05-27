'use client';

import { useHubEvents } from '@/lib/use-hub-events';

interface Props {
  workspaceId: string;
}

/**
 * Invisible component mounted in the task detail page.
 * Subscribes to the hub SSE stream scoped to the task's workspace and triggers
 * a server-component refresh whenever a task lifecycle event arrives.
 */
export function TaskDetailRefresh({ workspaceId }: Props) {
  useHubEvents(workspaceId);
  return null;
}
