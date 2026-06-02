'use client';

import { useState } from 'react';
import { cancelTaskAction, retryTaskAction, updateTaskStatusAction } from '@/actions/tasks';

interface Props {
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  action: 'cancel' | 'retry';
}

const baseBtn =
  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50';
const neutralBtn =
  `${baseBtn} border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`;
const dangerBtn =
  `${baseBtn} border-[#FF4757]/40 text-[#FF4757] hover:bg-[#FF4757]/10`;
const brandBtn =
  `${baseBtn} border-[#FF6B2B]/40 text-[#FF6B2B] hover:bg-[#FF6B2B]/10`;

function Spinner() {
  return <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent" />;
}

export function TaskActionButton({ workspaceId, taskId, taskTitle, taskStatus, action }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState('');

  async function handleRetry() {
    setLoading(true);
    setError(null);
    let result: { error?: string };
    if (taskStatus === 'failed') {
      result = await retryTaskAction(workspaceId, taskId);
    } else {
      result = await updateTaskStatusAction(workspaceId, taskId, 'pending_agent');
    }
    setLoading(false);
    if (result.error) setError(result.error);
  }

  async function handleCancelConfirm() {
    setLoading(true);
    setError(null);
    const result = await cancelTaskAction(workspaceId, taskId, reason.trim() || undefined);
    setLoading(false);
    if (result.error) {
      setError(result.error);
    } else {
      setExpanded(false);
      setReason('');
    }
  }

  if (action === 'retry') {
    return (
      <div className="flex flex-col items-end gap-1">
        <button type="button" className={brandBtn} disabled={loading} onClick={() => { void handleRetry(); }}>
          {loading && <Spinner />}
          {taskStatus === 'failed' ? 'Retry task' : 'Requeue task'}
        </button>
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  const isInProgress = taskStatus === 'in_progress';
  const confirmText = isInProgress
    ? `Cancel ${taskTitle}? The running agent will be signalled to stop at its next checkpoint.`
    : `Cancel ${taskTitle}?`;

  return (
    <div className="flex flex-col items-end gap-1">
      {!expanded ? (
        <button type="button" className={dangerBtn} onClick={() => setExpanded(true)}>
          Cancel task
        </button>
      ) : (
        <div className="flex w-64 flex-col items-end gap-2 rounded-xl border border-[#FF4757]/20 bg-[#FF4757]/5 p-3">
          <p className="w-full text-xs text-zinc-500 dark:text-zinc-400">{confirmText}</p>
          <textarea
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            disabled={loading}
            rows={2}
            className="w-full resize-y rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-[#FF6B2B] focus:ring-1 focus:ring-[#FF6B2B]/40 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
          <div className="flex gap-2">
            <button
              type="button"
              className={neutralBtn}
              disabled={loading}
              onClick={() => { setExpanded(false); setReason(''); setError(null); }}
            >
              Back
            </button>
            <button type="button" className={dangerBtn} disabled={loading} onClick={() => { void handleCancelConfirm(); }}>
              {loading && <Spinner />}
              Confirm cancel
            </button>
          </div>
          {error && <p className="w-full text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
      {!expanded && error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
