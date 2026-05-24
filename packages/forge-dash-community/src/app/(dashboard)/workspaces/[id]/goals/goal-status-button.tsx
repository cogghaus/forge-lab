'use client';

import { Button } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { updateGoalStatusAction } from '@/actions/goals';

interface Props {
  workspaceId: string;
  goalId: string;
  currentStatus: 'active' | 'completed' | 'cancelled';
}

export function GoalStatusButton({ workspaceId, goalId, currentStatus }: Props) {
  const router = useRouter();

  async function toggle() {
    const next = currentStatus === 'active' ? 'completed' : 'active';
    await updateGoalStatusAction(workspaceId, goalId, next);
    router.refresh();
  }

  if (currentStatus === 'cancelled') return null;

  return (
    <Button
      size="sm"
      variant="flat"
      color={currentStatus === 'active' ? 'success' : 'default'}
      onPress={toggle}
    >
      {currentStatus === 'active' ? 'Complete' : 'Reopen'}
    </Button>
  );
}
