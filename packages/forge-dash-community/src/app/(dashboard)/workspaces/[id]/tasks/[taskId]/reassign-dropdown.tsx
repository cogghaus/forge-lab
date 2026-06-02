'use client';

import { useState } from 'react';
import { reassignTaskAction } from '@/actions/tasks';
import { fieldClass } from '@/lib/form-ui';
import type { HubAgent } from '@/lib/hub';

interface Props {
  workspaceId: string;
  taskId: string;
  currentAgentId: string | null;
  agents: HubAgent[];
}

/** Sentinel value for "return to FM queue" (agentId: null). */
const CLEAR_KEY = '__clear__';

export function ReassignDropdown({ workspaceId, taskId, currentAgentId, agents }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matchedKey = currentAgentId && agents.some((a) => a.name === currentAgentId)
    ? currentAgentId
    : '';

  async function handleChange(value: string) {
    if (!value) return;
    const agentId = value === CLEAR_KEY ? null : value;
    setLoading(true);
    setError(null);
    const result = await reassignTaskAction(workspaceId, taskId, agentId);
    setLoading(false);
    if (result.error) setError(result.error);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="reassign-agent" className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
        Reassign agent
        {currentAgentId && !matchedKey && (
          <span className="ml-2 text-zinc-400 dark:text-zinc-500">current: {currentAgentId}</span>
        )}
      </label>
      <select
        id="reassign-agent"
        defaultValue={matchedKey}
        disabled={loading}
        onChange={(e) => { void handleChange(e.target.value); }}
        className={`${fieldClass(false)} w-56`}
        aria-label="Reassign task to agent"
      >
        <option value="" disabled>
          Choose agent or clear
        </option>
        <option value={CLEAR_KEY}>Return to FM queue</option>
        {agents.map((a) => (
          <option key={a.id} value={a.name}>
            {a.name}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
