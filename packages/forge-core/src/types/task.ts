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
  projectPrefix: z.string().min(2).max(6),
  title: z.string().min(1).max(500),
  description: z.string().nullable(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  assignedDeviceId: z.string().nullable(),
  assignedAgentId: z.string().nullable(),
  /** When FM wrote assignedAgentId. Used to detect and clear stale assignments. */
  /** When FM wrote assignedAgentId. Used to detect and clear stale assignments. */
  assignedAt: z.date().nullable().optional(),
  createdBy: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskInputSchema = z.object({
  projectPrefix: z.string().min(2).max(6),
  title: z.string().min(1).max(500),
  description: z.string().nullable().optional(),
  priority: TaskPrioritySchema.optional(),
  goalId: z.string().nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const UpdateTaskStatusInputSchema = z.object({
  status: TaskStatusSchema,
});
export type UpdateTaskStatusInput = z.infer<typeof UpdateTaskStatusInputSchema>;
