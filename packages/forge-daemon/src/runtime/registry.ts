import type { AgentRuntime } from '@forge-lab/core';

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, AgentRuntime>();

  register(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.id, runtime);
  }

  get(id: string): AgentRuntime {
    const r = this.runtimes.get(id);
    if (!r) throw new Error(`Unknown runtime: ${id}`);
    return r;
  }

  has(id: string): boolean {
    return this.runtimes.has(id);
  }

  list(): AgentRuntime[] {
    return Array.from(this.runtimes.values());
  }
}
