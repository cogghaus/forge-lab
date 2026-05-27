'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
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
// Column definitions — matches mockup KANBAN_COLS
// ---------------------------------------------------------------------------

interface KanbanCol {
  key: string;
  label: string;
  fill: string;
  edge: string;
  text: string;
  statuses: string[];
}

const KANBAN_COLS: KanbanCol[] = [
  {
    key:      'pending',
    label:    'Pending',
    fill:     'rgba(255,255,255,0.1)',
    edge:     'rgba(255,255,255,0.45)',
    text:     'rgba(255,255,255,0.55)',
    statuses: ['pending_agent', 'pending_design'],
  },
  {
    key:      'active',
    label:    'Active',
    fill:     'rgba(255,107,43,0.22)',
    edge:     '#FF6B2B',
    text:     '#FF6B2B',
    statuses: ['assigned', 'in_progress'],
  },
  {
    key:      'review',
    label:    'Review',
    fill:     'rgba(255,181,71,0.2)',
    edge:     '#FFB547',
    text:     '#FFB547',
    statuses: ['design_review', 'pending_dispatcher_action'],
  },
  {
    key:      'complete',
    label:    'Complete',
    fill:     'rgba(45,212,160,0.15)',
    edge:     '#2DD4A0',
    text:     '#2DD4A0',
    statuses: ['completed'],
  },
];

// Grid template — goal name | # | pending | active | review | complete
const GRID = '1fr 36px repeat(4, minmax(72px, 1fr))';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COL_HEADER_BASE: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 9,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'rgba(245,240,235,0.28)',
};

function colHeaderStyle(extra: React.CSSProperties): React.CSSProperties {
  return { ...COL_HEADER_BASE, ...extra };
}

function countByCol(tasks: HubTask[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const col of KANBAN_COLS) {
    counts[col.key] = tasks.filter((t) => col.statuses.includes(t.status)).length;
  }
  return counts;
}

function completionPct(tasks: HubTask[]): number {
  if (tasks.length === 0) return 0;
  const done = tasks.filter((t) => t.status === 'completed').length;
  return Math.round((done / tasks.length) * 100);
}

function hasActiveTasks(tasks: HubTask[]): boolean {
  return tasks.some(
    (t) => t.status === 'in_progress' || t.status === 'assigned' || t.status === 'pending_agent',
  );
}

// ---------------------------------------------------------------------------
// GoalRow — one data row in the columnar grid
// ---------------------------------------------------------------------------

interface GoalRowProps {
  goal: HubGoal | null; // null = Ungrouped
  tasks: HubTask[];
  workspaceId: string;
  isLast: boolean;
}

function GoalRow({ goal, tasks, workspaceId, isLast }: GoalRowProps) {
  const counts = countByCol(tasks);
  const pct = completionPct(tasks);
  const allDone = tasks.length > 0 && counts['complete'] === tasks.length;
  const isUngrouped = goal === null;
  const dim = allDone ? { opacity: 0.45 } : undefined;

  return (
    <Link
      href={isUngrouped ? `/workspaces/${workspaceId}/tasks` : `/workspaces/${workspaceId}/tasks?goalId=${goal.id}`}
      className="group transition-colors hover:bg-white/[0.025]"
      style={{
        display: 'grid',
        gridTemplateColumns: GRID,
        borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.04)',
        ...dim,
      }}
    >
      {/* Goal name + mini progress bar */}
      <div
        className="flex flex-col justify-center gap-1 min-w-0"
        style={{ padding: '7px 12px' }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="flex-shrink-0 text-[12px]">
            {isUngrouped ? '◌' : allDone ? '✓' : '🎯'}
          </span>
          <span
            className="text-[12px] font-semibold truncate"
            style={{ color: allDone || isUngrouped ? 'rgba(245,240,235,0.4)' : 'var(--foreground)' }}
          >
            {isUngrouped ? 'Ungrouped' : goal.title}
          </span>
        </div>
        {/* 2px progress bar */}
        <div
          className="rounded-sm overflow-hidden"
          style={{ height: 2, background: 'rgba(255,255,255,0.06)' }}
        >
          <div
            className="h-full rounded-sm"
            style={{
              width: `${pct}%`,
              background: allDone ? '#2DD4A0' : '#FF6B2B',
            }}
          />
        </div>
      </div>

      {/* Total task count */}
      <div
        className="flex items-center justify-center"
        style={{ borderLeft: '1px solid rgba(255,255,255,0.05)' }}
      >
        <span
          className="font-mono text-[10px]"
          style={{ color: 'rgba(245,240,235,0.4)' }}
        >
          {tasks.length}
        </span>
      </div>

      {/* Status columns */}
      {KANBAN_COLS.map((col) => {
        const count = counts[col.key] ?? 0;
        return (
          <div
            key={col.key}
            className="flex items-center gap-1.5 min-w-0"
            style={{ padding: '7px 8px', borderLeft: '1px solid rgba(255,255,255,0.05)' }}
          >
            {count > 0 && (
              <>
                <span
                  className="font-mono text-[10px] font-bold flex-shrink-0"
                  style={{ color: col.text, minWidth: 12 }}
                >
                  {count}
                </span>
                {/* Mini task-block bars */}
                <div className="flex gap-[3px] flex-1 min-w-0" style={{ height: 10 }}>
                  {Array.from({ length: count }).map((_, i) => (
                    <div
                      key={i}
                      className="flex-1 rounded-[1px]"
                      style={{
                        background: col.fill,
                        borderTop: `1.5px solid ${col.edge}`,
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// GoalKanban
// ---------------------------------------------------------------------------

/**
 * Columnar kanban grid matching the forge-dashboard mockup.
 *
 * Columns: Goal (title + progress bar) | # | Pending | Active | Review | Complete
 *
 * Each goal row shows per-column task counts and mini stacked block bars.
 * Tasks not linked to any goal appear in an "Ungrouped" row at the bottom.
 * Active tasks trigger a 5-second polling refresh.
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
  const doneGoals   = goals.filter((g) => g.status === 'completed' || g.status === 'cancelled');
  const ungroupedTasks = tasksByGoal.get(null) ?? [];

  const visibleGoals = showCompleted ? [...activeGoals, ...doneGoals] : activeGoals;

  const hasRows = visibleGoals.length > 0 || ungroupedTasks.length > 0;
  const totalRows = visibleGoals.length + (ungroupedTasks.length > 0 ? 1 : 0);

  return (
    <div
      className="rounded-[10px] overflow-hidden border"
      style={{ background: '#1A1A1F', borderColor: 'rgba(255,255,255,0.06)' }}
    >
      {/* ── Header row ── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: GRID,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.01)',
        }}
      >
        <div style={colHeaderStyle({ padding: '6px 12px' })}>Goal</div>
        <div style={colHeaderStyle({ borderLeft: '1px solid rgba(255,255,255,0.05)', textAlign: 'center', padding: '6px 4px' })}>
          #
        </div>
        {KANBAN_COLS.map((col) => (
          <div
            key={col.key}
            style={colHeaderStyle({ padding: '6px 10px', borderLeft: '1px solid rgba(255,255,255,0.05)' })}
          >
            {col.label}
          </div>
        ))}
      </div>

      {/* ── Live indicator ── */}
      {isLive && (
        <div
          className="flex items-center gap-1.5 px-3 pt-1.5"
          style={{ color: 'rgba(245,240,235,0.4)' }}
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#FF6B2B] opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#FF6B2B]" />
          </span>
          <span className="font-mono text-[9px] uppercase tracking-widest">live</span>
        </div>
      )}

      {/* ── Goal rows ── */}
      <div style={{ maxHeight: 195, overflowY: 'auto' }}>
        {!hasRows && (
          <p
            className="px-3 py-5 text-sm text-center"
            style={{ color: 'rgba(245,240,235,0.35)' }}
          >
            No goals yet. Create a goal to start tracking progress.
          </p>
        )}

        {visibleGoals.map((goal, i) => {
          const isLast = i === totalRows - 1 && ungroupedTasks.length === 0;
          return (
            <GoalRow
              key={goal.id}
              goal={goal}
              tasks={tasksByGoal.get(goal.id) ?? []}
              workspaceId={workspaceId}
              isLast={isLast}
            />
          );
        })}

        {ungroupedTasks.length > 0 && (
          <GoalRow
            key="ungrouped"
            goal={null}
            tasks={ungroupedTasks}
            workspaceId={workspaceId}
            isLast
          />
        )}
      </div>

      {/* ── Completed goals toggle footer ── */}
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
            {showCompleted ? '▾ Hide' : '▸ Show'}{' '}
            {doneGoals.length} completed goal{doneGoals.length !== 1 ? 's' : ''}
          </button>
        </div>
      )}
    </div>
  );
}
