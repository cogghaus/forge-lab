'use client';

import { Card, CardBody, Chip } from '@heroui/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { HubGoal, HubTask } from '@/lib/hub';
import { useHubEvents } from '@/lib/use-hub-events';

const STATUS_COLOR: Record<string, 'default' | 'primary' | 'warning' | 'success' | 'danger'> = {
  pending_agent: 'default',
  pending_design: 'default',
  design_review: 'warning',
  assigned: 'primary',
  in_progress: 'primary',
  pending_dispatcher_action: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'danger',
};

const PRIORITY_COLOR: Record<string, 'default' | 'primary' | 'warning' | 'danger'> = {
  low: 'default',
  normal: 'default',
  high: 'warning',
  urgent: 'danger',
};

function statusLabel(s: string): string {
  return s.replace(/_/g, ' ');
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

  // Track whether any active tasks exist (drives the live indicator).
  useEffect(() => {
    const hasActive = tasks.some(
      (t) => t.status === 'pending_agent' || t.status === 'assigned' || t.status === 'in_progress',
    );
    setIsLive(hasActive);
  }, [tasks]);

  // SSE-driven refresh — replaces the 5 s polling interval.
  useHubEvents(workspaceId);

  if (tasks.length === 0) {
    return (
      <Card>
        <CardBody className="py-12 text-center text-default-500">
          No tasks in this workspace yet. Use the New Task button above to create your first.
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {isLive && (
        <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-white/40 mb-1">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#FF6B2B] opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#FF6B2B]" />
          </span>
          live
        </div>
      )}
      {tasks.map((task) => {
        const cardBody = (
          <CardBody className="flex flex-row items-center gap-4 py-3">
            <span className="font-mono text-xs text-default-400 w-16 shrink-0">{task.id}</span>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{task.title}</p>
              {task.description && (
                <p className="text-xs text-default-500 truncate">{task.description}</p>
              )}
              {task.goalId && goalMap.has(task.goalId) && (
                <p className="text-xs text-primary-400 truncate mt-0.5">
                  {goalMap.get(task.goalId)}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {task.priority !== 'normal' && (
                <Chip
                  size="sm"
                  variant="flat"
                  color={PRIORITY_COLOR[task.priority] ?? 'default'}
                >
                  {task.priority}
                </Chip>
              )}
              <Chip
                size="sm"
                variant="flat"
                color={STATUS_COLOR[task.status] ?? 'default'}
              >
                {statusLabel(task.status)}
              </Chip>
            </div>
          </CardBody>
        );

        // When onTaskClick is provided, use press handler (panel mode).
        // Otherwise, navigate to the task detail page (default link mode).
        return onTaskClick ? (
          <Card
            key={task.id}
            isPressable
            onPress={() => onTaskClick(task)}
            className="w-full"
          >
            {cardBody}
          </Card>
        ) : (
          <Card
            key={task.id}
            as={Link}
            href={`/workspaces/${workspaceId}/tasks/${task.id}`}
            isPressable
            className="w-full"
          >
            {cardBody}
          </Card>
        );
      })}
    </div>
  );
}
