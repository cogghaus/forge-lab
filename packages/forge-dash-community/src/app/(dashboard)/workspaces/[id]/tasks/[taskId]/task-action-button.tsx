'use client';

import { useState } from 'react';
import { Button, Textarea } from '@heroui/react';
import { cancelTaskAction, retryTaskAction, updateTaskStatusAction } from '@/actions/tasks';

interface Props {
  workspaceId: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  action: 'cancel' | 'retry';
}

export function TaskActionButton({ workspaceId, taskId, taskTitle, taskStatus, action }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cancel-specific expand state
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState('');

  async function handleRetry() {
    setLoading(true);
    setError(null);
    let result: { error?: string };
    if (taskStatus === 'failed') {
      // Retry failed task → pending_dispatcher_action (FM re-triage)
      result = await retryTaskAction(workspaceId, taskId);
    } else {
      // Requeue cancelled task → pending_agent (skip FM triage)
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
        <Button
          size="sm"
          color="primary"
          variant="flat"
          isLoading={loading}
          onPress={handleRetry}
        >
          {taskStatus === 'failed' ? 'Retry task' : 'Requeue task'}
        </Button>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    );
  }

  // Cancel action: inline expand panel
  const isInProgress = taskStatus === 'in_progress';
  const confirmText = isInProgress
    ? `Cancel ${taskTitle}? The running agent will be signalled to stop at its next checkpoint.`
    : `Cancel ${taskTitle}?`;

  return (
    <div className="flex flex-col items-end gap-1">
      {!expanded ? (
        <Button
          size="sm"
          color="danger"
          variant="flat"
          onPress={() => setExpanded(true)}
        >
          Cancel task
        </Button>
      ) : (
        <div className="flex flex-col gap-2 items-end w-64 border border-danger/20 rounded-xl p-3 bg-danger/5">
          <p className="text-xs text-default-500 w-full">{confirmText}</p>
          <Textarea
            size="sm"
            placeholder="Reason (optional)"
            value={reason}
            onValueChange={setReason}
            maxLength={500}
            isDisabled={loading}
            minRows={2}
            className="w-full"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="flat"
              color="default"
              isDisabled={loading}
              onPress={() => { setExpanded(false); setReason(''); setError(null); }}
            >
              Back
            </Button>
            <Button
              size="sm"
              color="danger"
              variant="flat"
              isLoading={loading}
              onPress={handleCancelConfirm}
            >
              Confirm cancel
            </Button>
          </div>
          {error && <p className="text-xs text-danger w-full">{error}</p>}
        </div>
      )}
      {!expanded && error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
