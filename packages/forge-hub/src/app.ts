import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { openDatabase, type Db, type DbHandle } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import {
  type HubConfig,
  resolveTaskLeaseSeconds,
  resolveReclaimSweepSeconds,
  resolveTaskMaxReclaims,
} from './config.js';
import { populateAuth } from './auth/middleware.js';
import { pruneExpiredSessionsGlobal } from './auth/sessions.js';
import { registerAuthRoutes } from './routes/auth.js';
import { TokenBucketStore } from './rate-limit/index.js';
import { createEmailService, type EmailService } from './email/index.js';
import { registerDeviceRoutes, type DeviceRouteHandles } from './routes/devices.js';
import { registerTaskRoutes, sweepExpiredLeases } from './routes/tasks.js';
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
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerPolicyRuleRoutes } from './routes/policy-rules.js';
import { registerWorkspaceContextRoutes } from './routes/workspace-context.js';
import { registerWakerRoutes } from './routes/waker.js';
import { EventBus } from './events/bus.js';

export interface Hub {
  fastify: FastifyInstance;
  db: Db;
  bus: EventBus;
  config: HubConfig;
  emailService?: EmailService;
  close(): Promise<void>;
}

/**
 * Issue 15: fail fast when the hub would silently run on a volatile in-memory
 * database. `:memory:` is the schema default so tests keep working with no
 * config at all, and that same default is exactly the trap in production: an
 * unset FORGE_HUB_DATABASE_URL loses everything on restart with no warning.
 *
 * Lives here (the real boot path shared by bin/forge-hub.ts and createHub),
 * not in config.ts's loadConfig, so unit tests of config parsing stay green
 * regardless of NODE_ENV. Gated on NODE_ENV rather than always running so the
 * ~500 hub tests that construct a hub with databaseUrl: ':memory:' under
 * NODE_ENV=test see neither the throw nor the warning.
 */
function assertDatabaseSafety(config: HubConfig, fastify: FastifyInstance): void {
  if (config.databaseUrl !== ':memory:') return;
  const nodeEnv = process.env['NODE_ENV'];
  if (nodeEnv === 'test') return;

  const allowMemoryDb = process.env['FORGE_HUB_ALLOW_MEMORY_DB'] === '1';
  if (nodeEnv === 'production' && !allowMemoryDb) {
    throw new Error(
      'FORGE_HUB_DATABASE_URL is unset (or ":memory:") in production. Data will not ' +
        'persist across restarts. Set FORGE_HUB_DATABASE_URL to a persistent libsql URL, ' +
        'or set FORGE_HUB_ALLOW_MEMORY_DB=1 to override (e.g. CI smoke of prod images).',
    );
  }
  fastify.log.warn(
    'FORGE_HUB_DATABASE_URL is ":memory:", data is volatile and will be lost on restart. ' +
      (nodeEnv === 'production'
        ? 'FORGE_HUB_ALLOW_MEMORY_DB=1 is suppressing the production guard.'
        : 'Set FORGE_HUB_DATABASE_URL for persistence outside local dev.'),
  );
}

export async function createHub(options: { config: HubConfig }): Promise<Hub> {
  const { config } = options;
  const emailService: EmailService | undefined = config.resendApiKey
    ? createEmailService(config.resendApiKey)
    : undefined;
  const authRateLimitStore = new TokenBucketStore();
  let deviceRouteHandles: DeviceRouteHandles | undefined;
  let sessionGcTimer: ReturnType<typeof setInterval> | undefined;
  let reclaimSweepTimer: ReturnType<typeof setInterval> | undefined;

  const fastify = Fastify({
    logger: { level: process.env['NODE_ENV'] === 'test' ? 'warn' : 'info' },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  assertDatabaseSafety(config, fastify);

  const handle: DbHandle = openDatabase(config.databaseUrl);
  await runMigrations(handle.raw);

  const bus = new EventBus();

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
    registerAuthRoutes(scope, handle.db, config, authRateLimitStore, emailService);
    deviceRouteHandles = registerDeviceRoutes(scope, handle.db);
    registerTaskRoutes(scope, handle.db, bus, { leaseTtlSeconds: resolveTaskLeaseSeconds(config) });
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
    registerAnalyticsRoutes(scope, handle.db);
    registerPolicyRuleRoutes(scope, handle.db);
    registerWorkspaceContextRoutes(scope, handle.db);
    registerWakerRoutes(scope, handle.db, config.wakerToken);
    return Promise.resolve();
  });

  await fastify.ready();

  if (process.env['NODE_ENV'] !== 'test') {
    pruneExpiredSessionsGlobal(handle.db).catch((err) =>
      fastify.log.warn(err, 'session GC startup failed'),
    );
    sessionGcTimer = setInterval(
      () => pruneExpiredSessionsGlobal(handle.db).catch(() => {}),
      60 * 60 * 1000,
    );
    sessionGcTimer.unref();
  }

  // Reclaim sweep (M3 issue 1): gated purely on the resolved interval being
  // > 0, not on NODE_ENV. Tests that want the sweep set reclaimSweepSeconds
  // to 0 and call sweepExpiredLeases directly instead of waiting on a timer.
  const reclaimSweepSeconds = resolveReclaimSweepSeconds(config);
  if (reclaimSweepSeconds > 0) {
    const maxReclaims = resolveTaskMaxReclaims(config);
    reclaimSweepTimer = setInterval(() => {
      sweepExpiredLeases(handle.db, bus, { maxReclaims }).catch((err) =>
        fastify.log.error(err, 'reclaim sweep failed'),
      );
    }, reclaimSweepSeconds * 1000);
    reclaimSweepTimer.unref();
  }

  return {
    fastify,
    db: handle.db,
    bus,
    config,
    ...(emailService ? { emailService } : {}),
    close: async () => {
      if (sessionGcTimer) clearInterval(sessionGcTimer);
      if (reclaimSweepTimer) clearInterval(reclaimSweepTimer);
      await fastify.close();
      handle.close();
      authRateLimitStore.destroy();
      deviceRouteHandles?.destroy();
    },
  };
}
