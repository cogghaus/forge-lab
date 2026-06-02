import { redirect } from 'next/navigation';
import {
  hubFetch,
  type HubActivityEvent,
  type HubAgentPerf,
  type HubAgentPerfResponse,
  type HubDevice,
  type HubGoal,
  type HubTask,
  type HubWorkspace,
} from '@/lib/hub';
import { getSessionCookie, SESSION_COOKIE } from '@/lib/session';
import { GoalKanban } from './_components/goal-kanban';
import { ActivityStreamPanel } from './_components/activity-stream';
import { AgentDetailPanel } from './_components/agent-detail-panel';

export default async function WorkspaceOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ agent?: string }>;
}) {
  const { id: workspaceId } = await params;
  const { agent: selectedAgentId } = await searchParams;
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

  const tasks = tasksRes.ok ? tasksRes.data.tasks : [];
  const goals = goalsRes.ok ? goalsRes.data.goals : [];
  const activity = activityRes.ok ? activityRes.data.activity : [];
  const devices = devicesRes.ok ? devicesRes.data.devices : [];

  const selectedDevice = selectedAgentId
    ? devices.find((d) => d.id === selectedAgentId) ?? null
    : null;

  // 7-day performance for the selected agent's persona (keyed by agentId).
  let selectedPerf: HubAgentPerf | null = null;
  if (selectedDevice?.agentId) {
    const perfRes = await hubFetch<HubAgentPerfResponse>(
      `/agents/performance?workspaceId=${workspaceId}&window=7`,
      { cookie: cookieHeader },
    );
    if (perfRes.ok) {
      selectedPerf = perfRes.data.agents.find((a) => a.agentId === selectedDevice.agentId) ?? null;
    }
  }

  return (
    <div className="flex items-start gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {/* Goal kanban */}
        <GoalKanban tasks={tasks} goals={goals} workspaceId={workspaceId} />

        {/* Activity stream */}
        <ActivityStreamPanel
          activity={activity}
          isLive={tasks.some((t) => t.status === 'in_progress')}
          workspaceId={workspaceId}
          deviceNames={new Map(devices.map((d) => [d.id, d.name]))}
        />
      </div>

      {selectedDevice && (
        <AgentDetailPanel
          workspaceId={workspaceId}
          device={selectedDevice}
          tasks={tasks}
          activity={activity}
          perf={selectedPerf}
        />
      )}
    </div>
  );
}
