import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardBody, Chip } from '@heroui/react';
import {
  hubFetch,
  type HubGoal,
  type HubTaskComment,
  type HubTaskHistory,
  type HubTaskWithParent,
  type HubWorkspace,
} from '@/lib/hub';
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

const DECISION_COLOR: Record<string, string> = {
  ROUTED:     'text-green-400',
  DECOMPOSED: 'text-blue-400',
  ESCALATED:  'text-yellow-400',
  DEFERRED:   'text-white/40',
};

const CONFIDENCE_COLOR: Record<string, string> = {
  HIGH:   'text-green-400',
  MEDIUM: 'text-yellow-400',
  LOW:    'text-red-400',
};

function statusLabel(s: string) {
  return s.replace(/_/g, ' ');
}

function formatTs(ts: string): string {
  return new Date(ts).toLocaleString();
}

/** Parse a dispatcher comment body into structured decision fields. */
function parseDecision(body: string) {
  const lines = body.split('\n');
  const fields: Record<string, string> = {};
  const rest: string[] = [];
  for (const line of lines) {
    const m = /^(Decision|Agent|Reason|Confidence|Bottleneck|Missing info|Interface contract):\s*(.*)$/.exec(line);
    if (m) {
      fields[m[1]!.toLowerCase().replace(/\s+/g, '_')] = m[2]!.trim();
    } else {
      rest.push(line);
    }
  }
  return {
    decision:   fields['decision'],
    agent:      fields['agent'],
    reason:     fields['reason'],
    confidence: fields['confidence'],
    rest:       rest.join('\n').trim(),
  };
}

const EVENT_LABELS: Record<string, string> = {
  'task.created':    'Task created',
  'task.assigned':   'Assigned to agent',
  'task.claimed':    'Claimed by device',
  'task.started':    'Work started',
  'task.completed':  'Task completed',
  'task.failed':     'Task failed',
  'task.cancelled':  'Task cancelled',
  'task.requeued':   'Requeued for retry',
  'task.commented':  'Comment added',
  'task.dispatched': 'Routed by dispatcher',
};

function friendlySource(source: string): string {
  if (source.startsWith('device:')) return source.slice(7).slice(0, 12);
  if (source.startsWith('user:'))   return source.slice(5);
  return source;
}

function HistoryEvent({ event }: { event: HubTaskHistory }) {
  const payload = event.payload as Record<string, unknown> | null;
  const label = EVENT_LABELS[event.eventName] ?? event.eventName.replace(/^task\./, '').replace(/_/g, ' ');

  // Show meaningful payload fields (skip runId and internal keys)
  const skip = new Set(['runId', 'taskId']);
  const payloadEntries = payload
    ? Object.entries(payload).filter(([k]) => !skip.has(k))
    : [];

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="w-2 h-2 rounded-full bg-default-400 mt-1.5 shrink-0" />
        <div className="w-px flex-1 bg-default-200 mt-1" />
      </div>
      <div className="pb-4 flex-1">
        <p className="font-medium text-sm capitalize">{label}</p>
        <p className="text-xs text-default-500 mt-0.5">
          {friendlySource(event.source)} &middot; {formatTs(event.createdAt)}
        </p>
        {payloadEntries.length > 0 && (
          <div className="mt-1 text-xs text-default-400 font-mono flex flex-wrap gap-x-3 gap-y-0.5">
            {payloadEntries.map(([k, v]) => (
              <span key={k}>
                <span className="text-default-500">{k}:</span> {String(v)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DispatcherCommentCard({ comment }: { comment: HubTaskComment }) {
  const parsed = parseDecision(comment.body);
  const decisionColor = parsed.decision
    ? (DECISION_COLOR[parsed.decision] ?? 'text-white/70')
    : 'text-white/70';
  const confidenceColor = parsed.confidence
    ? (CONFIDENCE_COLOR[parsed.confidence] ?? 'text-white/40')
    : 'text-white/40';

  return (
    <div className="rounded-xl border border-purple-500/20 bg-purple-500/[0.04] p-4">
      {/* Structured decision fields */}
      {parsed.decision && (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] font-mono mb-2">
          <span>
            <span className="text-white/30">Decision: </span>
            <span className={decisionColor}>{parsed.decision}</span>
          </span>
          {parsed.agent && (
            <span>
              <span className="text-white/30">Agent: </span>
              <span className="text-white/70">{parsed.agent}</span>
            </span>
          )}
          {parsed.confidence && (
            <span>
              <span className="text-white/30">Confidence: </span>
              <span className={confidenceColor}>{parsed.confidence}</span>
            </span>
          )}
        </div>
      )}

      {parsed.reason && (
        <p className="text-[12px] text-white/60 leading-relaxed mb-2">{parsed.reason}</p>
      )}

      {/* Raw body fallback for non-structured comments */}
      {!parsed.decision && (
        <pre className="text-xs text-white/50 whitespace-pre-wrap font-mono leading-relaxed mb-2">
          {comment.body}
        </pre>
      )}

      <p className="text-[10px] text-white/20 font-mono">{formatTs(comment.createdAt)}</p>
    </div>
  );
}

export default async function TaskDetailPage({ params }: Props) {
  const { id: workspaceId, taskId } = await params;
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;

  const [wsRes, taskRes, historyRes, commentsRes] = await Promise.all([
    hubFetch<HubWorkspace>(`/workspaces/${workspaceId}`, { cookie: cookieHeader }),
    hubFetch<HubTaskWithParent>(`/tasks/${taskId}`, { cookie: cookieHeader }),
    hubFetch<{ history: HubTaskHistory[] }>(`/tasks/${taskId}/history`, { cookie: cookieHeader }),
    hubFetch<{ comments: HubTaskComment[] }>(`/tasks/${taskId}/comments`, { cookie: cookieHeader }),
  ]);

  if (!wsRes.ok || !taskRes.ok) redirect(`/workspaces/${workspaceId}`);

  const workspace = wsRes.data;
  const task = taskRes.data;
  const history = historyRes.ok ? historyRes.data.history : [];
  const allComments = commentsRes.ok ? commentsRes.data.comments : [];
  const dispatcherComments = allComments.filter(c => c.authorType === 'dispatcher');

  // Fetch linked goal if present
  const linkedGoal: HubGoal | null = task.goalId
    ? await hubFetch<HubGoal>(`/workspaces/${workspaceId}/goals/${task.goalId}`, {
        cookie: cookieHeader,
      }).then((r) => (r.ok ? r.data : null))
    : null;

  // Fetch parent task title if this is a subtask
  const parentTask: { id: string; title: string } | null = task.parentId
    ? await hubFetch<{ id: string; title: string }>(`/tasks/${task.parentId}`, {
        cookie: cookieHeader,
      }).then((r) => (r.ok ? { id: r.data.id, title: r.data.title } : null))
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
      <TaskDetailRefresh workspaceId={workspaceId} />

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
        {parentTask && (
          <>
            <Link
              href={`/workspaces/${workspaceId}/tasks/${parentTask.id}`}
              className="text-default-500 hover:text-foreground text-sm font-mono truncate max-w-[180px]"
              title={parentTask.title}
            >
              {parentTask.id}
            </Link>
            <span className="text-default-400">/</span>
          </>
        )}
        <span className="font-mono text-sm text-default-500">{task.id}</span>
      </div>

      <Card>
        <CardBody className="flex flex-col gap-3">
          {/* Parent task indicator */}
          {parentTask && (
            <div className="flex items-center gap-2 pb-2 border-b border-default-100">
              <span className="text-xs text-default-400">Subtask of</span>
              <Link
                href={`/workspaces/${workspaceId}/tasks/${parentTask.id}`}
                className="text-xs text-primary hover:underline font-mono"
              >
                {parentTask.id}
              </Link>
              <span className="text-xs text-default-400 truncate">{parentTask.title}</span>
            </div>
          )}

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
            <span>Created by {task.createdBy.replace(/^(device:|user:)/, '')}</span>
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

      {/* Dispatcher comments */}
      {dispatcherComments.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-white/50 uppercase tracking-wider mb-3">
            🔱 Dispatcher Notes
          </h2>
          <div className="flex flex-col gap-2">
            {dispatcherComments.map(comment => (
              <DispatcherCommentCard key={comment.id} comment={comment} />
            ))}
          </div>
        </div>
      )}

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
