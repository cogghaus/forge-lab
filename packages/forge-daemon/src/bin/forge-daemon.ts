#!/usr/bin/env node
import { Daemon } from '../daemon.js';
import { MockRuntime } from '../runtime/mock.js';
import { ClaudeCodeRuntime } from '../runtime/claude-code.js';
import { BackgroundRuntime } from '../runtime/background.js';
import { RuntimeRegistry } from '../runtime/registry.js';
import { loadConfig } from '../config.js';

const consoleLogger = {
  info: (msg: string, meta?: Record<string, unknown>): void => {
    process.stdout.write(`[forge-daemon] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`);
  },
  error: (msg: string, meta?: Record<string, unknown>): void => {
    process.stderr.write(`[forge-daemon] ERROR ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`);
  },
};

async function main(): Promise<void> {
  const config = loadConfig();
  const runtimes = new RuntimeRegistry();
  runtimes.register(new MockRuntime());
  runtimes.register(new ClaudeCodeRuntime());
  runtimes.register(new BackgroundRuntime({ dangerouslySkipPermissions: true }));

  const daemon = new Daemon({
    hubUrl: config.hubUrl,
    deviceToken: config.deviceToken,
    workdir: config.workdir,
    runtimes,
    defaultRuntimeId: config.defaultRuntimeId,
    logger: consoleLogger,
  });

  await daemon.start();

  const shutdown = (): void => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
