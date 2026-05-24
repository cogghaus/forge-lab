'use client';

import { Button } from '@heroui/react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateGoalStatusAction } from '@/actions/goals';

interface Props {
  workspaceId: string;
  goalId: string;
  currentStatus: 'active' | 'completed' | 'cancelled';
}

export function GoalStatusButton({ workspaceId, goalId, currentStatus }: Props) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  async function toggle() {
    setIsLoading(true);
    try {
      const next = currentStatus === 'active' ? 'completed' : 'active';
      await updateGoalStatusAction(workspaceId, goalId, next);
      router.refresh();
    } finally {
      setIsLoading(false);
    }
  }

  if (currentStatus === 'cancelled') return null;

  return (
    <Button
      size="sm"
      variant="flat"
      color={currentStatus === 'active' ? 'success' : 'default'}
      onPress={toggle}
      isLoading={isLoading}
    >
      {currentStatus === 'active' ? 'Complete' : 'Reopen'}
    </Button>
  );
}
