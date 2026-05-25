'use client';

import { useState } from 'react';
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
 * Clicking any task card opens the panel and begins streaming that task's
 * agent log via SSE. Clicking another card replaces the stream. The panel
 * close button (×) disconnects the stream and collapses the panel.
 *
 * This component is client-side so it can manage the selected-task state.
 * Data fetching is handled upstream by the (server-side) tasks/page.tsx.
 */
export function TaskListWithPanel({ tasks, workspaceId, goals = [] }: Props) {
  const [selectedTask, setSelectedTask] = useState<HubTask | null>(null);

  return (
    <div className="flex gap-4 items-start">
      {/* Task list — takes all remaining space */}
      <div className="flex-1 min-w-0">
        <TaskList
          tasks={tasks}
          workspaceId={workspaceId}
          goals={goals}
          onTaskClick={setSelectedTask}
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
