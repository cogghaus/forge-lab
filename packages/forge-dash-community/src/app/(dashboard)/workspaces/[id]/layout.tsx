import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  hubFetch,
  type HubDevice,
  type HubGoal,
  type HubTask,
  type HubWorkspace,
} from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { NewTaskButton } from './new-task-button';
import { WorkspaceTabs } from './_components/workspace-tabs';

const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;

function countStatus(tasks: HubTask[], statuses: string[]): number {
  return tasks.filter((t) => statuses.includes(t.status)).length;
}

function Stat({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-base font-semibold tabular-nums" style={color ? { color } : undefined}>
        {value}
      </span>
      <span className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</span>
    </div>
  );
}

export default async function WorkspaceLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id: workspaceId } = await params;
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;

  const [wsRes, tasksRes, goalsRes, devicesRes] = await Promise.all([
    hubFetch<HubWorkspace>(`/workspaces/${workspaceId}`, { cookie: cookieHeader }),
    hubFetch<{ tasks: HubTask[] }>(`/workspaces/${workspaceId}/tasks`, { cookie: cookieHeader }),
    hubFetch<{ goals: HubGoal[] }>(`/workspaces/${workspaceId}/goals`, { cookie: cookieHeader }),
    hubFetch<{ devices: HubDevice[] }>('/devices', { cookie: cookieHeader }),
  ]);

  if (!wsRes.ok) redirect('/workspaces');

  const workspace = wsRes.data;
  const tasks = tasksRes.ok ? tasksRes.data.tasks : [];
  const goals = goalsRes.ok ? goalsRes.data.goals : [];
  const devices = devicesRes.ok ? devicesRes.data.devices : [];

  const now = Date.now();
  const activeDevices = devices.filter((d) => d.status !== 'deregistered');
  const onlineAgents = activeDevices.filter(
    (d) => d.lastSeen !== null && now - new Date(d.lastSeen).getTime() < ONLINE_THRESHOLD_MS,
  ).length;
  const activeGoalCount = goals.filter((g) => g.status === 'active').length;

  const stats = {
    active: countStatus(tasks, ['assigned', 'in_progress']),
    pending: countStatus(tasks, ['pending_agent', 'pending_design']),
    review: countStatus(tasks, ['design_review', 'pending_dispatcher_action']),
    done: countStatus(tasks, ['completed']),
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/workspaces"
            className="shrink-0 text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Workspaces
          </Link>
          <span className="shrink-0 text-zinc-300 dark:text-zinc-700">/</span>
          <h1 className="min-w-0 truncate text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            {workspace.name}
          </h1>
        </div>
        <NewTaskButton workspaceId={workspaceId} workspaceSlug={workspace.slug} goals={goals} />
      </div>

      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-x-7 gap-y-2 rounded-lg border border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
        <Stat label="Active" value={stats.active} color="#FF6B2B" />
        <Stat label="Pending" value={stats.pending} />
        <Stat label="Review" value={stats.review} color="#FFB547" />
        <Stat label="Done" value={stats.done} color="#2DD4A0" />
        <span className="h-5 w-px bg-zinc-200 dark:bg-zinc-800" />
        <Stat label={activeGoalCount === 1 ? 'Goal' : 'Goals'} value={activeGoalCount} />
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            {onlineAgents > 0 && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#2DD4A0] opacity-50" />
            )}
            <span
              className="relative inline-flex h-2 w-2 rounded-full"
              style={{ background: onlineAgents > 0 ? '#2DD4A0' : 'rgba(161,161,170,0.4)' }}
            />
          </span>
          <span className="text-base font-semibold tabular-nums">
            {onlineAgents}
            <span className="text-zinc-400 dark:text-zinc-500">/{activeDevices.length}</span>
          </span>
          <span className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">agents</span>
        </div>
      </div>

      {/* Tab rail */}
      <WorkspaceTabs workspaceId={workspaceId} />

      {/* Active view */}
      <div>{children}</div>
    </div>
  );
}
