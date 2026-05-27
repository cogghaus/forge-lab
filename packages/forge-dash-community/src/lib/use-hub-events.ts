'use client';

import { useEffect, useRef } from 'react';
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
 * The EventSource reconnects automatically on network interruptions (browser
 * built-in exponential back-off). The stream is closed when the component
 * unmounts or `workspaceId` changes.
 *
 * @example
 * ```tsx
 * // In a client component inside a workspace layout:
 * useHubEvents(workspaceId);
 * ```
 */
export function useHubEvents(workspaceId?: string): void {
  const router = useRouter();
  // Store router in a ref so the effect does not re-run when Next.js returns
  // a new router object reference across renders. The ref is always current
  // because it is updated synchronously on every render before the effect runs.
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    const url = workspaceId
      ? `/api/hub/events?workspaceId=${encodeURIComponent(workspaceId)}`
      : '/api/hub/events';

    const es = new EventSource(url);

    const refresh = (): void => {
      routerRef.current.refresh();
    };

    for (const name of TASK_EVENTS) {
      es.addEventListener(name, refresh);
    }

    es.onerror = (): void => {
      // EventSource auto-reconnects with exponential back-off (browser built-in).
      // Log at warn level so the failure is visible in browser DevTools console
      // without being an unhandled error.
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[useHubEvents] SSE connection error — browser will retry automatically');
      }
    };

    return (): void => {
      for (const name of TASK_EVENTS) {
        es.removeEventListener(name, refresh);
      }
      es.close();
    };
    // workspaceId is the only dep that should trigger reconnect.
    // routerRef is excluded intentionally — it is always current via the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
}
