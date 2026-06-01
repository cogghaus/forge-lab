'use client';

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

  const isActive = currentStatus === 'active';

  return (
    <button
      type="button"
      onClick={() => { void toggle(); }}
      disabled={isLoading}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
        isActive
          ? 'border-[#2DD4A0]/40 text-[#2DD4A0] hover:bg-[#2DD4A0]/10'
          : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'
      }`}
    >
      {isLoading && (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent" />
      )}
      {isActive ? 'Complete' : 'Reopen'}
    </button>
  );
}
