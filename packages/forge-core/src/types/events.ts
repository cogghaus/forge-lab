import { z } from 'zod';

export const TaskEventNameSchema = z.enum([
  'task.created',
  'task.updated',
  'task.assigned',
  'task.claimed',
  'task.started',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.requeued',
]);
export type TaskEventName = z.infer<typeof TaskEventNameSchema>;

export const AgentEventNameSchema = z.enum([
  'agent.spawned',
  'agent.started',
  'agent.stopped',
  'agent.crashed',
  'agent.heartbeat',
]);
export type AgentEventName = z.infer<typeof AgentEventNameSchema>;

export const DispatcherEventNameSchema = z.enum([
  'dispatcher.operation_requested',
  'dispatcher.operation_applied',
  'dispatcher.operation_failed',
]);
export type DispatcherEventName = z.infer<typeof DispatcherEventNameSchema>;

export const InstructionEventNameSchema = z.enum([
  'instruction.created',
  'instruction.acknowledged',
  'instruction.timeout',
  'instruction.conflicted',
]);
export type InstructionEventName = z.infer<typeof InstructionEventNameSchema>;

export const DesignEventNameSchema = z.enum([
  'design.requested',
  'design.drafted',
  'design.approved',
  'design.rejected',
]);
export type DesignEventName = z.infer<typeof DesignEventNameSchema>;

export const EventNameSchema = z.union([
  TaskEventNameSchema,
  AgentEventNameSchema,
  DispatcherEventNameSchema,
  InstructionEventNameSchema,
  DesignEventNameSchema,
]);
export type EventName = z.infer<typeof EventNameSchema>;

export const EventEnvelopeSchema = z.object({
  id: z.string(),
  name: EventNameSchema,
  occurredAt: z.date(),
  source: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
