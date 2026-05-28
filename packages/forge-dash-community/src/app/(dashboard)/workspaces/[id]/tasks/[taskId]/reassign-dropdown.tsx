'use client';

import { useState } from 'react';
import { Select, SelectItem } from '@heroui/react';
import { reassignTaskAction } from '@/actions/tasks';
import type { HubAgent } from '@/lib/hub';

interface Props {
  workspaceId: string;
  taskId: string;
  currentAgentId: string | null;
  agents: HubAgent[];
}

/** Sentinel key used to represent "return to FM queue" (agentId: null). */
const CLEAR_KEY = '__clear__';

export function ReassignDropdown({ workspaceId, taskId, currentAgentId, agents }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items: { key: string; label: string; isSpecial?: boolean }[] = [
    { key: CLEAR_KEY, label: 'Return to FM queue', isSpecial: true },
    ...agents.map((a) => ({ key: a.name, label: a.name })),
  ];

  async function handleChange(key: string) {
    if (!key) return;
    const agentId = key === CLEAR_KEY ? null : key;
    setLoading(true);
    setError(null);
    const result = await reassignTaskAction(workspaceId, taskId, agentId);
    setLoading(false);
    if (result.error) setError(result.error);
  }

  return (
    <div className="flex flex-col gap-1">
      <Select
        size="sm"
        label="Reassign agent"
        placeholder="Choose agent or clear"
        defaultSelectedKeys={currentAgentId ? [currentAgentId] : []}
        isDisabled={loading}
        onSelectionChange={(keys) => {
          const val = Array.from(keys)[0];
          if (val) handleChange(String(val));
        }}
        className="w-48"
        aria-label="Reassign task to agent"
        items={items}
      >
        {(item) => (
          <SelectItem
            key={item.key}
            className={item.isSpecial ? 'text-default-400' : undefined}
            textValue={item.label}
          >
            {item.label}
          </SelectItem>
        )}
      </Select>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
