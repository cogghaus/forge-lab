import Link from 'next/link';
import { redirect } from 'next/navigation';
import { hubFetch, type HubGoal, type HubTask, type HubWorkspace } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { NewGoalButton } from './new-goal-button';
import { GoalStatusButton } from './goal-status-button';

interface Props {
  params: Promise<{ id: string }>;
}

const STATUS_HEX: Record<string, string> = {
  active: '#FF6B2B',
  completed: '#2DD4A0',
  cancelled: '#FF4757',
};

function statusHex(s: string): string {
  return STATUS_HEX[s] ?? '#a1a1aa';
}

function buildTree(goals: HubGoal[]): Map<string | null, HubGoal[]> {
  const map = new Map<string | null, HubGoal[]>();
  for (const goal of goals) {
    const key = goal.parentId ?? null;
    const bucket = map.get(key) ?? [];
    bucket.push(goal);
    map.set(key, bucket);
  }
  return map;
}

function buildTaskCounts(tasks: HubTask[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.goalId) {
      counts.set(task.goalId, (counts.get(task.goalId) ?? 0) + 1);
    }
  }
  return counts;
}

function GoalTree({
  tree,
  parentId,
  workspaceId,
  depth,
  visited,
  taskCounts,
}: {
  tree: Map<string | null, HubGoal[]>;
  parentId: string | null;
  workspaceId: string;
  depth: number;
  visited: Set<string>;
  taskCounts: Map<string, number>;
}) {
  const goals = tree.get(parentId) ?? [];
  if (goals.length === 0) return null;

  return (
    <div className={depth > 0 ? 'ml-6 border-l border-zinc-200 pl-4 dark:border-zinc-800' : ''}>
      {goals.map((goal) => {
        if (visited.has(goal.id)) return null;
        const nextVisited = new Set(visited);
        nextVisited.add(goal.id);
        const taskCount = taskCounts.get(goal.id) ?? 0;
        const accent = statusHex(goal.status);
        return (
          <div key={goal.id} className="mb-3 flex flex-col gap-1">
            <div className="relative flex flex-row items-center gap-3 overflow-hidden rounded-xl border border-zinc-200 bg-white py-3 pl-5 pr-4 dark:border-zinc-800 dark:bg-zinc-900/70">
              <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: accent }} aria-hidden />
              <div className="min-w-0 flex-1">
                <p
                  className={`font-medium ${
                    goal.status !== 'active'
                      ? 'text-zinc-400 line-through dark:text-zinc-500'
                      : 'text-zinc-900 dark:text-zinc-100'
                  }`}
                >
                  {goal.title}
                </p>
                {goal.description && (
                  <p className="mt-0.5 truncate text-xs text-zinc-500 dark:text-zinc-400">{goal.description}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {taskCount > 0 && (
                  <Link
                    href={`/workspaces/${workspaceId}/tasks?goalId=${goal.id}`}
                    className="text-xs text-zinc-500 hover:text-[#FF6B2B] dark:text-zinc-400"
                  >
                    {taskCount} task{taskCount !== 1 ? 's' : ''}
                  </Link>
                )}
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-[10px] capitalize"
                  style={{ color: accent, background: `${accent}1f` }}
                >
                  {goal.status}
                </span>
                <GoalStatusButton
                  workspaceId={workspaceId}
                  goalId={goal.id}
                  currentStatus={goal.status}
                />
              </div>
            </div>
            <GoalTree
              tree={tree}
              parentId={goal.id}
              workspaceId={workspaceId}
              depth={depth + 1}
              visited={nextVisited}
              taskCounts={taskCounts}
            />
          </div>
        );
      })}
    </div>
  );
}

export default async function WorkspaceGoalsPage({ params }: Props) {
  const { id: workspaceId } = await params;
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;

  const [wsRes, goalsRes, tasksRes] = await Promise.all([
    hubFetch<HubWorkspace>(`/workspaces/${workspaceId}`, { cookie: cookieHeader }),
    hubFetch<{ goals: HubGoal[] }>(`/workspaces/${workspaceId}/goals`, { cookie: cookieHeader }),
    hubFetch<{ tasks: HubTask[] }>(`/workspaces/${workspaceId}/tasks`, { cookie: cookieHeader }),
  ]);

  if (!wsRes.ok) redirect('/workspaces');

  const workspace = wsRes.data;
  const goals = goalsRes.ok ? goalsRes.data.goals : [];
  const tasks = tasksRes.ok ? tasksRes.data.tasks : [];
  const tree = buildTree(goals);
  const taskCounts = buildTaskCounts(tasks);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {goals.length} goal{goals.length !== 1 ? 's' : ''}
        </p>
        <NewGoalButton workspaceId={workspaceId} goals={goals} />
      </div>

      {goals.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-zinc-300 px-6 py-14 text-center dark:border-zinc-700/80">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#FF6B2B]/10 text-[#FF6B2B]">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6" aria-hidden>
              <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" />
            </svg>
          </span>
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">No goals yet</h3>
            <p className="mx-auto max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
              Goals group tasks into milestones and track progress toward outcomes for{' '}
              <span className="font-medium text-zinc-700 dark:text-zinc-200">{workspace.name}</span>.
            </p>
          </div>
          <NewGoalButton workspaceId={workspaceId} goals={[]} />
        </div>
      ) : (
        <GoalTree
          tree={tree}
          parentId={null}
          workspaceId={workspaceId}
          depth={0}
          visited={new Set()}
          taskCounts={taskCounts}
        />
      )}
    </div>
  );
}
