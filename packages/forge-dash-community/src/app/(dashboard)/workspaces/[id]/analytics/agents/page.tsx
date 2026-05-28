'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import DateRangePicker from '../_components/date-range-picker';
import type { HubAgentPerf, HubAgentPerfResponse } from '@/lib/hub';

// ---------------------------------------------------------------------------
// Helpers (shared with global analytics agents page)
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
// Agent card
// ---------------------------------------------------------------------------

function AgentCard({ agent }: { agent: HubAgentPerf }) {
  const hasActivity = agent.totalCount > 0;
  const terminal = agent.completedCount + agent.failedCount;
  const failureColor =
    agent.failureRate === 0
      ? 'rgba(245,240,235,0.35)'
      : agent.failureRate < 10
        ? '#F59E0B'
        : '#F87171';

  return (
    <div
      className="rounded-[10px] px-5 py-5 flex flex-col gap-3"
      style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] font-bold truncate" style={{ color: '#FF6B2B' }}>
          {agent.agentId}
        </span>
        {agent.inProgressCount > 0 && (
          <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#60A5FA] opacity-50" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[#60A5FA]" />
          </span>
        )}
      </div>

      <div>
        <span className="text-[32px] font-bold tabular-nums leading-none" style={{ color: hasActivity ? 'rgba(245,240,235,0.9)' : 'rgba(245,240,235,0.2)' }}>
          {agent.throughputPerDay.toFixed(1)}
        </span>
        <span className="font-mono text-[10px] ml-1.5" style={{ color: 'rgba(245,240,235,0.35)' }}>
          tasks/day
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between items-center">
          <span className="font-mono text-[10px]" style={{ color: 'rgba(245,240,235,0.35)' }}>avg time</span>
          <span className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.7)' }}>{formatDuration(agent.avgCompletionTimeMs)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="font-mono text-[10px]" style={{ color: 'rgba(245,240,235,0.35)' }}>failure rate</span>
          <span className="font-mono text-[11px] font-semibold" style={{ color: failureColor }}>{agent.failureRate.toFixed(1)}%</span>
        </div>
      </div>

      {terminal > 0 && (
        <div>
          <div className="flex rounded-full overflow-hidden h-1 mb-2" style={{ background: 'rgba(255,255,255,0.06)' }}>
            {agent.completedCount > 0 && (
              <div style={{ width: `${(agent.completedCount / terminal) * 100}%`, background: '#2DD4A0', minWidth: 2 }} />
            )}
            {agent.failedCount > 0 && (
              <div style={{ width: `${(agent.failedCount / terminal) * 100}%`, background: '#F87171', minWidth: 2 }} />
            )}
          </div>
          <div className="flex gap-3">
            <span className="font-mono text-[10px]" style={{ color: 'rgba(245,240,235,0.35)' }}>
              <span style={{ color: '#2DD4A0' }}>{agent.completedCount}</span> done
            </span>
            {agent.failedCount > 0 && (
              <span className="font-mono text-[10px]" style={{ color: 'rgba(245,240,235,0.35)' }}>
                <span style={{ color: '#F87171' }}>{agent.failedCount}</span> failed
              </span>
            )}
            {agent.inProgressCount > 0 && (
              <span className="font-mono text-[10px]" style={{ color: 'rgba(245,240,235,0.35)' }}>
                <span style={{ color: '#60A5FA' }}>{agent.inProgressCount}</span> active
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkspaceAgentPerformancePage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id;
  const searchParams = useSearchParams();

  const from = searchParams.get('from') ?? undefined;
  const to = searchParams.get('to') ?? undefined;

  const [data, setData] = useState<HubAgentPerfResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);

  const loadData = useCallback(async () => {
    setFetchError(false);
    try {
      const qs = new URLSearchParams();
      qs.set('workspaceId', workspaceId);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const res = await fetch(`/api/hub/agents/performance?${qs.toString()}`);
      if (!res.ok) { setFetchError(true); return; }
      const body = (await res.json()) as HubAgentPerfResponse;
      setData(body);
    } catch {
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, from, to]);

  useEffect(() => {
    setLoading(true);
    void loadData();
  }, [loadData]);

  return (
    <div className="max-w-4xl">
      {/* Page header */}
      <div className="flex items-center gap-3 mb-6">
        <h1 className="font-mono text-[18px] font-bold">Analytics</h1>
      </div>

      {/* Tab nav - preserve from/to when switching tabs */}
      {(() => {
        const qs = new URLSearchParams();
        if (from) qs.set('from', from);
        if (to) qs.set('to', to);
        const rangeQuery = qs.toString();
        const overviewHref = `/workspaces/${workspaceId}/analytics${rangeQuery ? `?${rangeQuery}` : ''}`;
        return (
          <div
            className="flex gap-1 mb-5 p-1 rounded-lg"
            style={{ background: 'rgba(255,255,255,0.04)', width: 'fit-content' }}
          >
            <Link
              href={overviewHref}
              className="font-mono text-[11px] px-3 py-1.5 rounded-md transition-colors"
              style={{ color: 'rgba(245,240,235,0.45)' }}
            >
              Overview
            </Link>
            <span
              className="font-mono text-[11px] px-3 py-1.5 rounded-md"
              style={{ background: 'rgba(255,255,255,0.07)', color: 'rgba(245,240,235,0.85)' }}
            >
              Agent Performance
            </span>
          </div>
        );
      })()}

      {/* Date range picker */}
      <DateRangePicker className="mb-5" />

      {/* Error */}
      {fetchError && !loading && (
        <div
          className="rounded-[10px] px-5 py-10 text-center mb-6"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <p className="text-[13px]" style={{ color: 'rgba(255,80,80,0.7)' }}>
            Could not load agent metrics. Hub may be unreachable.
          </p>
        </div>
      )}

      {/* Empty */}
      {!fetchError && !loading && data && data.agents.length === 0 && (
        <div
          className="rounded-[10px] px-5 py-10 text-center"
          style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
        >
          <p className="text-[13px] mb-2" style={{ color: 'rgba(245,240,235,0.3)' }}>
            No agent activity in this period.
          </p>
          <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.18)' }}>
            Assign tasks to agents to see performance metrics.
          </p>
        </div>
      )}

      {/* Agent cards grid */}
      {!fetchError && data && data.agents.length > 0 && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.agents.map((agent) => (
              <AgentCard key={agent.agentId} agent={agent} />
            ))}
          </div>
          {data.agents.every((a) => a.totalCount === 0) && (
            <div
              className="mt-4 rounded-[10px] px-5 py-4 flex items-center gap-3"
              style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <span className="text-[10px]" style={{ color: 'rgba(245,240,235,0.25)' }}>●</span>
              <p className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.35)' }}>
                Agents exist but have no completed tasks in this period.
              </p>
            </div>
          )}
        </>
      )}

      {/* Skeleton */}
      {loading && data === null && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-[10px] px-5 py-5 h-[180px] animate-pulse"
              style={{ background: '#111116', border: '1px solid rgba(255,255,255,0.06)' }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
