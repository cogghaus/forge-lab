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
 * For tasks with an assigned agent (`assignedAgentId !== null`), clicking the
 * card opens the panel and streams the agent log via SSE. For tasks without
 * an assigned agent, clicking navigates to the task detail page — there is no
 * log file to stream and opening an SSE connection would poll the filesystem
 * indefinitely with no output.
 *
 * Clicking another assigned task replaces the stream. The panel close button
 * (×) disconnects the stream and collapses the panel.
 *
 * This component is client-side so it can manage the selected-task state.
 * Data fetching is handled upstream by the (server-side) tasks/page.tsx.
 */
export function TaskListWithPanel({ tasks, workspaceId, goals = [] }: Props) {
  const router = useRouter();
  const [selectedTask, setSelectedTask] = useState<HubTask | null>(null);

  function handleTaskClick(task: HubTask): void {
    if (task.assignedAgentId !== null) {
      // Agent is (or was) assigned — open panel to stream the log file.
      setSelectedTask(task);
    } else {
      // No agent assigned — no log file exists; navigate to detail page instead.
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
