import type {
  AgentRuntime,
  AgentRuntimeSpawnConfig,
  RuntimeInstance,
} from '@forge-lab/core';

/**
 * Phase 1 stub. The real implementation spawns Claude Code in a Windows Terminal
 * tab per task and captures output via task file handoff. See vibe-forge for the
 * spawn logic to port in Phase 2.
 */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly capabilities = { supportsStreaming: true, supportsTools: true } as const;

  spawn(_config: AgentRuntimeSpawnConfig, _initialPrompt: string): Promise<RuntimeInstance> {
    throw new Error('ClaudeCodeRuntime not yet implemented (Phase 1 stub)');
  }

  sendInstruction(): Promise<void> {
    throw new Error('ClaudeCodeRuntime not yet implemented');
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  isAlive(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
