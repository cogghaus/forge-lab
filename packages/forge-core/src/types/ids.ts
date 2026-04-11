import { z } from 'zod';

export const TaskIdSchema = z
  .string()
  .regex(/^[a-z]{2,6}-\d{1,6}$/, 'Task ID must be lowercase prefix + dash + digits (e.g. fl-001)');

export type TaskId = z.infer<typeof TaskIdSchema>;

export function formatTaskId(projectPrefix: string, sequence: number): TaskId {
  const prefix = projectPrefix.toLowerCase();
  const padded = sequence.toString().padStart(3, '0');
  const id = `${prefix}-${padded}`;
  return TaskIdSchema.parse(id);
}

export function parseTaskId(id: string): { projectPrefix: string; sequence: number } {
  const parsed = TaskIdSchema.parse(id);
  const dash = parsed.indexOf('-');
  return {
    projectPrefix: parsed.slice(0, dash),
    sequence: parseInt(parsed.slice(dash + 1), 10),
  };
}
