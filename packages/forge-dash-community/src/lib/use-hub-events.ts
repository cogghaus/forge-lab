'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Task lifecycle event names emitted by the hub. */
const TASK_EVENTS = [
  'task.created',
  'task.assigned',
  'task.claimed',
  'task.completed',
  'task.failed',
  'task.requeued',
] as const;

/**
 * Subscribes to the hub SSE event stream and calls `router.refresh()` on
 * task lifecycle events so Next.js server components re-fetch fresh data.
 *
 * Pass `workspaceId` to scope the stream to a single workspace.
 * Omit it to receive events across all workspaces the user is a member of.
 *
 * The EventSource reconnects automatically on network interruptions.
 * The stream is closed when the component unmounts.
 *
 * @example
 * ```tsx
 * // In a client component inside a workspace layout:
 * useHubEvents(workspaceId);
 * ```
 */
export function useHubEvents(workspaceId?: string): void {
  const router = useRouter();

  useEffect(() => {
    const url = workspaceId
      ? `/api/hub/events?workspaceId=${encodeURIComponent(workspaceId)}`
      : '/api/hub/events';

    const es = new EventSource(url);

    const refresh = (): void => {
      router.refresh();
    };

    for (const name of TASK_EVENTS) {
      es.addEventListener(name, refresh);
    }

    // EventSource reconnects automatically; log errors for visibility only.
    es.onerror = (): void => {
      // Browser DevTools will show the reconnect attempts.
    };

    return (): void => {
      es.close();
    };
  }, [workspaceId, router]);
}
