'use client';

import { Card, CardBody, Chip } from '@heroui/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { HubTask } from '@/lib/hub';

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

export function TaskList({ tasks, workspaceId }: { tasks: HubTask[]; workspaceId: string }) {
  const router = useRouter();

  useEffect(() => {
    const hasActive = tasks.some(
      (t) => t.status === 'pending_agent' || t.status === 'assigned' || t.status === 'in_progress',
    );
    if (!hasActive) return;
    const id = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(id);
  }, [tasks, router]);

  if (tasks.length === 0) {
    return (
      <Card>
        <CardBody className="py-12 text-center text-default-500">
          No tasks yet. Create one to get started.
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => (
        <Link key={task.id} href={`/workspaces/${workspaceId}/tasks/${task.id}`}>
        <Card isPressable className="w-full">
          <CardBody className="flex flex-row items-center gap-4 py-3">
            <span className="font-mono text-xs text-default-400 w-16 shrink-0">{task.id}</span>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{task.title}</p>
              {task.description && (
                <p className="text-xs text-default-500 truncate">{task.description}</p>
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
        </Card>
        </Link>
      ))}
    </div>
  );
}
