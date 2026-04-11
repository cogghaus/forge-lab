import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import { openDatabase, type Db, type DbHandle } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import type { HubConfig } from './config.js';
import { populateAuth } from './auth/middleware.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWsRoutes } from './routes/ws.js';
import { EventBus } from './events/bus.js';

export interface Hub {
  fastify: FastifyInstance;
  db: Db;
  bus: EventBus;
  config: HubConfig;
  close(): Promise<void>;
}

export async function createHub(options: { config: HubConfig }): Promise<Hub> {
  const { config } = options;
  const handle: DbHandle = openDatabase(config.databaseUrl);
  await runMigrations(handle.raw);

  const bus = new EventBus();

  const fastify = Fastify({
    logger: { level: process.env['NODE_ENV'] === 'test' ? 'warn' : 'info' },
  });

  await fastify.register(cookie, { secret: config.sessionSecret });
  await fastify.register(websocket);
  fastify.addHook('onRequest', populateAuth(handle.db));

  fastify.get('/healthz', () => ({ status: 'ok' }));

  await fastify.register((scope) => {
    registerAuthRoutes(scope, handle.db, config);
    registerDeviceRoutes(scope, handle.db);
    registerTaskRoutes(scope, handle.db, bus);
    registerWsRoutes(scope, handle.db, bus);
    return Promise.resolve();
  });

  await fastify.ready();

  return {
    fastify,
    db: handle.db,
    bus,
    config,
    close: async () => {
      await fastify.close();
      handle.close();
    },
  };
}
