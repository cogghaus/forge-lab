#!/usr/bin/env node
import { createHub } from '../app.js';
import { loadConfig } from '../config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const hub = await createHub({ config });
  await hub.fastify.listen({ port: config.port, host: config.host });
  const shutdown = (): void => {
    void hub.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
