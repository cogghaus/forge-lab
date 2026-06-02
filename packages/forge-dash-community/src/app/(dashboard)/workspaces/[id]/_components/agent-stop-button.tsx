'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { cancelTaskAction } from '@/actions/tasks';

/** Stops the agent's current task (cancels it) from the agent detail rail. */
export function AgentStopButton({ workspaceId, taskId }: { workspaceId: string; taskId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function stop() {
    setBusy(true);
    setError(null);
    const res = await cancelTaskAction(workspaceId, taskId, 'Stopped from agent panel');
    setBusy(false);
    if (res.error) setError(res.error);
    else router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => { void stop(); }}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-md border border-[#FF4757]/40 px-3 py-1.5 font-mono text-[11px] text-[#FF4757] transition-colors hover:bg-[#FF4757]/10 disabled:opacity-50"
      >
        {busy ? (
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent" />
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3" aria-hidden>
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
        )}
        Stop
      </button>
      {error && <span className="font-mono text-[10px] text-[#FF4757]">{error}</span>}
    </div>
  );
}
