#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Daemon } from '../daemon.js';
import { MockRuntime } from '../runtime/mock.js';
import { ClaudeCodeRuntime } from '../runtime/claude-code.js';
import { BackgroundRuntime } from '../runtime/background.js';
import { RuntimeRegistry } from '../runtime/registry.js';
import { loadConfig } from '../config.js';
import { loadBuiltinRegistry } from '@forge-lab/agents';

async function buildLogger(workdir: string) {
  // Write daemon operational logs to context/daemon.log alongside agent logs.
  // This makes daemon events (spawn, claim, complete, errors) visible without
  // needing to tail the daemon process stdout directly.
  const logDir = path.join(workdir, 'context', 'agent-logs');
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, '_daemon.log');
  const fileStream = createWriteStream(logPath, { flags: 'a' });
  fileStream.on('error', (err) => {
    process.stderr.write(`[forge-daemon] daemon log write error: ${err.message}\n`);
  });

  function write(line: string): void {
    const ts = new Date().toISOString();
    const formatted = `${ts} ${line}\n`;
    process.stdout.write(formatted);
    fileStream.write(formatted);
  }

  return {
    info: (msg: string, meta?: Record<string, unknown>): void => {
      write(`[forge-daemon] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`);
    },
    error: (msg: string, meta?: Record<string, unknown>): void => {
      write(`[forge-daemon] ERROR ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`);
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = await buildLogger(config.workdir);
  let personalityRegistry;
  try {
    personalityRegistry = await loadBuiltinRegistry();
  } catch (err) {
    logger.error('failed to load personality registry — falling back to default personality', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Daemon continues without composition; agents get defaultPersonality string.
    personalityRegistry = undefined;
  }
  const runtimes = new RuntimeRegistry();
  runtimes.register(new MockRuntime());
  runtimes.register(new ClaudeCodeRuntime({
    dangerouslySkipPermissions: config.skipPermissions,
    ...(config.model !== undefined && { model: config.model }),
  }));
  // C3: dangerouslySkipPermissions driven by config (FORGE_DAEMON_SKIP_PERMISSIONS env).
  runtimes.register(new BackgroundRuntime({
    dangerouslySkipPermissions: config.skipPermissions,
    ...(config.model !== undefined && { model: config.model }),
  }));

  // C7: log the active runtime and agent so operators notice if the defaults changed.
  logger.info('active default runtime', {
    runtimeId: config.defaultRuntimeId,
    agentId: config.defaultAgentId,
    skipPermissions: config.skipPermissions,
    dispatcherMode: config.dispatcherMode,
    model: config.model ?? '(claude default)',
  });

  const daemon = new Daemon({
    hubUrl: config.hubUrl,
    deviceToken: config.deviceToken,
    workdir: config.workdir,
    runtimes,
    defaultRuntimeId: config.defaultRuntimeId,
    defaultAgentId: config.defaultAgentId,
    defaultAgentIdWasDefaulted: config.defaultAgentIdWasDefaulted,
    ...(personalityRegistry !== undefined && { personalityRegistry }),
    ...(config.workspaceId !== undefined && { workspaceId: config.workspaceId }),
    ...(config.dispatcherMode && { dispatcherMode: true }),
    ...(config.staleTtlMinutes !== undefined && { staleTtlMinutes: config.staleTtlMinutes }),
    ...(config.maxConcurrentTasks !== undefined && { maxConcurrentTasks: config.maxConcurrentTasks }),
    ...(config.authRetryLimit !== undefined && { authRetryLimit: config.authRetryLimit }),
    ...(config.repoUrl !== undefined && { repoUrl: config.repoUrl }),
    ...(config.repoBranch !== undefined && { repoBranch: config.repoBranch }),
    ...(config.gitToken !== undefined && { gitToken: config.gitToken }),
    ...(config.gitUserName !== undefined && { gitUserName: config.gitUserName }),
    ...(config.gitUserEmail !== undefined && { gitUserEmail: config.gitUserEmail }),
    ...(config.dispatcherPersonality !== undefined && { dispatcherPersonality: config.dispatcherPersonality }),
    dispatcherWorkspaceMode: config.dispatcherWorkspaceMode,
    ...(config.fmCooldownMs !== undefined && { fmCooldownMs: config.fmCooldownMs }),
    ...(config.idleShutdownMs !== undefined && { idleShutdownMs: config.idleShutdownMs }),
    ...(config.heartbeatMs !== undefined && { heartbeatMs: config.heartbeatMs }),
    ...(config.maxTaskRuntimeMs !== undefined && { maxTaskRuntimeMs: config.maxTaskRuntimeMs }),
    ...(config.terminalRetryLimit !== undefined && { terminalRetryLimit: config.terminalRetryLimit }),
    logger,
  });

  await daemon.start();

  const shutdown = (): void => {
    const stopTimeout = setTimeout(() => {
      logger.error('daemon stop timed out after 30s — forcing exit');
      process.exit(1);
    }, 30_000);
    void daemon.stop().then(() => {
      clearTimeout(stopTimeout);
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
