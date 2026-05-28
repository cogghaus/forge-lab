'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import DateRangePicker from './_components/date-range-picker';
import type { HubAnalyticsOverview } from '@/lib/hub';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return '-';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
}

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
      style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
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
        <span className="font-mono text-[10px]" style={{ color: 'rgba(245,240,235,0.25)' }}>
          {sub}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Clickable status distribution
// ---------------------------------------------------------------------------

const STATUS_SEGMENTS = [
  { key: 'completed',                  color: '#2DD4A0',                   label: 'completed' },
  { key: 'in_progress',                color: '#60A5FA',                   label: 'in progress' },
  { key: 'failed',                     color: '#F87171',                   label: 'failed' },
  { key: 'cancelled',                  color: 'rgba(255,255,255,0.12)',    label: 'cancelled' },
  { key: 'pending',                    color: '#F59E0B',                   label: 'pending' },
] as const;

/** Map display keys to task status query values. */
const STATUS_QUERY: Record<string, string> = {
  completed: 'completed',
  in_progress: 'in_progress',
  failed: 'failed',
  cancelled: 'cancelled',
  pending: 'pending_agent',
};

interface StatusBarProps {
  data: HubAnalyticsOverview;
  workspaceId: string;
}

function StatusBar({ data, workspaceId }: StatusBarProps) {
  const counts: Record<string, number> = {
    completed: data.completedTasks,
    in_progress: data.inProgressTasks,
    failed: data.failedTasks,
    cancelled: data.cancelledTasks,
    pending: data.pendingTasks,
  };
  const total = data.totalTasks;
  if (total === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {/* Clickable bar */}
      <div className="flex rounded-full overflow-hidden h-2" style={{ background: 'rgba(255,255,255,0.06)' }}>
        {STATUS_SEGMENTS.map(({ key, color }) => {
          const n = counts[key] ?? 0;
          if (n === 0) return null;
          const pct = (n / total) * 100;
          return (
            <Link
              key={key}
              href={`/workspaces/${workspaceId}/tasks?status=${STATUS_QUERY[key] ?? key}`}
              title={`View ${key.replace(/_/g, ' ')} tasks`}
              style={{ width: `${pct}%`, background: color, minWidth: 2, display: 'block', cursor: 'pointer' }}
            />
          );
        })}
      </div>

      {/* Clickable legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {STATUS_SEGMENTS.map(({ key, color, label }) => {
          const n = counts[key] ?? 0;
          if (n === 0) return null;
          return (
            <Link
              key={key}
              href={`/workspaces/${workspaceId}/tasks?status=${STATUS_QUERY[key] ?? key}`}
              title={`View ${label} tasks`}
              className="flex items-center gap-1.5 transition-opacity hover:opacity-70 cursor-pointer"
            >
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: color }}
              />
              <span className="font-mono text-[10px]" style={{ color: 'rgba(245,240,235,0.4)' }}>
                {label} <span style={{ color: 'rgba(245,240,235,0.6)' }}>{n}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkspaceAnalyticsPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id;
  const searchParams = useSearchParams();

  const from = searchParams.get('from') ?? undefined;
  const to = searchParams.get('to') ?? undefined;

  const [data, setData] = useState<HubAnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setFetchError(false);
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const query = qs.toString();
    fetch(`/api/hub/workspaces/${workspaceId}/analytics${query ? `?${query}` : ''}`)
      .then(async (res) => {
        if (!res.ok) { setFetchError(true); return; }
        const body = (await res.json()) as HubAnalyticsOverview;
        setData(body);
      })
      .catch(() => setFetchError(true))
      .finally(() => setLoading(false));
  }, [workspaceId, from, to]);

  const completionRatePct = data ? Math.round(data.completionRate * 100) : 0;
  const rateAccent =
    completionRatePct >= 50 ? '#2DD4A0' : completionRatePct >= 20 ? '#F59E0B' : '#F87171';

  const tabQs = new URLSearchParams();
  if (from) tabQs.set('from', from);
  if (to) tabQs.set('to', to);
  const tabRange = tabQs.toString();
  const agentsHref = `/workspaces/${workspaceId}/analytics/agents${tabRange ? `?${tabRange}` : ''}`;

  return (
    <div className="max-w-2xl">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-6">
        <h1 className="font-mono text-[18px] font-bold">Analytics</h1>
      </div>

      {/* Tab nav */}
      <div
        className="flex gap-1 mb-5 p-1 rounded-lg"
        style={{ background: 'rgba(255,255,255,0.04)', width: 'fit-content' }}
      >
        <span
          className="font-mono text-[11px] px-3 py-1.5 rounded-md"
          style={{ background: 'rgba(255,255,255,0.07)', color: 'rgba(245,240,235,0.85)' }}
        >
          Overview
        </span>
        <Link
          href={agentsHref}
          className="font-mono text-[11px] px-3 py-1.5 rounded-md transition-colors"
          style={{ color: 'rgba(245,240,235,0.45)' }}
        >
          Agent Performance
        </Link>
      </div>

      {/* Date range picker */}
      <DateRangePicker className="mb-5" />

      {/* Error */}
      {fetchError && !loading && (
        <div
          className="rounded-[10px] px-5 py-10 text-center mb-6"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <p className="text-[13px]" style={{ color: 'rgba(255,80,80,0.7)' }}>
            Could not load stats. Hub may be unreachable.
          </p>
        </div>
      )}

      {/* Skeleton */}
      {loading && (
        <div className="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-[10px] h-[96px] animate-pulse"
              style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
            />
          ))}
        </div>
      )}

      {/* Stat cards */}
      {!loading && !fetchError && data && (
        <>
          <div className="grid grid-cols-2 gap-3 mb-6 sm:grid-cols-4">
            <StatCard label="Total tasks" value={data.totalTasks} />
            <StatCard label="Completed" value={data.completedTasks} accent="#2DD4A0" />
            <StatCard
              label="Completion rate"
              value={`${completionRatePct}%`}
              accent={rateAccent}
            />
            <StatCard
              label="Failed"
              value={data.failedTasks}
              accent={data.failedTasks > 0 ? '#F87171' : 'rgba(245,240,235,0.9)'}
            />
          </div>

          {data.avgCompletionTimeMs !== null && (
            <div
              className="rounded-[10px] px-5 py-4 mb-6 flex items-center gap-4"
              style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <span className="font-mono text-[10px] uppercase tracking-[0.08em]" style={{ color: 'rgba(245,240,235,0.35)' }}>
                Avg completion time
              </span>
              <span className="font-mono text-[14px] font-bold" style={{ color: 'rgba(245,240,235,0.85)' }}>
                {formatDuration(data.avgCompletionTimeMs)}
              </span>
            </div>
          )}

          {/* Status breakdown */}
          {data.totalTasks > 0 && (
            <div
              className="rounded-[10px] px-5 py-5 mb-6"
              style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <p
                className="font-mono text-[10px] uppercase tracking-[0.08em] mb-4"
                style={{ color: 'rgba(245,240,235,0.35)' }}
              >
                Status breakdown
              </p>
              <StatusBar data={data} workspaceId={workspaceId} />
            </div>
          )}

          {data.totalTasks === 0 && (
            <div
              className="rounded-[10px] px-5 py-10 text-center"
              style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <p className="text-[13px] mb-2" style={{ color: 'rgba(245,240,235,0.3)' }}>
                No tasks in this period.
              </p>
              <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.18)' }}>
                Adjust the date range or create tasks to see stats.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
