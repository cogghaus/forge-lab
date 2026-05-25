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
  skipPermissions: z.coerce.boolean().default(true),
  // Optional workspace scope. When set, daemon only processes tasks in this
  // workspace. When unset, daemon processes tasks across all workspaces.
  workspaceId: z.string().optional(),
});

export type DaemonConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  return ConfigSchema.parse({
    hubUrl: env['FORGE_DAEMON_HUB_URL'],
    deviceToken: env['FORGE_DAEMON_DEVICE_TOKEN'],
    workdir: env['FORGE_DAEMON_WORKDIR'] ?? process.cwd(),
    defaultRuntimeId: env['FORGE_DAEMON_DEFAULT_RUNTIME'],
    skipPermissions: env['FORGE_DAEMON_SKIP_PERMISSIONS'],
    workspaceId: env['FORGE_DAEMON_WORKSPACE_ID'],
  });
}
