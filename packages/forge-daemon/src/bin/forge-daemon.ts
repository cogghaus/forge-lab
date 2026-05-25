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
  const runtimes = new RuntimeRegistry();
  runtimes.register(new MockRuntime());
  runtimes.register(new ClaudeCodeRuntime());
  // C3: dangerouslySkipPermissions driven by config (FORGE_DAEMON_SKIP_PERMISSIONS env).
  runtimes.register(new BackgroundRuntime({ dangerouslySkipPermissions: config.skipPermissions }));

  // C7: log the active runtime so operators notice if the default changed.
  logger.info('active default runtime', { runtimeId: config.defaultRuntimeId, skipPermissions: config.skipPermissions });

  const daemon = new Daemon({
    hubUrl: config.hubUrl,
    deviceToken: config.deviceToken,
    workdir: config.workdir,
    runtimes,
    defaultRuntimeId: config.defaultRuntimeId,
    logger,
  });

  await daemon.start();

  const shutdown = (): void => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
