import Link from 'next/link';
import type { HubActivityEvent, HubAgentPerf, HubDevice, HubTask } from '@/lib/hub';
import { AgentStopButton } from './agent-stop-button';
import { AgentPersonalityButton } from './agent-personality-button';

// ---------------------------------------------------------------------------
// Agent detail right-rail — opens over the workspace view when ?agent=<deviceId>
// is set (left-rail agent click). Mirrors agent-output-panel's 380px sticky
// rail. v1 derives everything from data the workspace page already fetches.
// ---------------------------------------------------------------------------

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
const ACTIVE_STATUSES = ['assigned', 'in_progress'];

const EVENT_META: Record<string, { label: string; color: string }> = {
  'task.created': { label: 'created', color: '#4A9EFF' },
  'task.claimed': { label: 'claimed', color: '#FF6B2B' },
  'task.completed': { label: 'completed', color: '#2DD4A0' },
  'task.failed': { label: 'failed', color: '#FF4757' },
  'task.cancelled': { label: 'cancelled', color: '#FF4757' },
  'task.requeued': { label: 'requeued', color: '#FFB547' },
};

function relativeTime(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return '—';
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function StatCell({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[15px] font-bold tabular-nums" style={{ color: color ?? 'rgba(245,240,235,0.85)' }}>
        {value}
      </span>
      <span className="font-mono text-[9px] uppercase tracking-[0.08em]" style={{ color: 'rgba(245,240,235,0.35)' }}>
        {label}
      </span>
    </div>
  );
}

export interface AgentDetailPanelProps {
  workspaceId: string;
  device: HubDevice;
  tasks: HubTask[];
  activity: HubActivityEvent[];
  /** 7-day performance for this device's agent persona, if available. */
  perf?: HubAgentPerf | null;
}

export function AgentDetailPanel({ workspaceId, device, tasks, activity, perf }: AgentDetailPanelProps) {
  const online =
    device.lastSeen !== null && Date.now() - new Date(device.lastSeen).getTime() < ONLINE_THRESHOLD_MS;
  const deregistered = device.status === 'deregistered';

  const deviceTasks = tasks.filter((t) => t.assignedDeviceId === device.id);
  const current = deviceTasks.find((t) => ACTIVE_STATUSES.includes(t.status)) ?? null;
  const working = current !== null && online;

  const status = deregistered ? 'deregistered' : working ? 'active' : online ? 'idle' : 'offline';
  const statusColor =
    status === 'active' ? '#FF6B2B' : status === 'idle' ? '#2DD4A0' : 'rgba(245,240,235,0.3)';

  const completed = deviceTasks.filter((t) => t.status === 'completed').length;
  const failed = deviceTasks.filter((t) => t.status === 'failed').length;
  const activeCount = deviceTasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).length;

  const recent = activity.filter((e) => e.source === `device:${device.id}`).slice(0, 8);

  return (
    <div
      className="flex flex-col border-l flex-shrink-0"
      style={{
        width: 380,
        background: '#111116',
        borderColor: 'rgba(255,255,255,0.06)',
        minHeight: 320,
        maxHeight: 'calc(100vh - 120px)',
        position: 'sticky',
        top: '72px',
        alignSelf: 'flex-start',
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between px-4 py-3.5 border-b flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 font-mono text-sm font-bold text-[#FF6B2B]" style={{ background: 'rgba(255,107,43,0.18)' }}>
            {device.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold truncate" style={{ color: '#F5F0EB' }}>{device.name}</div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor }} />
              <span className="font-mono text-[10px] uppercase tracking-[0.08em]" style={{ color: 'rgba(245,240,235,0.4)' }}>
                {status}{device.platform ? ` · ${device.platform}` : ''}
              </span>
            </div>
          </div>
        </div>
        <Link
          href={`/workspaces/${workspaceId}`}
          aria-label="Close agent panel"
          className="w-6 h-6 flex items-center justify-center flex-shrink-0 rounded transition-colors hover:bg-white/[0.06]"
          style={{ color: 'rgba(255,255,255,0.35)' }}
          scroll={false}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
        </Link>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Current work */}
        <div className="px-4 py-3.5 border-b" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
          <div className="font-mono text-[9px] uppercase tracking-[0.1em] mb-2" style={{ color: 'rgba(245,240,235,0.35)' }}>Current work</div>
          {current ? (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[11px] font-semibold flex-shrink-0" style={{ color: 'rgba(245,240,235,0.7)' }}>{current.id}</span>
                <span className="text-[13px] truncate" style={{ color: 'rgba(245,240,235,0.9)' }}>{current.title}</span>
              </div>
              {working && (
                <div className="h-1 rounded-full overflow-hidden bg-white/[0.06]">
                  <div className="h-full bg-[#FF6B2B] rounded-full animate-pulse" style={{ width: '45%' }} />
                </div>
              )}
              <div className="flex items-center gap-2">
                <Link
                  href={`/workspaces/${workspaceId}/tasks/${current.id}`}
                  className="rounded-md border border-[#FF6B2B]/30 bg-[#FF6B2B]/10 px-3 py-1.5 font-mono text-[11px] text-[#FF6B2B] transition-colors hover:bg-[#FF6B2B]/20"
                >
                  View task
                </Link>
                {working && <AgentStopButton workspaceId={workspaceId} taskId={current.id} />}
              </div>
            </div>
          ) : (
            <p className="text-[13px]" style={{ color: 'rgba(245,240,235,0.4)' }}>
              No active task. Agent is {status}.
            </p>
          )}
        </div>

        {/* Stats */}
        <div className="px-4 py-3.5 border-b" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
          <div className="font-mono text-[9px] uppercase tracking-[0.1em] mb-3" style={{ color: 'rgba(245,240,235,0.35)' }}>Stats (this workspace)</div>
          <div className="grid grid-cols-4 gap-3">
            <StatCell label="Done" value={completed} color="#2DD4A0" />
            <StatCell label="Active" value={activeCount} color="#FF6B2B" />
            <StatCell label="Failed" value={failed} color={failed > 0 ? '#FF4757' : undefined} />
            <StatCell label="Total" value={deviceTasks.length} />
          </div>
          {device.lastSeen && (
            <div className="mt-3 flex items-center justify-between font-mono text-[10px]" style={{ color: 'rgba(245,240,235,0.35)' }}>
              <span>last seen</span>
              <span>{relativeTime(device.lastSeen)} ago</span>
            </div>
          )}
        </div>

        {/* 7-day performance (from /agents/performance, keyed by agent persona) */}
        {perf && (
          <div className="px-4 py-3.5 border-b" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
            <div className="font-mono text-[9px] uppercase tracking-[0.1em] mb-3" style={{ color: 'rgba(245,240,235,0.35)' }}>
              7-day performance
            </div>
            <div className="grid grid-cols-2 gap-y-2 font-mono text-[11px]">
              <span style={{ color: 'rgba(245,240,235,0.4)' }}>completed</span>
              <span className="text-right" style={{ color: 'rgba(245,240,235,0.85)' }}>{perf.completedCount}</span>
              <span style={{ color: 'rgba(245,240,235,0.4)' }}>avg duration</span>
              <span className="text-right" style={{ color: 'rgba(245,240,235,0.85)' }}>{fmtDuration(perf.avgCompletionTimeMs)}</span>
              <span style={{ color: 'rgba(245,240,235,0.4)' }}>throughput</span>
              <span className="text-right" style={{ color: 'rgba(245,240,235,0.85)' }}>{perf.throughputPerDay}/day</span>
              <span style={{ color: 'rgba(245,240,235,0.4)' }}>failure rate</span>
              <span className="text-right" style={{ color: perf.failureRate > 0 ? '#FF4757' : 'rgba(245,240,235,0.85)' }}>{perf.failureRate}%</span>
            </div>
          </div>
        )}

        {/* Recent activity */}
        <div className="px-4 py-3.5">
          <div className="font-mono text-[9px] uppercase tracking-[0.1em] mb-2.5" style={{ color: 'rgba(245,240,235,0.35)' }}>Recent activity</div>
          {recent.length === 0 ? (
            <p className="text-[12px]" style={{ color: 'rgba(245,240,235,0.4)' }}>No recent activity from this agent.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {recent.map((e) => {
                const meta = EVENT_META[e.eventName] ?? { label: e.eventName, color: 'rgba(245,240,235,0.4)' };
                return (
                  <li key={e.id} className="flex items-center gap-2 min-w-0">
                    <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: meta.color }} />
                    <Link
                      href={`/workspaces/${workspaceId}/tasks/${e.taskId}`}
                      className="font-mono text-[11px] flex-shrink-0 hover:underline"
                      style={{ color: 'rgba(245,240,235,0.6)' }}
                    >
                      {e.taskId}
                    </Link>
                    <span className="font-mono text-[10px]" style={{ color: meta.color }}>{meta.label}</span>
                    <span className="ml-auto font-mono text-[10px] flex-shrink-0" style={{ color: 'rgba(245,240,235,0.3)' }}>
                      {relativeTime(e.createdAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Personality */}
        {device.agentId && (
          <div className="px-4 py-3.5 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
            <AgentPersonalityButton agentId={device.agentId} />
          </div>
        )}
      </div>
    </div>
  );
}
