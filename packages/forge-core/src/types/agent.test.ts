import { describe, it, expect } from 'vitest';
import { AgentSchema, AgentInstanceSchema, AgentInstanceStatusSchema } from './agent.js';

const baseAgent = {
  id: 'agent-1',
  workspaceId: null,
  name: 'Anvil',
  personality: 'You are a frontend developer.',
  runtimeId: 'claude-code',
  config: {},
  createdAt: new Date(),
};

describe('AgentSchema', () => {
  it('parses a valid agent with null workspaceId', () => {
    const agent = AgentSchema.parse(baseAgent);
    expect(agent.id).toBe('agent-1');
    expect(agent.workspaceId).toBeNull();
  });

  it('parses a valid agent with a workspaceId', () => {
    const agent = AgentSchema.parse({ ...baseAgent, workspaceId: 'ws-abc' });
    expect(agent.workspaceId).toBe('ws-abc');
  });

  it('rejects empty name', () => {
    expect(() => AgentSchema.parse({ ...baseAgent, name: '' })).toThrow();
  });

  it('rejects name over 100 chars', () => {
    expect(() => AgentSchema.parse({ ...baseAgent, name: 'a'.repeat(101) })).toThrow();
  });
});

describe('AgentInstanceSchema', () => {
  const baseInstance = {
    id: 'inst-1',
    workspaceId: null,
    agentId: 'agent-1',
    deviceId: 'device-1',
    taskId: null,
    runtimeInstanceId: null,
    status: 'idle' as const,
    startedAt: new Date(),
    endedAt: null,
  };

  it('parses a valid instance with null workspaceId', () => {
    const inst = AgentInstanceSchema.parse(baseInstance);
    expect(inst.workspaceId).toBeNull();
  });

  it('parses a valid instance with a workspaceId', () => {
    const inst = AgentInstanceSchema.parse({ ...baseInstance, workspaceId: 'ws-abc' });
    expect(inst.workspaceId).toBe('ws-abc');
  });

  it('rejects unknown status', () => {
    expect(() =>
      AgentInstanceSchema.parse({ ...baseInstance, status: 'exploding' }),
    ).toThrow();
  });
});

describe('AgentInstanceStatusSchema', () => {
  it('accepts all valid statuses', () => {
    for (const s of ['spawning', 'running', 'idle', 'stopping', 'stopped', 'crashed'] as const) {
      expect(() => AgentInstanceStatusSchema.parse(s)).not.toThrow();
    }
  });

  it('rejects unknown status', () => {
    expect(() => AgentInstanceStatusSchema.parse('paused')).toThrow();
  });
});
