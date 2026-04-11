import { z } from 'zod';

export const AgentSchema = z.object({
  id: z.string(),
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
  agentId: z.string(),
  deviceId: z.string(),
  taskId: z.string().nullable(),
  runtimeInstanceId: z.string().nullable(),
  status: AgentInstanceStatusSchema,
  startedAt: z.date(),
  endedAt: z.date().nullable(),
});
export type AgentInstance = z.infer<typeof AgentInstanceSchema>;
