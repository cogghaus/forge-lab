import { z } from 'zod';

/**
 * Default agent roster seeded into every new workspace (ADR-004 fleet).
 * Personality NAMES are the canonical agent identifier domain: daemons claim
 * tasks using FORGE_DAEMON_AGENT_ID set to one of these names.
 *
 * NOTE: this list duplicates the personality roster shipped in
 * packages/forge-agents/personalities. Single-sourcing the roster is tracked
 * as issue 21; until then keep the two in sync.
 */
export const DEFAULT_WORKSPACE_AGENT_ROSTER = [
  'architect',
  'furnace',
  'anvil',
  'crucible',
  'oracle',
  'scribe',
  'herald',
  'temper',
  'aegis',
] as const;

export const AgentSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  name: z.string().min(1).max(100),
  personality: z.string(),
  runtimeId: z.string(),
  config: z.record(z.string(), z.unknown()),
  createdAt: z.date(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const AgentInstanceStatusSchema = z.enum([
  'spawning',
  'running',
  'idle',
  'stopping',
  'stopped',
  'crashed',
]);
export type AgentInstanceStatus = z.infer<typeof AgentInstanceStatusSchema>;

export const AgentInstanceSchema = z.object({
  id: z.string(),
  workspaceId: z.string().nullable(),
  agentId: z.string(),
  deviceId: z.string(),
  taskId: z.string().nullable(),
  runtimeInstanceId: z.string().nullable(),
  status: AgentInstanceStatusSchema,
  startedAt: z.date(),
  endedAt: z.date().nullable(),
});
export type AgentInstance = z.infer<typeof AgentInstanceSchema>;
