export type RuntimeId = string;

export interface AgentRuntimeCapabilities {
  readonly supportsStreaming: boolean;
  readonly supportsTools: boolean;
}

export interface RuntimeInstance {
  readonly id: string;
  readonly runtimeId: RuntimeId;
  readonly agentId: string;
  readonly pid: number | null;
  readonly startedAt: Date;
  readonly metadata: Record<string, unknown>;
}

export interface AgentRuntimeSpawnConfig {
  readonly agentId: string;
  readonly personality: string;
  readonly workdir: string;
  readonly taskId: string | null;
  readonly config: Record<string, unknown>;
}

/**
 * Runtime abstraction decouples the agent concept from the LLM backend.
 * See "Agent Runtime Abstraction" in the architecture note.
 */
export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly displayName: string;
  readonly capabilities: AgentRuntimeCapabilities;

  spawn(config: AgentRuntimeSpawnConfig, initialPrompt: string): Promise<RuntimeInstance>;
  sendInstruction(instance: RuntimeInstance, text: string): Promise<void>;
  stop(instance: RuntimeInstance): Promise<void>;
  isAlive(instance: RuntimeInstance): Promise<boolean>;
}
