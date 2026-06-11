'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { HubGoal, HubTask } from '@/lib/hub';
import { useHubEvents } from '@/lib/use-hub-events';

// Explicit hex per status — one shared color language with the kanban + activity stream.
const STATUS_META: Record<string, { color: string; label?: string }> = {
  pending_agent: { color: '#a1a1aa' },
  pending_design: { color: '#a1a1aa' },
  design_review: { color: '#FFB547' },
  pending_dispatcher_action: { color: '#FFB547' },
  assigned: { color: '#FF6B2B' },
  in_progress: { color: '#FF6B2B' },
  sequenced_running: { color: '#FF6B2B', label: 'Sequenced Running' },
  sequenced_complete: { color: '#2DD4A0', label: 'Sequenced Complete' },
  waiting_on_deps: { color: '#f59e0b', label: 'Waiting on Deps' },
  completed: { color: '#2DD4A0' },
  failed: { color: '#FF4757' },
  cancelled: { color: '#FF4757' },
};

const PRIORITY_META: Record<string, { color: string }> = {
  high: { color: '#FFB547' },
  urgent: { color: '#FF4757' },
};

function statusColor(s: string): string {
  return STATUS_META[s]?.color ?? '#a1a1aa';
}

function statusLabel(s: string): string {
  return STATUS_META[s]?.label ?? s.replace(/_/g, ' ');
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 font-mono text-[10px] capitalize"
      style={{ color, background: `${color}1f` }}
    >
      {label}
    </span>
  );
}

interface Props {
  tasks: HubTask[];
  workspaceId: string;
  goals?: HubGoal[];
  /**
   * When provided, clicking a task card calls this handler instead of
   * navigating to the task detail page. Used by TaskListWithPanel to open
   * the agent output sidepanel.
   */
  onTaskClick?: (task: HubTask) => void;
}

export function TaskList({ tasks, workspaceId, goals = [], onTaskClick }: Props) {
  const [isLive, setIsLive] = useState(false);

  const goalMap = new Map(goals.map((g) => [g.id, g.title]));

  useEffect(() => {
    setIsLive(
      tasks.some(
        (t) =>
          t.status === 'pending_agent' ||
          t.status === 'assigned' ||
          t.status === 'in_progress' ||
          t.status === 'sequenced_running',
      ),
    );
  }, [tasks]);

  // SSE-driven refresh — replaces the old polling interval.
  useHubEvents(workspaceId);

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-zinc-300 px-6 py-14 text-center dark:border-zinc-700/80">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#FF6B2B]/10 text-[#FF6B2B]">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden>
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        </span>
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">No tasks yet</h3>
          <p className="mx-auto max-w-xs text-sm text-zinc-500 dark:text-zinc-400">
            Use the New Task button above to create one. Forge Master triages it and routes it to an agent.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {isLive && (
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FF6B2B] opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#FF6B2B]" />
          </span>
          live
        </div>
      )}
      {tasks.map((task) => {
        const accent = statusColor(task.status);
        const inner = (
          <div className="flex flex-row items-center gap-4">
            <span className="w-16 shrink-0 font-mono text-xs text-zinc-400 dark:text-zinc-500">{task.id}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{task.title}</p>
              {task.description && (
                <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{task.description}</p>
              )}
              {task.goalId && goalMap.has(task.goalId) && (
                <p className="mt-0.5 truncate text-xs text-[#FF6B2B]">{goalMap.get(task.goalId)}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {PRIORITY_META[task.priority] && (
                <Pill label={task.priority} color={PRIORITY_META[task.priority]!.color} />
              )}
              <Pill label={statusLabel(task.status)} color={accent} />
            </div>
          </div>
        );

        const cardClass =
          'group relative flex w-full flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white px-4 py-3 text-left transition-all duration-150 hover:border-[#FF6B2B]/50 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900/70';
        const rail = (
          <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: accent }} aria-hidden />
        );

        return onTaskClick ? (
          <button key={task.id} type="button" onClick={() => onTaskClick(task)} className={`${cardClass} pl-5`}>
            {rail}
            {inner}
          </button>
        ) : (
          <Link
            key={task.id}
            href={`/workspaces/${workspaceId}/tasks/${task.id}`}
            className={`${cardClass} pl-5`}
          >
            {rail}
            {inner}
          </Link>
        );
      })}
    </div>
  );
}
