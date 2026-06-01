'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import type { HubWorkspace, HubDevice, HubTask } from '@/lib/hub';
import { logoutAction } from '@/actions/auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentStatus = 'active' | 'idle' | 'offline';

/** How long since lastSeen before a device is considered offline (ms). */
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// useAgentStatus — polls hub proxy routes for live device + task data
// ---------------------------------------------------------------------------

function isDeviceOnline(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  const ms = new Date(lastSeen).getTime();
  return !isNaN(ms) && Date.now() - ms < ONLINE_THRESHOLD_MS;
}

function deviceStatus(device: HubDevice, activeTasks: HubTask[]): AgentStatus {
  if (activeTasks.some(t => t.assignedDeviceId === device.id)) return 'active';
  return isDeviceOnline(device.lastSeen) ? 'idle' : 'offline';
}

interface AgentStatusState {
  devices: HubDevice[];
  activeTasks: HubTask[];
  /** true while the first fetch is in flight */
  loading: boolean;
}

function useAgentStatus(workspaceId: string | null): AgentStatusState {
  const [state, setState] = useState<AgentStatusState>({
    devices: [],
    activeTasks: [],
    loading: true,
  });

  useEffect(() => {
    let alive = true;

    async function poll(): Promise<void> {
      try {
        const [devRes, taskRes] = await Promise.all([
          fetch('/api/hub/devices'),
          workspaceId
            ? fetch(`/api/hub/tasks?workspaceId=${encodeURIComponent(workspaceId)}`)
            : Promise.resolve(null),
        ]);

        if (!alive) return;

        // Session expired — stop polling and redirect to login
        if (devRes.status === 401 || taskRes?.status === 401) {
          alive = false;
          clearInterval(timer);
          window.location.href = '/login';
          return;
        }

        let devices: HubDevice[] = [];
        let activeTasks: HubTask[] = [];

        if (devRes.ok) {
          // Optional chaining guards against hub returning 200 with null/non-object body.
          const d = (await devRes.json()) as { devices?: HubDevice[] } | null;
          devices = d?.devices ?? [];
        }

        if (taskRes?.ok) {
          const d = (await taskRes.json()) as { tasks?: HubTask[] } | null;
          activeTasks = (d?.tasks ?? []).filter(t => t.status === 'in_progress');
        }

        setState({ devices, activeTasks, loading: false });
      } catch {
        // Network error — keep previous state, mark loaded
        if (alive) setState(prev => ({ ...prev, loading: false }));
      }
    }

    // Assign timer before first poll so the 401 handler's clearInterval is valid.
    const timer = setInterval(() => void poll(), 5_000);
    void poll();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [workspaceId]);

  return state;
}

// ---------------------------------------------------------------------------
// Status style maps
// ---------------------------------------------------------------------------

const DOT_COLOR: Record<AgentStatus, string> = {
  active:  'bg-[#FF6B2B] shadow-[0_0_6px_rgba(255,107,43,0.5)]',
  idle:    'bg-[#4A9EFF]',
  offline: 'bg-white/15',
};

const STATUS_LABEL_COLOR: Record<AgentStatus, string> = {
  active:  'text-[#FF6B2B]',
  idle:    'text-[rgba(74,158,255,0.7)]',
  offline: 'text-white/20',
};

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function sectionLabel(className = '') {
  return `font-mono text-[9px] tracking-[0.12em] uppercase px-3 pt-4 pb-1 text-[rgba(245,240,235,0.28)] ${className}`;
}

function railItem(active: boolean) {
  return (
    'flex items-center gap-2 px-3 py-[5px] rounded-md text-[13px] transition-colors select-none cursor-pointer w-full text-left ' +
    (active
      ? 'bg-[#FF6B2B]/[0.08] text-[#F5F0EB]'
      : 'text-[rgba(245,240,235,0.6)] hover:bg-white/[0.04] hover:text-[#F5F0EB]')
  );
}

function subItem(active: boolean, disabled = false) {
  return (
    'flex items-center gap-2 pl-7 pr-3 py-[4px] rounded-md text-[12px] transition-colors ' +
    (disabled
      ? 'text-[rgba(245,240,235,0.2)]'
      : active
        ? 'text-[rgba(245,240,235,0.7)]'
        : 'text-[rgba(245,240,235,0.35)] hover:bg-white/[0.03] hover:text-[rgba(245,240,235,0.6)] cursor-pointer')
  );
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LeftRailUser {
  name: string;
  email: string;
}

// ---------------------------------------------------------------------------
// LeftRail component
// ---------------------------------------------------------------------------

export function LeftRail({
  workspaces,
  user,
  version,
}: {
  workspaces: HubWorkspace[];
  user?: LeftRailUser;
  /** Deployed build id (git short SHA), shown in the footer for deploy verification. */
  version?: string | null;
}) {
  const pathname = usePathname();

  const wsMatch = pathname.match(/^\/workspaces\/([^/]+)/);
  const activeWsId = wsMatch?.[1] ?? null;

  const [expandedWsId, setExpandedWsId] = useState<string | null>(activeWsId);

  useEffect(() => {
    if (activeWsId) setExpandedWsId(activeWsId);
  }, [activeWsId]);

  const { devices, activeTasks, loading } = useAgentStatus(activeWsId);

  function isWorkshopActive(base: string) {
    return (
      pathname === base ||
      (pathname.startsWith(base + '/') &&
        !pathname.startsWith(base + '/goals') &&
        !pathname.startsWith(base + '/triage') &&
        !pathname.startsWith(base + '/knowledge') &&
        !pathname.startsWith(base + '/analytics') &&
        !pathname.startsWith(base + '/settings'))
    );
  }

  function isGoalsActive(base: string) {
    return pathname.startsWith(base + '/goals');
  }

  function isNavActive(path: string) {
    return pathname === path || pathname.startsWith(path + '/');
  }

  const initials = user?.name.charAt(0).toUpperCase() ?? '?';

  return (
    <nav
      className="flex-shrink-0 flex flex-col overflow-y-auto py-2"
      style={{ width: 220, background: '#111116', borderRight: '1px solid rgba(255,255,255,0.05)' }}
    >
      {/* ── WORKSPACES ── */}
      <div className={sectionLabel()}>Workspaces</div>

      {workspaces.map(ws => {
        const isExp = expandedWsId === ws.id;
        const isAct = activeWsId === ws.id;
        const base = `/workspaces/${ws.id}`;
        const subNavId = `ws-nav-${ws.id}`;

        return (
          <div key={ws.id}>
            <button
              onClick={() => setExpandedWsId(isExp ? null : ws.id)}
              className={railItem(isAct)}
              aria-expanded={isExp}
              aria-controls={subNavId}
            >
              <span className={`text-[11px] flex-shrink-0 ${isExp ? 'text-[#FF6B2B]' : 'text-white/25'}`}>
                {isExp ? '▾' : '▸'}
              </span>
              <span className="flex-1 min-w-0 truncate">{ws.name}</span>
            </button>

            {isExp && (
              <div id={subNavId} className="mb-1">
                <Link href={base}              className={subItem(isWorkshopActive(base))}>Workshop</Link>
                <Link href={`${base}/goals`}   className={subItem(isGoalsActive(base))}>Goals</Link>
                <Link href={`${base}/triage`}     className={subItem(pathname === `${base}/triage`)}>Triage 🔱</Link>
                <Link href={`${base}/knowledge`} className={subItem(pathname.startsWith(`${base}/knowledge`))}>Knowledge 📚</Link>
                <Link href={`${base}/analytics`} className={subItem(pathname.startsWith(`${base}/analytics`))}>Analytics 📈</Link>
                <span
                  className={subItem(false, true)}
                  role="menuitem"
                  aria-disabled="true"
                  tabIndex={-1}
                  title="Member management coming soon"
                >
                  Members
                </span>
                <Link href={`${base}/settings`} className={subItem(pathname.startsWith(`${base}/settings`))}>Settings ⚙</Link>
              </div>
            )}
          </div>
        );
      })}

      <div className="px-3 py-1.5">
        <Link
          href="/workspaces?new=1"
          className="block text-[12px] w-full text-left border border-dashed rounded-md px-2.5 py-1 transition-all border-[rgba(255,255,255,0.1)] text-[rgba(245,240,235,0.5)] hover:border-[rgba(255,107,43,0.3)] hover:text-[#FF6B2B]"
        >
          + New workspace
        </Link>
      </div>

      <div className="border-t border-white/[0.05] mx-2 my-1" />

      {/* ── TASKS ── */}
      <div className={sectionLabel()}>Tasks</div>
      <Link
        href={activeWsId ? `/workspaces/${activeWsId}/tasks` : '/workspaces'}
        className={railItem(pathname.startsWith('/workspaces') && (pathname.includes('/tasks') || !activeWsId))}
      >
        <span className="w-4 text-center text-[13px] flex-shrink-0">☰</span>
        <span>All tasks</span>
      </Link>

      <div className="border-t border-white/[0.05] mx-2 my-1" />

      {/* ── AGENTS ── */}
      <div className={sectionLabel()}>Agents</div>

      {loading && (
        <div className="px-3 py-2">
          <span className="font-mono text-[10px] text-white/20">connecting...</span>
        </div>
      )}

      {!loading && devices.length === 0 && (
        <div className="px-3 py-2">
          <span className="font-mono text-[10px] text-white/20">no devices registered</span>
        </div>
      )}

      {devices.map(device => {
        const status = deviceStatus(device, activeTasks);
        const deviceTasks = activeTasks.filter(t => t.assignedDeviceId === device.id);
        const firstTask = deviceTasks[0] ?? null;
        // Clicking an agent opens the task it's working — its status, dispatcher
        // decision, and result. Linkable only when actively working a task in the
        // current workspace (matches the visible task indicator below).
        const taskHref = status === 'active' && firstTask && activeWsId
          ? `/workspaces/${activeWsId}/tasks/${firstTask.id}`
          : null;

        const inner = (
          <>
            <div className="flex items-center gap-2">
              <span
                className={`w-[7px] h-[7px] rounded-full flex-shrink-0 mt-px ${DOT_COLOR[status]}`}
                aria-hidden="true"
              />
              <span
                className={`text-[13px] flex-1 truncate ${status === 'active' ? 'text-[#F5F0EB]' : 'text-[rgba(245,240,235,0.6)]'}`}
                title={device.hostname ?? device.name}
              >
                {device.name}
              </span>
              <span className={`font-mono text-[9px] uppercase tracking-[0.06em] flex-shrink-0 ${STATUS_LABEL_COLOR[status]}`}>
                {status}
              </span>
            </div>

            {/* Active task progress indicator */}
            {status === 'active' && firstTask !== null && (
              <div className="pl-[15px] mt-1 mb-0.5">
                {/* Indeterminate pulsing bar — no real progress% available */}
                <div className="h-1 rounded-full overflow-hidden mb-1 bg-white/[0.06]">
                  <div
                    className="h-full bg-[#FF6B2B] rounded-full animate-pulse"
                    style={{ width: '45%' }}
                  />
                </div>
                <div className="font-mono text-[10px] text-[rgba(245,240,235,0.45)] truncate">
                  <span className="text-[rgba(245,240,235,0.7)] font-semibold">{firstTask.id}</span>
                  {deviceTasks.length > 1 && (
                    <span className="ml-1 text-[rgba(245,240,235,0.3)]">+{deviceTasks.length - 1}</span>
                  )}
                </div>
              </div>
            )}
          </>
        );

        return taskHref ? (
          <Link
            key={device.id}
            href={taskHref}
            role="listitem"
            aria-label={`${device.name} — ${status}, working ${firstTask!.id}`}
            className="block px-3 py-1.5 rounded-md transition-colors hover:bg-white/[0.04]"
          >
            {inner}
          </Link>
        ) : (
          <div
            key={device.id}
            role="listitem"
            aria-label={`${device.name} — ${status}`}
            className="px-3 py-1.5 rounded-md"
          >
            {inner}
          </div>
        );
      })}

      <div className="flex-1" />
      <div className="border-t border-white/[0.05] mx-2 my-1" />

      {/* ── Bottom nav ── */}
      <Link href="/skills"    className={railItem(isNavActive('/skills'))}>
        <span className="w-4 text-center text-[13px] flex-shrink-0">⚡</span>
        <span>Skills</span>
      </Link>
      <Link href="/org"       className={railItem(isNavActive('/org'))}>
        <span className="w-4 text-center text-[13px] flex-shrink-0">🏛</span>
        <span>Org</span>
      </Link>
      <Link href="/analytics" className={railItem(isNavActive('/analytics'))}>
        <span className="w-4 text-center text-[13px] flex-shrink-0">📈</span>
        <span>Analytics</span>
      </Link>
      <Link href="/costs"     className={railItem(isNavActive('/costs'))}>
        <span className="w-4 text-center text-[13px] flex-shrink-0">$</span>
        <span>Costs</span>
      </Link>
      <Link href="/settings"  className={railItem(isNavActive('/settings'))}>
        <span className="w-4 text-center text-[13px] flex-shrink-0">⚙</span>
        <span>Settings</span>
      </Link>

      {/* ── Profile ── */}
      <div className="border-t border-white/[0.05] mt-2 pt-1 px-1">
        <form action={logoutAction}>
          <button
            type="submit"
            aria-label="Sign out"
            className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md transition-colors hover:bg-white/[0.04]"
          >
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 font-mono text-[11px] font-bold text-[#FF6B2B]"
              style={{ background: 'rgba(255,107,43,0.2)' }}
            >
              {initials}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <div className="text-[12px] font-semibold truncate text-[#F5F0EB]">
                {user?.name ?? 'Account'}
              </div>
              {user?.email && (
                <div className="font-mono text-[10px] truncate text-[rgba(245,240,235,0.35)]">
                  {user.email}
                </div>
              )}
            </div>
          </button>
        </form>
      </div>

      {/* Deployed build id — lets you verify a deploy landed without guessing. */}
      <div
        className="px-3 pb-1.5 pt-0.5 font-mono text-[10px] text-[rgba(245,240,235,0.28)]"
        title="Deployed build (git short SHA)"
      >
        build {version || 'dev'}
      </div>
    </nav>
  );
}
