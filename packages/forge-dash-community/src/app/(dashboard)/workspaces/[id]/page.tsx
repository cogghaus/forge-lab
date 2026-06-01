import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  hubFetch,
  type HubActivityEvent,
  type HubDevice,
  type HubGoal,
  type HubTask,
  type HubWorkspace,
} from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { NewTaskButton } from './new-task-button';
import { GoalKanban } from './_components/goal-kanban';
import { ActivityStreamPanel } from './_components/activity-stream';
import { DevicesPanel } from './_components/devices-panel';

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

export default async function WorkspaceTasksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;

  const [wsRes, tasksRes, goalsRes, activityRes, devicesRes] = await Promise.all([
    hubFetch<HubWorkspace>(`/workspaces/${workspaceId}`, { cookie: cookieHeader }),
    hubFetch<{ tasks: HubTask[] }>(`/workspaces/${workspaceId}/tasks`, { cookie: cookieHeader }),
    hubFetch<{ goals: HubGoal[] }>(`/workspaces/${workspaceId}/goals`, { cookie: cookieHeader }),
    hubFetch<{ activity: HubActivityEvent[] }>(`/workspaces/${workspaceId}/activity`, { cookie: cookieHeader }),
    hubFetch<{ devices: HubDevice[] }>('/devices', { cookie: cookieHeader }),
  ]);

  if (!wsRes.ok) redirect('/workspaces');

  const workspace = wsRes.data;
  const tasks = tasksRes.ok ? tasksRes.data.tasks : [];
  const goals = goalsRes.ok ? goalsRes.data.goals : [];
  const activity = activityRes.ok ? activityRes.data.activity : [];
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
    <div className="flex flex-col gap-6">
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

      {/* Stat strip */}
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
          <span className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            agents
          </span>
        </div>
      </div>

      {/* Goal kanban */}
      <GoalKanban tasks={tasks} goals={goals} workspaceId={workspaceId} />

      {/* Activity stream + Devices panels — collapses to one column on small screens */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_260px]">
        <ActivityStreamPanel
          activity={activity}
          isLive={tasks.some((t) => t.status === 'in_progress')}
          workspaceId={workspaceId}
          deviceNames={new Map(devices.map((d) => [d.id, d.name]))}
        />
        <DevicesPanel
          devices={devices}
          queueDepth={tasks.filter((t) => t.status === 'pending_agent').length}
        />
      </div>

      {/* Secondary navigation */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/workspaces/${workspaceId}/tasks`}
          className="inline-flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:border-[#FF6B2B]/50 hover:text-[#FF6B2B] dark:border-zinc-800 dark:text-zinc-200"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
          All tasks
        </Link>
        <Link
          href={`/workspaces/${workspaceId}/goals`}
          className="inline-flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:border-[#FF6B2B]/50 hover:text-[#FF6B2B] dark:border-zinc-800 dark:text-zinc-200"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="5" />
            <circle cx="12" cy="12" r="1" />
          </svg>
          Goal tree
        </Link>
      </div>
    </div>
  );
}
