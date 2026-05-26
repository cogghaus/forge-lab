import { redirect } from 'next/navigation';
import { hubFetch, type HubTaskStats } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string;
  value: number | string;
  sub?: string;
  accent?: string;
}

function StatCard({ label, value, sub, accent }: StatCardProps) {
  return (
    <div
      className="rounded-[10px] px-5 py-5 flex flex-col gap-1"
      style={{
        background: '#111116',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <span
        className="font-mono text-[10px] uppercase tracking-[0.08em]"
        style={{ color: 'rgba(245,240,235,0.35)' }}
      >
        {label}
      </span>
      <span
        className="text-[28px] font-bold tabular-nums"
        style={{ color: accent ?? 'rgba(245,240,235,0.9)' }}
      >
        {value}
      </span>
      {sub && (
        <span
          className="font-mono text-[10px]"
          style={{ color: 'rgba(245,240,235,0.25)' }}
        >
          {sub}
        </span>
      )}
    </div>
  );
}

interface StatusBarProps {
  byStatus: Record<string, number>;
  total: number;
}

function StatusBar({ byStatus, total }: StatusBarProps) {
  if (total === 0) return null;

  const segments: Array<{ key: string; color: string; label: string }> = [
    { key: 'completed', color: '#2DD4A0', label: 'completed' },
    { key: 'in_progress', color: '#60A5FA', label: 'in progress' },
    { key: 'failed', color: '#F87171', label: 'failed' },
    { key: 'cancelled', color: 'rgba(255,255,255,0.12)', label: 'cancelled' },
    { key: 'pending_agent', color: '#F59E0B', label: 'pending' },
    { key: 'assigned', color: '#A78BFA', label: 'assigned' },
    { key: 'pending_dispatcher_action', color: '#FB923C', label: 'dispatching' },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* Bar */}
      <div className="flex rounded-full overflow-hidden h-2" style={{ background: 'rgba(255,255,255,0.06)' }}>
        {segments.map(({ key, color }) => {
          const n = byStatus[key] ?? 0;
          if (n === 0) return null;
          const pct = (n / total) * 100;
          return (
            <div
              key={key}
              style={{ width: `${pct}%`, background: color, minWidth: n > 0 ? '2px' : 0 }}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map(({ key, color, label }) => {
          const n = byStatus[key] ?? 0;
          if (n === 0) return null;
          return (
            <div key={key} className="flex items-center gap-1.5">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: color }}
              />
              <span
                className="font-mono text-[10px]"
                style={{ color: 'rgba(245,240,235,0.4)' }}
              >
                {label} <span style={{ color: 'rgba(245,240,235,0.6)' }}>{n}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function AnalyticsPage() {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;
  const statsRes = await hubFetch<HubTaskStats>('/tasks/stats', {
    cookie: cookieHeader,
  });
  const fetchFailed = !statsRes.ok;

  if (fetchFailed) {
    return (
      <div className="max-w-2xl">
        <div className="flex items-center gap-3 mb-8">
          <h1 className="font-mono text-[18px] font-bold">Analytics</h1>
        </div>
        <div
          className="rounded-[10px] px-5 py-10 text-center"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <p className="text-[13px]" style={{ color: 'rgba(255,80,80,0.7)' }}>
            Could not load stats. Hub may be unreachable.
          </p>
        </div>
      </div>
    );
  }

  const stats = statsRes.data;

  return (
    <div className="max-w-2xl">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-8">
        <h1 className="font-mono text-[18px] font-bold">Analytics</h1>
      </div>

      {/* Top stat cards */}
      <div className="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-4">
        <StatCard
          label="Total tasks"
          value={stats.total}
        />
        <StatCard
          label="Completed"
          value={stats.summary.completed}
          accent="#2DD4A0"
        />
        <StatCard
          label="Completion rate"
          value={`${stats.completionRate}%`}
          sub={`${stats.completedLast7Days} last 7d`}
          accent={stats.completionRate >= 75 ? '#2DD4A0' : stats.completionRate >= 40 ? '#F59E0B' : '#F87171'}
        />
        <StatCard
          label="Failed"
          value={stats.summary.failed}
          accent={stats.summary.failed > 0 ? '#F87171' : 'rgba(245,240,235,0.9)'}
        />
      </div>

      {/* Status breakdown */}
      {stats.total > 0 && (
        <div
          className="rounded-[10px] px-5 py-5 mb-6"
          style={{
            background: '#111116',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <p
            className="font-mono text-[10px] uppercase tracking-[0.08em] mb-4"
            style={{ color: 'rgba(245,240,235,0.35)' }}
          >
            Status breakdown
          </p>
          <StatusBar byStatus={stats.byStatus} total={stats.total} />
        </div>
      )}

      {/* Empty state */}
      {stats.total === 0 && (
        <div
          className="rounded-[10px] px-5 py-10 text-center"
          style={{
            background: '#111116',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <p
            className="text-[13px] mb-2"
            style={{ color: 'rgba(245,240,235,0.3)' }}
          >
            No tasks yet.
          </p>
          <p
            className="font-mono text-[11px]"
            style={{ color: 'rgba(245,240,235,0.18)' }}
          >
            Create tasks in a workspace to see stats here.
          </p>
        </div>
      )}

      {/* Live indicators */}
      {stats.summary.inProgress > 0 && (
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#60A5FA] opacity-50" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[#60A5FA]" />
          </span>
          <span
            className="font-mono text-[11px]"
            style={{ color: 'rgba(245,240,235,0.4)' }}
          >
            {stats.summary.inProgress} {stats.summary.inProgress === 1 ? 'task' : 'tasks'} in progress
          </span>
        </div>
      )}
    </div>
  );
}
