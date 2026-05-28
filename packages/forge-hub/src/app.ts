import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { openDatabase, type Db, type DbHandle } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import type { HubConfig } from './config.js';
import { populateAuth } from './auth/middleware.js';
import { registerAuthRoutes } from './routes/auth.js';
import { TokenBucketStore } from './rate-limit/index.js';
import { registerDeviceRoutes, type DeviceRouteHandles } from './routes/devices.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerAgentInstanceRoutes } from './routes/agent-instances.js';
import { registerRuntimeConfigRoutes } from './routes/runtime-configs.js';
import { registerInstructionRoutes } from './routes/instructions.js';
import { registerCommentRoutes } from './routes/comments.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerDocsRoutes } from './routes/docs.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerGoalRoutes } from './routes/goals.js';
import { registerWsRoutes } from './routes/ws.js';
import { registerEventsRoutes } from './routes/events.js';
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
  const authRateLimitStore = new TokenBucketStore();
  let deviceRouteHandles: DeviceRouteHandles | undefined;
  const handle: DbHandle = openDatabase(config.databaseUrl);
  await runMigrations(handle.raw);

  const bus = new EventBus();

  const fastify = Fastify({
    logger: { level: process.env['NODE_ENV'] === 'test' ? 'warn' : 'info' },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  fastify.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_input', issues: error.issues });
    }
    fastify.log.error(error);
    return reply.code(500).send({ error: 'internal_server_error' });
  });

  if (process.env['NODE_ENV'] !== 'test') {
    await fastify.register(rateLimit, {
      global: true,
      max: 100,
      timeWindow: '1 minute',
    });
  }

  await fastify.register(cookie, { secret: config.sessionSecret });
  await fastify.register(websocket);
  fastify.addHook('onRequest', populateAuth(handle.db));
  fastify.addHook('onRequest', async (req) => {
    const runId = req.headers['x-forge-run-id'];
    if (typeof runId === 'string' && runId.length > 0) {
      req.runId = runId;
    }
  });

  fastify.get('/healthz', () => ({ status: 'ok' }));

  await fastify.register((scope) => {
    registerAuthRoutes(scope, handle.db, config, authRateLimitStore);
    deviceRouteHandles = registerDeviceRoutes(scope, handle.db);
    registerTaskRoutes(scope, handle.db, bus);
    registerAgentRoutes(scope, handle.db);
    registerAgentInstanceRoutes(scope, handle.db);
    registerRuntimeConfigRoutes(scope, handle.db);
    registerInstructionRoutes(scope, handle.db);
    registerCommentRoutes(scope, handle.db);
    registerWorkspaceRoutes(scope, handle.db);
    registerDocsRoutes(scope, handle.db);
    registerInviteRoutes(scope, handle.db, config);
    registerGoalRoutes(scope, handle.db);
    registerWsRoutes(scope, handle.db, bus);
    registerEventsRoutes(scope, handle.db, bus);
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
      authRateLimitStore.destroy();
      deviceRouteHandles?.destroy();
    },
  };
}
