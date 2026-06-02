import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  hubFetch,
  type HubDispatcherLog,
  type HubTask,
  type HubWorkspace,
} from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

interface Props {
  params: Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadge(status: string): React.ReactElement {
  const styles: Record<string, string> = {
    pending_dispatcher_action: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
    pending_agent:             'bg-blue-500/20 text-blue-300 border-blue-500/30',
    assigned:                  'bg-sky-500/20 text-sky-300 border-sky-500/30',
    in_progress:               'bg-[#FF6B2B]/20 text-[#FF6B2B] border-[#FF6B2B]/30',
    completed:                 'bg-green-500/20 text-green-300 border-green-500/30',
    failed:                    'bg-red-500/20 text-red-300 border-red-500/30',
    cancelled:                 'bg-white/10 text-white/40 border-white/10',
  };
  const cls = styles[status] ?? 'bg-white/10 text-white/40 border-white/10';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono border ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

/** Parse a dispatcher comment body into a structured decision block. */
function parseDecision(body: string): { decision?: string; agent?: string; reason?: string; confidence?: string; rest: string } {
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
    decision: fields['decision'],
    agent: fields['agent'],
    reason: fields['reason'],
    confidence: fields['confidence'],
    rest: rest.join('\n').trim(),
  };
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function TriagePage({ params }: Props) {
  const { id: workspaceId } = await params;
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;

  const [wsRes, logRes, tasksRes] = await Promise.all([
    hubFetch<HubWorkspace>(`/workspaces/${workspaceId}`, { cookie: cookieHeader }),
    hubFetch<HubDispatcherLog>(`/workspaces/${workspaceId}/dispatcher-log`, { cookie: cookieHeader }),
    hubFetch<{ tasks: HubTask[] }>(`/workspaces/${workspaceId}/tasks`, { cookie: cookieHeader }),
  ]);

  if (!wsRes.ok) redirect('/workspaces');

  const log = logRes.ok ? logRes.data : { comments: [], inboxCount: 0 };
  const allTasks = tasksRes.ok ? tasksRes.data.tasks : [];
  const inboxTasks = allTasks.filter(t => t.status === 'pending_dispatcher_action');

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.5fr] gap-6">
        {/* ── FM Inbox ── */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">
              FM Inbox
            </h2>
            {log.inboxCount > 0 && (
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-purple-500/30 text-purple-300 text-[10px] font-bold">
                {log.inboxCount}
              </span>
            )}
          </div>

          {inboxTasks.length === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 text-center">
              <p className="text-sm text-white/30">Inbox empty — FM has no pending work</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {inboxTasks.map(task => (
                <Link
                  key={task.id}
                  href={`/workspaces/${workspaceId}/tasks/${task.id}`}
                  className="flex flex-col gap-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 hover:border-white/[0.12] hover:bg-white/[0.04] transition-all"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium leading-tight">{task.title}</span>
                    {statusBadge(task.status)}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="font-mono text-[11px] text-white/30">{task.id}</span>
                    {task.assignedAgentId && (
                      <span className="text-[11px] text-white/40">→ {task.assignedAgentId}</span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* ── Decision Log ── */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-sm font-semibold text-white/70 uppercase tracking-wider">
              Decision Log
            </h2>
            <span className="text-[11px] text-white/25 font-mono">
              {log.comments.length} entries
            </span>
          </div>

          {log.comments.length === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 text-center">
              <p className="text-sm text-white/30">No dispatcher decisions recorded yet</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2 max-h-[600px] overflow-y-auto pr-1">
              {log.comments.map(comment => {
                const parsed = parseDecision(comment.body);
                const decisionColor = parsed.decision ? (DECISION_COLOR[parsed.decision] ?? 'text-white/70') : 'text-white/70';
                const confidenceColor = parsed.confidence ? (CONFIDENCE_COLOR[parsed.confidence] ?? 'text-white/40') : 'text-white/40';

                return (
                  <Link
                    key={comment.id}
                    href={`/workspaces/${workspaceId}/tasks/${comment.taskId}`}
                    className="block rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 hover:border-white/[0.12] hover:bg-white/[0.04] transition-all"
                  >
                    {/* Task ID */}
                    <span className="text-[12px] text-white/50 font-mono">
                      {comment.taskId}
                    </span>
                    <p className="text-sm font-medium leading-tight mt-0.5 mb-2 truncate">
                      {comment.taskTitle}
                    </p>

                    {/* Structured fields */}
                    {parsed.decision && (
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] font-mono">
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
                      <p className="text-[12px] text-white/50 mt-1 leading-relaxed">
                        {parsed.reason}
                      </p>
                    )}

                    {/* Timestamp */}
                    <p className="text-[10px] text-white/20 font-mono mt-2">
                      {new Date(comment.createdAt).toLocaleString()}
                    </p>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
