import { describe, it, expect } from 'vitest';
import { AgentPersonalitySchema, PersonalityRegistry } from './personality.js';

describe('AgentPersonalitySchema', () => {
  it('parses a minimal personality', () => {
    const p = AgentPersonalitySchema.parse({
      id: 'rust-specialist',
      name: 'Rust Specialist',
      systemPrompt: 'You are a Rust expert.',
    });
    expect(p.id).toBe('rust-specialist');
    expect(p.tags).toEqual([]);
    expect(p.preferredTools).toEqual([]);
  });

  it('rejects missing system prompt', () => {
    expect(() =>
      AgentPersonalitySchema.parse({
        id: 'x',
        name: 'x',
        systemPrompt: '',
      }),
    ).toThrow();
  });
});

describe('PersonalityRegistry', () => {
  it('registers and retrieves personalities', () => {
    const reg = new PersonalityRegistry();
    const p = AgentPersonalitySchema.parse({
      id: 'default',
      name: 'Default',
      systemPrompt: 'You are helpful.',
    });
    reg.register(p);
    expect(reg.has('default')).toBe(true);
    expect(reg.get('default')?.name).toBe('Default');
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('nonexistent')).toBeNull();
  });
});
