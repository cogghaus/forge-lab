'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { HubGoal, HubTask } from '@/lib/hub';
import { TaskList } from '../../task-list';
import { AgentOutputPanel } from '../../_components/agent-output-panel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  tasks: HubTask[];
  workspaceId: string;
  goals?: HubGoal[];
}

// ---------------------------------------------------------------------------
// TaskListWithPanel
// ---------------------------------------------------------------------------

/**
 * Wraps `TaskList` with an `AgentOutputPanel` sidepanel.
 *
 * A log file exists when the daemon has claimed the task (status becomes
 * `in_progress` and `assignedDeviceId` is set). BackgroundRuntime creates the
 * log file at spawn time before any output arrives. Clicking such a task opens
 * the panel and streams the log via SSE.
 *
 * For tasks that have never been claimed (pending, no device assigned), there
 * is no log file; clicking navigates to the task detail page instead to avoid
 * infinite SSE polling against a non-existent file.
 *
 * Clicking another claimable task replaces the stream. The panel close button
 * (×) disconnects the stream and collapses the panel.
 *
 * This component is client-side so it can manage the selected-task state.
 * Data fetching is handled upstream by the (server-side) tasks/page.tsx.
 */

/** Returns true when a log file should exist for this task. */
function hasAgentLog(task: HubTask): boolean {
  // Daemon claimTask sets assignedDeviceId + status=in_progress.
  // assignedAgentId is set by a different path (direct agent assignment),
  // but BackgroundRuntime creates the log at spawn regardless of which
  // field triggered the claim. Use either signal as the gate.
  return task.status === 'in_progress' || task.assignedDeviceId !== null || task.assignedAgentId !== null;
}

export function TaskListWithPanel({ tasks, workspaceId, goals = [] }: Props) {
  const router = useRouter();
  const [selectedTask, setSelectedTask] = useState<HubTask | null>(null);

  function handleTaskClick(task: HubTask): void {
    if (hasAgentLog(task)) {
      // Daemon has claimed / is running — log file exists; open panel.
      setSelectedTask(task);
    } else {
      // Never claimed — no log file; navigate to detail page instead.
      router.push(`/workspaces/${workspaceId}/tasks/${task.id}`);
    }
  }

  return (
    <div className="flex gap-4 items-start">
      {/* Task list — takes all remaining space */}
      <div className="flex-1 min-w-0">
        <TaskList
          tasks={tasks}
          workspaceId={workspaceId}
          goals={goals}
          onTaskClick={handleTaskClick}
        />
      </div>

      {/* Agent output panel — 380 px right rail, visible when a task is selected */}
      <AgentOutputPanel
        taskId={selectedTask?.id ?? null}
        taskTitle={selectedTask?.title ?? null}
        isOpen={selectedTask !== null}
        onClose={() => setSelectedTask(null)}
      />
    </div>
  );
}
