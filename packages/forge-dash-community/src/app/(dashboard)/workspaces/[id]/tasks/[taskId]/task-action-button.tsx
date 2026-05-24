'use client';

import { useState } from 'react';
import { Button } from '@heroui/react';
import { updateTaskStatusAction } from '@/actions/tasks';

interface Props {
  workspaceId: string;
  taskId: string;
  action: 'cancel' | 'retry';
}

export function TaskActionButton({ workspaceId, taskId, action }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    const status = action === 'cancel' ? 'cancelled' : 'pending_agent';
    const result = await updateTaskStatusAction(workspaceId, taskId, status);
    if (result.error) {
      setError(result.error);
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        color={action === 'cancel' ? 'danger' : 'primary'}
        variant="flat"
        isLoading={loading}
        onPress={handleClick}
      >
        {action === 'cancel' ? 'Cancel task' : 'Retry task'}
      </Button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
