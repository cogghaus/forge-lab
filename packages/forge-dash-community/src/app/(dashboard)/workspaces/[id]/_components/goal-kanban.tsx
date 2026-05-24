'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Chip } from '@heroui/react';
import type { HubGoal, HubTask } from '@/lib/hub';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoalKanbanProps {
  goals: HubGoal[];
  tasks: HubTask[];
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// Color constants
// ---------------------------------------------------------------------------

const GOAL_STATUS_COLOR = {
  active:    'primary',
  completed: 'success',
  cancelled: 'danger',
} as const satisfies Record<HubGoal['status'], 'primary' | 'success' | 'danger'>;

// ---------------------------------------------------------------------------
// Bucket ordering for the segmented bar
// ---------------------------------------------------------------------------

interface Bucket {
  label: string;
  color: string;
  statuses: string[];
}

const BUCKETS: Bucket[] = [
  { label: 'queued',  color: '#4A9EFF', statuses: ['pending_agent', 'pending_design'] },
  { label: 'active',  color: '#FF6B2B', statuses: ['assigned', 'in_progress'] },
  { label: 'waiting', color: '#FFB547', statuses: ['design_review', 'pending_dispatcher_action'] },
  { label: 'done',    color: '#2DD4A0', statuses: ['completed'] },
  { label: 'dead',    color: '#FF4757', statuses: ['failed', 'cancelled'] },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeSegments(tasks: HubTask[]): Array<{ label: string; color: string; count: number }> {
  return BUCKETS
    .map((bucket) => {
      const count = bucket.statuses.reduce(
        (acc, s) => acc + tasks.filter((t) => t.status === s).length,
        0,
      );
      return { label: bucket.label, color: bucket.color, count };
    })
    .filter((seg) => seg.count > 0);
}

function hasActiveTasks(tasks: HubTask[]): boolean {
  return tasks.some(
    (t) => t.status === 'in_progress' || t.status === 'assigned' || t.status === 'pending_agent',
  );
}

// ---------------------------------------------------------------------------
// GoalRow
// ---------------------------------------------------------------------------

interface GoalRowProps {
  goal: HubGoal | null; // null = Ungrouped
  tasks: HubTask[];
  workspaceId: string;
}

function GoalRow({ goal, tasks, workspaceId }: GoalRowProps) {
  const segments = computeSegments(tasks);
  const count = tasks.length;
  const isUngrouped = goal === null;

  return (
    <Link
      href={isUngrouped ? '#' : `/workspaces/${workspaceId}/goals`}
      onClick={isUngrouped ? (e) => e.preventDefault() : undefined}
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors hover:bg-white/[0.04]"
    >
      {/* Count badge */}
      <span
        className="font-mono text-[11px] w-8 text-center flex-shrink-0 rounded"
        style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(245,240,235,0.5)' }}
      >
        {count}
      </span>

      {/* Goal title */}
      <span
        className="text-sm font-medium truncate flex-shrink min-w-0 w-40"
        style={isUngrouped ? { color: 'rgba(245,240,235,0.35)' } : undefined}
      >
        {isUngrouped ? 'Ungrouped' : goal.title}
      </span>

      {/* Segmented progress bar */}
      <div className="flex gap-[3px] h-2 flex-1 min-w-0 rounded overflow-hidden">
        {count === 0 ? (
          <div className="flex-1 rounded" style={{ background: 'rgba(255,255,255,0.06)' }} />
        ) : (
          segments.map((seg) => (
            <div
              key={seg.label}
              style={{ flex: seg.count, minWidth: 4, background: seg.color }}
            />
          ))
        )}
      </div>

      {/* Goal status chip */}
      {!isUngrouped && goal && (
        <Chip
          size="sm"
          variant="flat"
          color={GOAL_STATUS_COLOR[goal.status]}
          className="flex-shrink-0"
        >
          {goal.status}
        </Chip>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// GoalKanban
// ---------------------------------------------------------------------------

/**
 * Client component rendering a goal-based kanban view.
 *
 * Each goal is shown as a row with a count badge, title, segmented progress
 * bar (by task-status bucket), and a goal-status chip. Tasks not linked to
 * any goal appear in an "Ungrouped" row at the bottom.
 *
 * When active tasks are present the component polls via router.refresh() every
 * 5 seconds and shows a live indicator. The composed prompt for each agent
 * session is constructed by the daemon and may contain sensitive project-context
 * content — this component never handles that data.
 */
export function GoalKanban({ goals, tasks, workspaceId }: GoalKanbanProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [isLive, setIsLive] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  // Live refresh when active tasks exist
  useEffect(() => {
    const live = hasActiveTasks(tasks);
    setIsLive(live);
    if (!live) return;
    const id = setInterval(() => startTransition(() => router.refresh()), 5000);
    return () => clearInterval(id);
  }, [tasks, router]);

  // Build goalId -> tasks map
  const goalIdSet = new Set(goals.map((g) => g.id));
  const tasksByGoal = new Map<string | null, HubTask[]>();

  for (const task of tasks) {
    const key = task.goalId !== null && goalIdSet.has(task.goalId) ? task.goalId : null;
    const bucket = tasksByGoal.get(key) ?? [];
    bucket.push(task);
    tasksByGoal.set(key, bucket);
  }

  // Separate active vs completed/cancelled goals
  const activeGoals = goals.filter((g) => g.status !== 'completed' && g.status !== 'cancelled');
  const doneGoals = goals.filter((g) => g.status === 'completed' || g.status === 'cancelled');
  const ungroupedTasks = tasksByGoal.get(null) ?? [];

  const visibleGoals = showCompleted ? [...activeGoals, ...doneGoals] : activeGoals;

  return (
    <div
      className="rounded-xl overflow-hidden border"
      style={{ background: '#1A1A1F', borderColor: 'rgba(255,255,255,0.06)' }}
    >
      {/* Live indicator */}
      {isLive && (
        <div
          className="flex items-center gap-1.5 px-3 pt-2 pb-1"
          style={{ color: 'rgba(245,240,235,0.4)' }}
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#FF6B2B] opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#FF6B2B]" />
          </span>
          <span className="font-mono text-[11px] uppercase tracking-wider">live</span>
        </div>
      )}

      {/* Goal rows */}
      <div className="flex flex-col py-1">
        {visibleGoals.length === 0 && ungroupedTasks.length === 0 && (
          <p className="px-3 py-6 text-sm text-center" style={{ color: 'rgba(245,240,235,0.35)' }}>
            No goals yet. Create a goal to start tracking progress.
          </p>
        )}

        {visibleGoals.map((goal) => (
          <GoalRow
            key={goal.id}
            goal={goal}
            tasks={tasksByGoal.get(goal.id) ?? []}
            workspaceId={workspaceId}
          />
        ))}

        {ungroupedTasks.length > 0 && (
          <GoalRow
            key="ungrouped"
            goal={null}
            tasks={ungroupedTasks}
            workspaceId={workspaceId}
          />
        )}
      </div>

      {/* Completed goals toggle footer */}
      {doneGoals.length > 0 && (
        <div
          className="border-t px-3 py-1.5"
          style={{ borderColor: 'rgba(255,255,255,0.04)' }}
        >
          <button
            type="button"
            onClick={() => setShowCompleted((v) => !v)}
            className="font-mono text-[9px] uppercase tracking-[0.08em] cursor-pointer bg-transparent border-none"
            style={{ color: 'rgba(245,240,235,0.3)' }}
          >
            {showCompleted
              ? `Hide completed goals`
              : `Show ${doneGoals.length} completed goal${doneGoals.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      )}
    </div>
  );
}
