import Link from 'next/link';
import { redirect } from 'next/navigation';
import { hubFetch, type HubGoal, type HubTask, type HubWorkspace } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { NewTaskButton } from './new-task-button';
import { GoalKanban } from './_components/goal-kanban';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function WorkspaceTasksPage({ params }: Props) {
  const { id: workspaceId } = await params;
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
  const tasks = tasksRes.ok ? tasksRes.data.tasks : [];
  const goals = goalsRes.ok ? goalsRes.data.goals : [];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/workspaces" className="text-default-500 hover:text-foreground text-sm">
            Workspaces
          </Link>
          <span className="text-default-400">/</span>
          <h1 className="text-2xl font-bold">{workspace.name}</h1>
        </div>
        <NewTaskButton workspaceId={workspaceId} workspaceSlug={workspace.slug} goals={goals} />
      </div>

      {/* Goal kanban */}
      <GoalKanban tasks={tasks} goals={goals} workspaceId={workspaceId} />

      {/* Quick links */}
      <div className="flex items-center gap-4 text-sm">
        <Link
          href={`/workspaces/${workspaceId}/tasks`}
          className="text-default-500 hover:text-foreground"
        >
          View all tasks
        </Link>
        <span className="text-default-300">·</span>
        <Link
          href={`/workspaces/${workspaceId}/goals`}
          className="text-default-500 hover:text-foreground"
        >
          View goal tree
        </Link>
      </div>
    </div>
  );
}
