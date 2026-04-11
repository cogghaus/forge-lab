import type { EventEnvelope } from '@forge-lab/core';

export type EventListener = (env: EventEnvelope) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  emit(env: EventEnvelope): void {
    for (const listener of this.listeners) {
      try {
        listener(env);
      } catch {
        // listeners must not throw; swallow
      }
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get size(): number {
    return this.listeners.size;
  }
}
