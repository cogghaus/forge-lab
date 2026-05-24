import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardBody, Chip } from '@heroui/react';
import { hubFetch, type HubGoal, type HubWorkspace } from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { NewGoalButton } from './new-goal-button';
import { GoalStatusButton } from './goal-status-button';

interface Props {
  params: Promise<{ id: string }>;
}

const STATUS_COLOR: Record<string, 'default' | 'primary' | 'success' | 'danger'> = {
  active: 'primary',
  completed: 'success',
  cancelled: 'danger',
};

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

function GoalTree({
  tree,
  parentId,
  workspaceId,
  depth,
}: {
  tree: Map<string | null, HubGoal[]>;
  parentId: string | null;
  workspaceId: string;
  depth: number;
}) {
  const goals = tree.get(parentId) ?? [];
  if (goals.length === 0) return null;

  return (
    <div className={depth > 0 ? 'ml-6 border-l border-default-200 pl-4' : ''}>
      {goals.map((goal) => (
        <div key={goal.id} className="flex flex-col gap-1 mb-3">
          <Card>
            <CardBody className="flex flex-row items-center gap-3 py-3">
              <div className="flex-1 min-w-0">
                <p className={`font-medium ${goal.status !== 'active' ? 'line-through text-default-400' : ''}`}>
                  {goal.title}
                </p>
                {goal.description && (
                  <p className="text-xs text-default-500 truncate mt-0.5">{goal.description}</p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Chip size="sm" variant="flat" color={STATUS_COLOR[goal.status] ?? 'default'}>
                  {goal.status}
                </Chip>
                <GoalStatusButton
                  workspaceId={workspaceId}
                  goalId={goal.id}
                  currentStatus={goal.status}
                />
              </div>
            </CardBody>
          </Card>
          <GoalTree
            tree={tree}
            parentId={goal.id}
            workspaceId={workspaceId}
            depth={depth + 1}
          />
        </div>
      ))}
    </div>
  );
}

export default async function WorkspaceGoalsPage({ params }: Props) {
  const { id: workspaceId } = await params;
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const cookieHeader = `${SESSION_COOKIE}=${session}`;

  const [wsRes, goalsRes] = await Promise.all([
    hubFetch<HubWorkspace>(`/workspaces/${workspaceId}`, { cookie: cookieHeader }),
    hubFetch<{ goals: HubGoal[] }>(`/workspaces/${workspaceId}/goals`, { cookie: cookieHeader }),
  ]);

  if (!wsRes.ok) redirect('/workspaces');

  const workspace = wsRes.data;
  const goals = goalsRes.ok ? goalsRes.data.goals : [];
  const tree = buildTree(goals);

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
        <h1 className="text-2xl font-bold">Goals</h1>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-default-500">
          {goals.length} goal{goals.length !== 1 ? 's' : ''}
        </p>
        <NewGoalButton workspaceId={workspaceId} goals={goals} />
      </div>

      {goals.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center text-default-500">
            No goals yet. Create one to get started.
          </CardBody>
        </Card>
      ) : (
        <GoalTree tree={tree} parentId={null} workspaceId={workspaceId} depth={0} />
      )}
    </div>
  );
}
