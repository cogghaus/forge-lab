import { readFileSync } from 'node:fs';
import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(3000),
  host: z.string().default('127.0.0.1'),
  databaseUrl: z.string().default(':memory:'),
  sessionSecret: z.string().min(32),
  sessionTtlHours: z.coerce.number().int().positive().default(24 * 14),
  bcryptCost: z.coerce.number().int().min(10).max(15).default(12),
  cookieSecure: z.coerce.boolean().default(false),
  resendApiKey: z.string().optional(),
  appBaseUrl: z.string().default('http://localhost:3001'),
  /** Shared secret for the internal /waker/has-work endpoint. */
  wakerToken: z.string().optional(),
  /**
   * In_progress claim lease TTL in seconds (M3 issue 1). Left optional (rather
   * than a zod .default()) so existing HubConfig object literals in tests keep
   * compiling unchanged; DEFAULT_TASK_LEASE_SECONDS is applied at call sites
   * via resolveTaskLeaseSeconds.
   */
  taskLeaseSeconds: z.coerce.number().int().positive().optional(),
  /** Reclaim sweep interval in seconds. 0 disables the sweep. Optional for the same reason as taskLeaseSeconds. */
  reclaimSweepSeconds: z.coerce.number().int().min(0).optional(),
  /** Max lease reclaims before a task fails permanently. Optional for the same reason as taskLeaseSeconds. */
  taskMaxReclaims: z.coerce.number().int().positive().optional(),
});

export type HubConfig = z.infer<typeof ConfigSchema>;

/** Default in_progress lease TTL (30 minutes), per docs/design/m3-reliability.md Issue 1. */
export const DEFAULT_TASK_LEASE_SECONDS = 1800;
/** Default reclaim sweep interval in seconds. */
export const DEFAULT_RECLAIM_SWEEP_SECONDS = 60;
/** Default cap on lease reclaims before a task is failed permanently. */
export const DEFAULT_TASK_MAX_RECLAIMS = 3;

export function resolveTaskLeaseSeconds(config: HubConfig): number {
  return config.taskLeaseSeconds ?? DEFAULT_TASK_LEASE_SECONDS;
}

export function resolveReclaimSweepSeconds(config: HubConfig): number {
  return config.reclaimSweepSeconds ?? DEFAULT_RECLAIM_SWEEP_SECONDS;
}

export function resolveTaskMaxReclaims(config: HubConfig): number {
  return config.taskMaxReclaims ?? DEFAULT_TASK_MAX_RECLAIMS;
}

function resolveSessionSecret(env: NodeJS.ProcessEnv): string | undefined {
  const direct = env['FORGE_HUB_SESSION_SECRET'];
  if (direct && direct.length > 0) return direct;
  const file = env['FORGE_HUB_SESSION_SECRET_FILE'];
  if (file && file.length > 0) {
    return readFileSync(file, 'utf8').trim();
  }
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  return ConfigSchema.parse({
    port: env['FORGE_HUB_PORT'],
    host: env['FORGE_HUB_HOST'],
    databaseUrl: env['FORGE_HUB_DATABASE_URL'],
    sessionSecret: resolveSessionSecret(env),
    sessionTtlHours: env['FORGE_HUB_SESSION_TTL_HOURS'],
    bcryptCost: env['FORGE_HUB_BCRYPT_COST'],
    cookieSecure: env['FORGE_HUB_COOKIE_SECURE'],
    resendApiKey: env['RESEND_API_KEY'],
    appBaseUrl: env['APP_BASE_URL'],
    wakerToken: env['FORGE_HUB_WAKER_TOKEN'],
    taskLeaseSeconds: env['FORGE_HUB_TASK_LEASE_SECONDS'],
    reclaimSweepSeconds: env['FORGE_HUB_RECLAIM_SWEEP_SECONDS'],
    taskMaxReclaims: env['FORGE_HUB_TASK_MAX_RECLAIMS'],
  });
}
