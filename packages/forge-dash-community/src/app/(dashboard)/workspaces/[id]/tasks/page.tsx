import Link from 'next/link';
import { redirect } from 'next/navigation';
import { hubFetch, type HubGoal, type HubTask, type HubWorkspace } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { NewTaskButton } from '../new-task-button';
import { TaskListWithPanel } from './_components/task-list-with-panel';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ goalId?: string; status?: string }>;
}

export default async function WorkspaceTaskListPage({ params, searchParams }: Props) {
  const { id: workspaceId } = await params;
  const { goalId, status } = await searchParams;

  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;

  const [wsRes, tasksRes, goalsRes] = await Promise.all([
    hubFetch<HubWorkspace>(`/workspaces/${workspaceId}`, { cookie: cookieHeader }),
    hubFetch<{ tasks: HubTask[] }>(`/workspaces/${workspaceId}/tasks`, { cookie: cookieHeader }),
    hubFetch<{ goals: HubGoal[] }>(`/workspaces/${workspaceId}/goals`, { cookie: cookieHeader }),
  ]);

  if (!wsRes.ok) redirect('/workspaces');

  const workspace = wsRes.data;
  const allTasks = tasksRes.ok ? tasksRes.data.tasks : [];
  const goals = goalsRes.ok ? goalsRes.data.goals : [];

  // Apply client-side filters (goalId, status)
  let tasks = allTasks;
  if (goalId) tasks = tasks.filter((t) => t.goalId === goalId);
  if (status) tasks = tasks.filter((t) => t.status === status);

  // Resolve goal title for filter label
  const activeGoal = goalId ? goals.find((g) => g.id === goalId) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/workspaces"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Workspaces
        </Link>
        <span className="text-zinc-300 dark:text-zinc-700">/</span>
        <Link
          href={`/workspaces/${workspaceId}`}
          className="min-w-0 truncate text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          {workspace.name}
        </Link>
        <span className="text-zinc-300 dark:text-zinc-700">/</span>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Tasks</h1>
      </div>

      {/* Active filters */}
      {(activeGoal ?? status) && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-500 dark:text-zinc-400">Filtered by:</span>
          {activeGoal && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#FF6B2B]/30 bg-[#FF6B2B]/[0.08] px-2.5 py-1 text-xs font-medium text-[#FF6B2B]">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3" aria-hidden>
                <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" />
              </svg>
              {activeGoal.title}
              <Link
                href={`/workspaces/${workspaceId}/tasks${status ? `?status=${status}` : ''}`}
                className="ml-0.5 inline-flex text-[#FF6B2B]/60 hover:text-[#FF6B2B]"
                title="Clear goal filter"
                aria-label="Clear goal filter"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="h-3 w-3" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
              </Link>
            </span>
          )}
          {status && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-100 px-2.5 py-1 text-xs font-medium capitalize text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
              {status.replace(/_/g, ' ')}
              <Link
                href={`/workspaces/${workspaceId}/tasks${goalId ? `?goalId=${goalId}` : ''}`}
                className="ml-0.5 inline-flex text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                title="Clear status filter"
                aria-label="Clear status filter"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className="h-3 w-3" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
              </Link>
            </span>
          )}
          <Link
            href={`/workspaces/${workspaceId}/tasks`}
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Clear all
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {tasks.length} of {allTasks.length} task{allTasks.length !== 1 ? 's' : ''}
          {tasks.length !== allTasks.length ? ' (filtered)' : ''}
        </p>
        <NewTaskButton workspaceId={workspaceId} workspaceSlug={workspace.slug} goals={goals} />
      </div>

      <TaskListWithPanel tasks={tasks} workspaceId={workspaceId} goals={goals} />
    </div>
  );
}
