import { z } from 'zod';

export const AgentPersonalitySchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  description: z.string().default(''),
  systemPrompt: z.string().min(1),
  tags: z.array(z.string()).default([]),
  preferredTools: z.array(z.string()).default([]),
  runtimeHints: z.record(z.string(), z.unknown()).default({}),
});

export type AgentPersonality = z.infer<typeof AgentPersonalitySchema>;

export class PersonalityRegistry {
  private readonly entries = new Map<string, AgentPersonality>();

  register(p: AgentPersonality): void {
    this.entries.set(p.id, p);
  }

  get(id: string): AgentPersonality | null {
    return this.entries.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): AgentPersonality[] {
    return Array.from(this.entries.values());
  }
}
