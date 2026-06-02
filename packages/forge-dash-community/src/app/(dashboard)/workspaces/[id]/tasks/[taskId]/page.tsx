import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  hubFetch,
  type HubAgent,
  type HubDevice,
  type HubGoal,
  type HubTaskComment,
  type HubTaskHistory,
  type HubTaskWithParent,
  type HubWorkspace,
  REASSIGNABLE_STATUSES,
} from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { TaskDetailRefresh } from './task-detail-refresh';
import { TaskActionButton } from './task-action-button';
import { ReassignDropdown } from './reassign-dropdown-loader';

interface Props {
  params: Promise<{ id: string; taskId: string }>;
}

// Explicit hex per status — one shared color language with the task list + kanban.
const STATUS_HEX: Record<string, string> = {
  pending_agent: '#a1a1aa',
  pending_design: '#a1a1aa',
  design_review: '#FFB547',
  pending_dispatcher_action: '#FFB547',
  assigned: '#FF6B2B',
  in_progress: '#FF6B2B',
  completed: '#2DD4A0',
  failed: '#FF4757',
  cancelled: '#FF4757',
};

const PRIORITY_HEX: Record<string, string> = {
  high: '#FFB547',
  urgent: '#FF4757',
};

function statusHex(s: string): string {
  return STATUS_HEX[s] ?? '#a1a1aa';
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

function resolveCreatedBy(createdBy: string, deviceMap: Map<string, string>): string {
  if (createdBy.startsWith('device:')) {
    const id = createdBy.slice(7);
    return deviceMap.get(id) ?? id.slice(0, 12);
  }
  if (createdBy.startsWith('user:')) return 'user';
  return createdBy;
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
  if (source.startsWith('user:')) return 'user';
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
        <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-600" />
        <div className="mt-1 w-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      </div>
      <div className="flex-1 pb-4">
        <p className="text-sm font-medium capitalize text-zinc-900 dark:text-zinc-100">{label}</p>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {friendlySource(event.source)} &middot; {formatTs(event.createdAt)}
        </p>
        {payloadEntries.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">
            {payloadEntries.map(([k, v]) => (
              <span key={k}>
                <span className="text-zinc-400 dark:text-zinc-500">{k}:</span> {String(v)}
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

  const [wsRes, taskRes, historyRes, commentsRes, devicesRes] = await Promise.all([
    hubFetch<HubWorkspace>(`/workspaces/${workspaceId}`, { cookie: cookieHeader }),
    hubFetch<HubTaskWithParent>(`/tasks/${taskId}`, { cookie: cookieHeader }),
    hubFetch<{ history: HubTaskHistory[] }>(`/tasks/${taskId}/history`, { cookie: cookieHeader }),
    hubFetch<{ comments: HubTaskComment[] }>(`/tasks/${taskId}/comments`, { cookie: cookieHeader }),
    hubFetch<{ devices: HubDevice[] }>('/devices', { cookie: cookieHeader }),
  ]);

  if (!wsRes.ok || !taskRes.ok) redirect(`/workspaces/${workspaceId}`);

  const task = taskRes.data;
  const history = historyRes.ok ? historyRes.data.history : [];
  const allComments = commentsRes.ok ? commentsRes.data.comments : [];
  const dispatcherComments = allComments.filter(c => c.authorType === 'dispatcher');
  const deviceMap = new Map<string, string>(
    (devicesRes.ok ? devicesRes.data.devices : []).map((d: HubDevice) => [d.id, d.name]),
  );

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

  // Fetch workspace agents for reassign dropdown (only when task is reassignable)
  const canReassign = (REASSIGNABLE_STATUSES as string[]).includes(task.status);
  const agents: HubAgent[] = canReassign
    ? await hubFetch<{ agents: HubAgent[] }>(`/workspaces/${workspaceId}/agents`, {
        cookie: cookieHeader,
      }).then((r) => (r.ok ? r.data.agents : []))
    : [];

  const canCancel =
    task.status === 'pending_dispatcher_action' ||
    task.status === 'pending_agent' ||
    task.status === 'pending_design' ||
    task.status === 'design_review' ||
    task.status === 'assigned' ||
    task.status === 'in_progress';

  const canRetry = task.status === 'failed' || task.status === 'cancelled';

  return (
    <div className="flex flex-col gap-6">
      <TaskDetailRefresh workspaceId={workspaceId} />

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/workspaces/${workspaceId}/tasks`}
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Tasks
        </Link>
        <span className="text-zinc-300 dark:text-zinc-700">/</span>
        {parentTask && (
          <>
            <Link
              href={`/workspaces/${workspaceId}/tasks/${parentTask.id}`}
              className="max-w-[180px] truncate font-mono text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              title={parentTask.title}
            >
              {parentTask.id}
            </Link>
            <span className="text-zinc-300 dark:text-zinc-700">/</span>
          </>
        )}
        <span className="font-mono text-sm text-zinc-500 dark:text-zinc-400">{task.id}</span>
      </div>

      <div className="relative flex flex-col gap-3 overflow-hidden rounded-xl border border-zinc-200 bg-white p-5 pl-6 dark:border-zinc-800 dark:bg-zinc-900/70">
        <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: statusHex(task.status) }} aria-hidden />
        {/* Parent task indicator */}
        {parentTask && (
          <div className="flex items-center gap-2 border-b border-zinc-100 pb-2 dark:border-zinc-800">
            <span className="text-xs text-zinc-400 dark:text-zinc-500">Subtask of</span>
            <Link
              href={`/workspaces/${workspaceId}/tasks/${parentTask.id}`}
              className="font-mono text-xs text-[#FF6B2B] hover:underline"
            >
              {parentTask.id}
            </Link>
            <span className="truncate text-xs text-zinc-400 dark:text-zinc-500">{parentTask.title}</span>
          </div>
        )}

        <div className="flex items-start justify-between gap-4">
          <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">{task.title}</h1>
          <div className="flex shrink-0 items-center gap-2">
            {PRIORITY_HEX[task.priority] && <Pill label={task.priority} color={PRIORITY_HEX[task.priority]!} />}
            <Pill label={statusLabel(task.status)} color={statusHex(task.status)} />
            {canCancel && (
              <TaskActionButton
                workspaceId={workspaceId}
                taskId={task.id}
                taskTitle={task.title}
                taskStatus={task.status}
                action="cancel"
              />
            )}
            {canRetry && (
              <TaskActionButton
                workspaceId={workspaceId}
                taskId={task.id}
                taskTitle={task.title}
                taskStatus={task.status}
                action="retry"
              />
            )}
          </div>
        </div>

        {task.description && (
          <p className="whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-300">{task.description}</p>
        )}

        {linkedGoal && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400 dark:text-zinc-500">Goal</span>
            <Link
              href={`/workspaces/${workspaceId}/goals`}
              className="text-xs text-[#FF6B2B] hover:underline"
            >
              {linkedGoal.title}
            </Link>
            <Pill label={linkedGoal.status} color="#a1a1aa" />
          </div>
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-100 pt-2 text-xs text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          <span>Created by {resolveCreatedBy(task.createdBy, deviceMap)}</span>
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

        {canReassign && (
          <div className="border-t border-zinc-100 pt-1 dark:border-zinc-800">
            <ReassignDropdown
              workspaceId={workspaceId}
              taskId={task.id}
              currentAgentId={task.assignedAgentId}
              agents={agents}
            />
          </div>
        )}
      </div>

      {/* Dispatcher comments */}
      {dispatcherComments.length > 0 && (
        <div>
          <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            <svg viewBox="0 0 24 24" fill="none" stroke="#A78BFA" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
              <path d="M12 2v20M5 7l7-5 7 5M5 7v4l7 4 7-4V7" />
            </svg>
            Dispatcher notes
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
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
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
