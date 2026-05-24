import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardBody, Chip } from '@heroui/react';
import { hubFetch, type HubGoal, type HubTask, type HubTaskHistory, type HubWorkspace } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { TaskDetailRefresh } from './task-detail-refresh';
import { TaskActionButton } from './task-action-button';

interface Props {
  params: Promise<{ id: string; taskId: string }>;
}

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

function statusLabel(s: string) {
  return s.replace(/_/g, ' ');
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString();
}

function HistoryEvent({ event }: { event: HubTaskHistory }) {
  const payload = event.payload as Record<string, unknown> | null;
  const payloadKeys = payload ? Object.keys(payload).filter((k) => k !== 'runId') : [];

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="w-2 h-2 rounded-full bg-default-400 mt-1.5 shrink-0" />
        <div className="w-px flex-1 bg-default-200 mt-1" />
      </div>
      <div className="pb-4 flex-1">
        <p className="font-medium text-sm">{event.eventName}</p>
        <p className="text-xs text-default-500 mt-0.5">
          {event.source} &middot; {formatTs(event.createdAt)}
        </p>
        {payloadKeys.length > 0 && (
          <div className="mt-1 text-xs text-default-400 font-mono">
            {payloadKeys.map((k) => (
              <span key={k} className="mr-3">
                {k}: {String(payload![k])}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default async function TaskDetailPage({ params }: Props) {
  const { id: workspaceId, taskId } = await params;
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;

  const [wsRes, taskRes, historyRes] = await Promise.all([
    hubFetch<HubWorkspace>(`/workspaces/${workspaceId}`, { cookie: cookieHeader }),
    hubFetch<HubTask>(`/tasks/${taskId}`, { cookie: cookieHeader }),
    hubFetch<{ history: HubTaskHistory[] }>(`/tasks/${taskId}/history`, {
      cookie: cookieHeader,
    }),
  ]);

  if (!wsRes.ok || !taskRes.ok) redirect(`/workspaces/${workspaceId}`);

  const workspace = wsRes.data;
  const task = taskRes.data;
  const history = historyRes.ok ? historyRes.data.history : [];

  const linkedGoal: HubGoal | null = task.goalId
    ? await hubFetch<HubGoal>(`/workspaces/${workspaceId}/goals/${task.goalId}`, {
        cookie: cookieHeader,
      }).then((r) => (r.ok ? r.data : null))
    : null;

  const isActive =
    task.status === 'pending_agent' ||
    task.status === 'assigned' ||
    task.status === 'in_progress';

  const canCancel =
    task.status === 'pending_agent' ||
    task.status === 'pending_design' ||
    task.status === 'design_review' ||
    task.status === 'assigned' ||
    task.status === 'in_progress';

  const canRetry = task.status === 'failed' || task.status === 'cancelled';

  return (
    <div className="flex flex-col gap-6">
      {isActive && <TaskDetailRefresh />}

      <div className="flex items-center gap-2 flex-wrap">
        <Link href="/workspaces" className="text-default-500 hover:text-foreground text-sm">
          Workspaces
        </Link>
        <span className="text-default-400">/</span>
        <Link
          href={`/workspaces/${workspaceId}`}
          className="text-default-500 hover:text-foreground text-sm"
        >
          {workspace.name}
        </Link>
        <span className="text-default-400">/</span>
        <span className="font-mono text-sm text-default-500">{task.id}</span>
      </div>

      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-4">
            <h1 className="text-xl font-bold">{task.title}</h1>
            <div className="flex items-center gap-2 shrink-0">
              {task.priority !== 'normal' && (
                <Chip size="sm" variant="flat" color={PRIORITY_COLOR[task.priority] ?? 'default'}>
                  {task.priority}
                </Chip>
              )}
              <Chip size="sm" variant="flat" color={STATUS_COLOR[task.status] ?? 'default'}>
                {statusLabel(task.status)}
              </Chip>
              {canCancel && (
                <TaskActionButton workspaceId={workspaceId} taskId={task.id} action="cancel" />
              )}
              {canRetry && (
                <TaskActionButton workspaceId={workspaceId} taskId={task.id} action="retry" />
              )}
            </div>
          </div>

          {task.description && (
            <p className="text-sm text-default-600 whitespace-pre-wrap">{task.description}</p>
          )}

          {linkedGoal && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-default-400">Goal</span>
              <Link
                href={`/workspaces/${workspaceId}/goals`}
                className="text-xs text-primary hover:underline"
              >
                {linkedGoal.title}
              </Link>
              <Chip size="sm" variant="flat" color="default">
                {linkedGoal.status}
              </Chip>
            </div>
          )}

          <div className="flex gap-4 text-xs text-default-400 pt-1 border-t border-default-100">
            <span>Created by {task.createdBy}</span>
            <span>&middot;</span>
            <span>{formatTs(task.createdAt)}</span>
            {task.assignedDeviceId && (
              <>
                <span>&middot;</span>
                <span>Device: {task.assignedDeviceId}</span>
              </>
            )}
            {task.assignedAgentId && (
              <>
                <span>&middot;</span>
                <span>Agent: {task.assignedAgentId}</span>
              </>
            )}
          </div>
        </CardBody>
      </Card>

      {history.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-default-500 uppercase tracking-wide mb-3">
            History
          </h2>
          <div className="pl-1">
            {history.map((event) => (
              <HistoryEvent key={event.id} event={event} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
