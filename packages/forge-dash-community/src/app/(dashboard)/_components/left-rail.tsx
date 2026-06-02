'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';
import type { HubWorkspace, HubDevice, HubTask } from '@/lib/hub';
import { logoutAction } from '@/actions/auth';
import { APP_VERSION } from '@/lib/version';

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
  buildSha,
}: {
  workspaces: HubWorkspace[];
  user?: LeftRailUser;
  /** Deployed git short SHA — shown on hover over the version for deploy verification. */
  buildSha?: string | null;
}) {
  const pathname = usePathname();

  const wsMatch = pathname.match(/^\/workspaces\/([^/]+)/);
  const activeWsId = wsMatch?.[1] ?? null;

  const { devices, activeTasks, loading } = useAgentStatus(activeWsId);

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

      {/* Each workspace links straight to its overview; section navigation
          (Tasks/Goals/Triage/...) now lives in the in-page tab rail. */}
      {workspaces.map(ws => {
        const isAct = activeWsId === ws.id;
        return (
          <Link key={ws.id} href={`/workspaces/${ws.id}`} className={railItem(isAct)}>
            <span className="flex-1 min-w-0 truncate">{ws.name}</span>
          </Link>
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
        // Clicking an agent opens its detail in the workspace right-rail
        // (?agent=<deviceId>) — current work, stats, recent activity. Linkable
        // whenever a workspace is active.
        const agentHref = activeWsId
          ? `/workspaces/${activeWsId}?agent=${device.id}`
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

        return agentHref ? (
          <Link
            key={device.id}
            href={agentHref}
            role="listitem"
            aria-label={`${device.name} — ${status}${firstTask ? `, working ${firstTask.id}` : ''}`}
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
        <ProfileMenu
          name={user?.name ?? 'Account'}
          email={user?.email ?? null}
          initials={initials}
        />
      </div>

      {/* App version (semver). Hover shows the deployed git SHA for verification. */}
      <div
        className="px-3 pb-1.5 pt-0.5 font-mono text-[10px] text-[rgba(245,240,235,0.28)]"
        title={`build ${buildSha || 'dev'}`}
      >
        v{APP_VERSION}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// ProfileMenu — click the account row to open a menu (account settings +
// explicit sign out). Previously the whole row was the logout button, so a
// click silently signed you out with no way to reach account settings.
// ---------------------------------------------------------------------------

function ProfileMenu({ name, email, initials }: { name: string; email: string | null; initials: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      {/* Popover — opens above the trigger */}
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 right-0 mb-1.5 overflow-hidden rounded-lg border shadow-lg"
          style={{ background: '#1A1A1F', borderColor: 'rgba(255,255,255,0.1)' }}
        >
          <div className="px-3 py-2.5 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
            <div className="text-[12px] font-semibold truncate text-[#F5F0EB]">{name}</div>
            {email && (
              <div className="font-mono text-[10px] truncate text-[rgba(245,240,235,0.4)]">{email}</div>
            )}
          </div>
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-[rgba(245,240,235,0.85)] transition-colors hover:bg-white/[0.05]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 flex-shrink-0" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Account settings
          </Link>
          <form action={logoutAction} className="border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[#FF6B6B] transition-colors hover:bg-[rgba(255,107,107,0.1)]"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 flex-shrink-0" aria-hidden>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
              Sign out
            </button>
          </form>
        </div>
      )}

      {/* Trigger row */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md transition-colors hover:bg-white/[0.04]"
      >
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 font-mono text-[11px] font-bold text-[#FF6B2B]"
          style={{ background: 'rgba(255,107,43,0.2)' }}
        >
          {initials}
        </div>
        <div className="flex-1 min-w-0 text-left">
          <div className="text-[12px] font-semibold truncate text-[#F5F0EB]">{name}</div>
          {email && (
            <div className="font-mono text-[10px] truncate text-[rgba(245,240,235,0.35)]">{email}</div>
          )}
        </div>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5 flex-shrink-0 text-[rgba(245,240,235,0.4)]"
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }}
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
    </div>
  );
}
