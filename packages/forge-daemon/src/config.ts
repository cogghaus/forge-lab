import { z } from 'zod';

const ConfigSchema = z.object({
  hubUrl: z.string().url(),
  deviceToken: z.string().min(1),
  workdir: z.string().min(1),
  // C2: keep as z.string() so custom runtime ids are not rejected at config
  // load time. Unknown ids still fail at spawn (registry lookup miss), but
  // the error message is clearer than a ZodError at startup.
  defaultRuntimeId: z.string().default('background'),
  // C3: allow operators to disable --dangerously-skip-permissions via env.
  // Defaults to true since background agents run unattended with no human
  // to approve tool calls. Set FORGE_DAEMON_SKIP_PERMISSIONS=false to disable.
  // z.coerce.boolean() is NOT used here: Boolean('false') === true (non-empty
  // string is truthy). Instead we preprocess so 'false'/'0'/'' → false and
  // undefined/empty → true (the safe default for unattended daemon use).
  // An explicitly empty env var (FORGE_DAEMON_SKIP_PERMISSIONS="") is treated
  // as "not set" and defaults to true, not false.
  skipPermissions: z.preprocess(
    (val) => {
      if (val === undefined || val === '') return true;
      if (val === 'false' || val === '0') return false;
      return Boolean(val);
    },
    z.boolean(),
  ),
  // Optional workspace scope. When set, daemon only processes tasks in this
  // workspace. When unset, daemon processes tasks across all workspaces.
  workspaceId: z.string().optional(),
  // Agent personality to use for spawned tasks. Must match an id in the
  // PersonalityRegistry (see @forge-lab/agents built-in personalities).
  // Defaults to 'architect' — the most general built-in personality.
  defaultAgentId: z.string().default('architect'),
  // When true, daemon operates as the FM orchestrator (dispatcher mode):
  // polls pending_dispatcher_action tasks, spawns FM agent, does not claim
  // worker tasks. Requires workspaceId to be set.
  // Same boolean-preprocess pattern as skipPermissions (avoids Boolean('false')===true).
  dispatcherMode: z.preprocess(
    (val) => {
      if (val === undefined || val === '') return false;
      if (val === 'false' || val === '0') return false;
      return Boolean(val);
    },
    z.boolean(),
  ),
  // Stale assignment TTL in minutes used by the dispatcher to requeue tasks
  // that have been assigned but not claimed within this window. Default: 30.
  staleTtlMinutes: z.coerce.number().int().min(1).optional(),
  // Maximum concurrent task instances for worker daemons. Default: 1.
  maxConcurrentTasks: z.coerce.number().int().min(1).optional(),
  // How many times to re-spawn a worker task after a transient auth failure
  // (shared OAuth token rotating mid-run) before failing it. Default: 2.
  authRetryLimit: z.coerce.number().int().min(0).optional(),
  // Dev-capability: repo this daemon's workers check out, branch per task, and
  // open PRs against. Requires gitToken. Without repoUrl, output-only as before.
  repoUrl: z.string().url().optional(),
  repoBranch: z.string().optional(),
  gitToken: z.string().optional(),
  gitUserName: z.string().optional(),
  gitUserEmail: z.string().optional(),
  // Minimum milliseconds between FM agent spawns per workspace (cooldown window).
  // Limits blast radius of runaway triage loops. Set to 0 to disable. Default: 60000.
  fmCooldownMs: z.coerce.number().int().min(0).optional(),
  // Claude model passed to every agent spawn via --model. When unset, claude uses
  // its own default (which may be expensive). Always set in production.
  // Example: "claude-sonnet-4-6", "claude-haiku-4-5-20251001"
  model: z.string().optional(),
  // Milliseconds of inactivity before the daemon exits cleanly (exit code 0).
  // The Docker restart policy (restart: on-failure) will NOT restart a clean exit,
  // so the daemon stays idle until the waker service starts it again when work arrives.
  // Set to 0 to disable idle shutdown. Default: disabled (undefined).
  idleShutdownMs: z.coerce.number().int().min(0).optional(),
  // Personality ID to use for the FM agent spawned in dispatcher mode.
  // Must match an id registered in the PersonalityRegistry.
  // Defaults to 'forge-master'. Ignored in worker mode.
  dispatcherPersonality: z.string().optional(),
  // Controls which workspaces FM triages when dispatcherMode is true.
  // 'single' (default): triage only the workspace set via workspaceId (back-compat).
  // 'all': enumerate all active workspaces the device's owning account is a member of
  //        and triage each inbox in sequence. workspaceId is optional in this mode.
  dispatcherWorkspaceMode: z.enum(['single', 'all']).default('single'),
  // How often the heartbeat loop extends the lease on every active real task
  // (M3 issue 1). Must be well under the hub's lease TTL (default 30 min) so
  // a beat or two can be missed without losing the task. 0 disables the loop
  // entirely (not recommended once the hub reclaim sweep is live). Default: 60000.
  heartbeatMs: z.coerce.number().int().min(0).optional(),
  // Wall-clock backstop for a hung-but-alive agent (M3 issue 4). isAlive() is
  // file/pid-based and never expires on its own. 0 disables the check.
  // Default: 3600000 (60 min).
  maxTaskRuntimeMs: z.coerce.number().int().min(0).optional(),
  // Bounded retry limit for terminal hub calls (completeTask/failTask) on
  // network errors, 429, and 5xx (M3 issue 14). 4xx stops retrying immediately
  // regardless of this limit. Default: 4.
  terminalRetryLimit: z.coerce.number().int().min(0).optional(),
});

export type DaemonConfig = z.infer<typeof ConfigSchema> & {
  /**
   * True when FORGE_DAEMON_AGENT_ID was not provided and defaultAgentId fell
   * back to 'architect'. Exposed explicitly so callers can warn about the
   * silent fallback without inferring it by string equality with 'architect'
   * (an operator may set the env to 'architect' on purpose). Issue 12.
   */
  defaultAgentIdWasDefaulted: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const parsed = ConfigSchema.parse({
    hubUrl: env['FORGE_DAEMON_HUB_URL'],
    deviceToken: env['FORGE_DAEMON_DEVICE_TOKEN'],
    workdir: env['FORGE_DAEMON_WORKDIR'] ?? process.cwd(),
    defaultRuntimeId: env['FORGE_DAEMON_DEFAULT_RUNTIME'],
    skipPermissions: env['FORGE_DAEMON_SKIP_PERMISSIONS'],
    workspaceId: env['FORGE_DAEMON_WORKSPACE_ID'],
    defaultAgentId: env['FORGE_DAEMON_AGENT_ID'],
    dispatcherMode: env['FORGE_DAEMON_DISPATCHER_MODE'],
    staleTtlMinutes: env['FORGE_DAEMON_STALE_TTL_MINUTES'],
    maxConcurrentTasks: env['FORGE_DAEMON_MAX_CONCURRENT_TASKS'],
    authRetryLimit: env['FORGE_DAEMON_AUTH_RETRY_LIMIT'],
    repoUrl: env['FORGE_DAEMON_REPO_URL'],
    repoBranch: env['FORGE_DAEMON_REPO_BRANCH'],
    gitToken: env['FORGE_DAEMON_GIT_TOKEN'],
    gitUserName: env['FORGE_DAEMON_GIT_NAME'],
    gitUserEmail: env['FORGE_DAEMON_GIT_EMAIL'],
    dispatcherPersonality: env['FORGE_DAEMON_DISPATCHER_PERSONALITY'],
    dispatcherWorkspaceMode: env['FORGE_DAEMON_DISPATCHER_SCOPE'],
    fmCooldownMs: env['FORGE_DAEMON_FM_COOLDOWN_MS'],
    model: env['FORGE_DAEMON_MODEL'],
    idleShutdownMs: env['FORGE_DAEMON_IDLE_SHUTDOWN_MS'],
    heartbeatMs: env['FORGE_DAEMON_HEARTBEAT_MS'],
    maxTaskRuntimeMs: env['FORGE_DAEMON_MAX_TASK_RUNTIME_MS'],
    terminalRetryLimit: env['FORGE_DAEMON_TERMINAL_RETRY_LIMIT'],
  });
  return {
    ...parsed,
    // Mirrors the Zod .default() semantics above: only an absent variable
    // triggers the default (an empty string passes through as an empty agentId).
    defaultAgentIdWasDefaulted: env['FORGE_DAEMON_AGENT_ID'] === undefined,
  };
}
