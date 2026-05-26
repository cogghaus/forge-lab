import { describe, it, expect } from 'vitest';
import { TaskSchema, TaskStatusSchema, CreateTaskInputSchema } from './task.js';

describe('TaskSchema', () => {
  it('parses a valid task', () => {
    const now = new Date();
    const task = TaskSchema.parse({
      id: 'fl-001',
      workspaceId: null,
      projectPrefix: 'fl',
      title: 'Scaffold monorepo',
      description: null,
      status: 'pending_agent',
      priority: 'normal',
      assignedDeviceId: null,
      assignedAgentId: null,
      assignedAt: null,
      parentId: null,
      goalId: null,
      createdBy: 'user-1',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    expect(task.id).toBe('fl-001');
    expect(task.status).toBe('pending_agent');
  });

  it('rejects unknown status', () => {
    expect(() => TaskStatusSchema.parse('bogus')).toThrow();
  });

  it('rejects empty title', () => {
    expect(() =>
      TaskSchema.parse({
        id: 'fl-001',
        workspaceId: null,
        projectPrefix: 'fl',
        title: '',
        description: null,
        status: 'pending_agent',
        priority: 'normal',
        assignedDeviceId: null,
        assignedAgentId: null,
        assignedAt: null,
        parentId: null,
        goalId: null,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      }),
    ).toThrow();
  });
});

describe('CreateTaskInputSchema', () => {
  it('accepts minimal input', () => {
    const input = CreateTaskInputSchema.parse({
      projectPrefix: 'fl',
      title: 'Add auth',
    });
    expect(input.title).toBe('Add auth');
    expect(input.priority).toBeUndefined();
  });

  it('rejects projectPrefix with special characters', () => {
    expect(() => CreateTaskInputSchema.parse({ projectPrefix: 'a!', title: 'Bad prefix' })).toThrow();
  });

  it('rejects projectPrefix with spaces', () => {
    expect(() => CreateTaskInputSchema.parse({ projectPrefix: 'a b', title: 'Space prefix' })).toThrow();
  });

  it('rejects uppercase projectPrefix', () => {
    expect(() => CreateTaskInputSchema.parse({ projectPrefix: 'FL', title: 'Upper prefix' })).toThrow();
  });

  it('rejects projectPrefix shorter than 2 chars', () => {
    expect(() => CreateTaskInputSchema.parse({ projectPrefix: 'a', title: 'Short prefix' })).toThrow();
  });

  it('accepts full input', () => {
    const input = CreateTaskInputSchema.parse({
      projectPrefix: 'fl',
      title: 'Add auth',
      description: 'Use bcrypt',
      priority: 'high',
    });
    expect(input.priority).toBe('high');
  });
});
