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
      <div className="flex items-center gap-3">
        <Link href="/workspaces" className="text-default-500 hover:text-foreground text-sm">
          Workspaces
        </Link>
        <span className="text-default-400">/</span>
        <Link
          href={`/workspaces/${workspaceId}`}
          className="text-default-500 hover:text-foreground text-sm"
        >
          {workspace.name}
        </Link>
        <span className="text-default-400">/</span>
        <h1 className="text-2xl font-bold">Tasks</h1>
      </div>

      {/* Active filters */}
      {(activeGoal ?? status) && (
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="text-default-400">Filtered by:</span>
          {activeGoal && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20">
              🎯 {activeGoal.title}
              <Link
                href={`/workspaces/${workspaceId}/tasks${status ? `?status=${status}` : ''}`}
                className="ml-1 text-primary/60 hover:text-primary"
                title="Clear goal filter"
              >
                ×
              </Link>
            </span>
          )}
          {status && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-default-100 text-default-700 border border-default-200">
              {status.replace(/_/g, ' ')}
              <Link
                href={`/workspaces/${workspaceId}/tasks${goalId ? `?goalId=${goalId}` : ''}`}
                className="ml-1 text-default-400 hover:text-default-600"
                title="Clear status filter"
              >
                ×
              </Link>
            </span>
          )}
          <Link
            href={`/workspaces/${workspaceId}/tasks`}
            className="text-xs text-default-400 hover:text-foreground"
          >
            Clear all
          </Link>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-default-500">
          {tasks.length} of {allTasks.length} task{allTasks.length !== 1 ? 's' : ''}
          {tasks.length !== allTasks.length ? ' (filtered)' : ''}
        </p>
        <NewTaskButton workspaceId={workspaceId} workspaceSlug={workspace.slug} goals={goals} />
      </div>

      <TaskListWithPanel tasks={tasks} workspaceId={workspaceId} goals={goals} />
    </div>
  );
}
