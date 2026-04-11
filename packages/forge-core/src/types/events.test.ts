import { describe, it, expect } from 'vitest';
import { EventNameSchema, EventEnvelopeSchema } from './events.js';

describe('EventNameSchema', () => {
  it('accepts known event names from all taxonomies', () => {
    expect(EventNameSchema.parse('task.created')).toBe('task.created');
    expect(EventNameSchema.parse('agent.spawned')).toBe('agent.spawned');
    expect(EventNameSchema.parse('dispatcher.operation_requested')).toBe(
      'dispatcher.operation_requested',
    );
    expect(EventNameSchema.parse('instruction.created')).toBe('instruction.created');
    expect(EventNameSchema.parse('design.approved')).toBe('design.approved');
  });

  it('rejects unknown event names', () => {
    expect(() => EventNameSchema.parse('bogus.event')).toThrow();
    expect(() => EventNameSchema.parse('task.nonsense')).toThrow();
  });
});

describe('EventEnvelopeSchema', () => {
  it('parses a valid envelope', () => {
    const env = EventEnvelopeSchema.parse({
      id: 'evt-1',
      name: 'task.created',
      occurredAt: new Date(),
      source: 'hub',
      payload: { taskId: 'fl-001' },
    });
    expect(env.name).toBe('task.created');
  });
});
