import { z } from 'zod';
import { TaskIdSchema } from './ids.js';

export const TaskStatusSchema = z.enum([
  'pending_design',
  'design_review',
  'pending_agent',
  'assigned',
  'in_progress',
  'pending_dispatcher_action',
  'completed',
  'failed',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskSchema = z.object({
  id: TaskIdSchema,
  workspaceId: z.string().nullable(),
  projectPrefix: z.string().min(2).max(6).regex(/^[a-z0-9]+$/, 'projectPrefix must be lowercase alphanumeric'),
  title: z.string().min(1).max(500),
  description: z.string().nullable(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  assignedDeviceId: z.string().nullable(),
  assignedAgentId: z.string().nullable(),
  /** When FM wrote assignedAgentId. Used to detect and clear stale assignments. */
  assignedAt: z.date().nullable(),
  parentId: z.string().nullable(),
  goalId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskInputSchema = z.object({
  projectPrefix: z.string().min(2).max(6).regex(/^[a-z0-9]+$/, 'projectPrefix must be lowercase alphanumeric'),
  title: z.string().min(1).max(500),
  description: z.string().nullable().optional(),
  priority: TaskPrioritySchema.optional(),
  goalId: z.string().nullable().optional(),
  /** Parent task ID — for FM decomposition. Parent must exist (validated at route level). */
  parentId: z.string().nullable().optional(),
  /**
   * Workspace the task belongs to. Accepted by the flat POST /tasks endpoint when
   * the caller is a device (device tokens are workspace-owner-provisioned and semi-trusted).
   * Ignored by the workspace-scoped POST /workspaces/:id/tasks (workspace comes from route param).
   */
  workspaceId: z.string().nullable().optional(),
  /**
   * Logical agent that should handle this task. When set, the task is pre-assigned
   * so only a daemon with a matching agentId will claim it. Used by reactive agents
   * (e.g. Scribe) that self-create follow-up tasks and want guaranteed routing.
   */
  assignedAgentId: z.string().nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const UpdateTaskStatusInputSchema = z.object({
  status: TaskStatusSchema,
});
export type UpdateTaskStatusInput = z.infer<typeof UpdateTaskStatusInputSchema>;
