import { z } from 'zod';

const ConfigSchema = z.object({
  hubUrl: z.string().url(),
  deviceToken: z.string().min(1),
  workdir: z.string().min(1),
  defaultRuntimeId: z.string().default('mock'),
});

export type DaemonConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  return ConfigSchema.parse({
    hubUrl: env['FORGE_DAEMON_HUB_URL'],
    deviceToken: env['FORGE_DAEMON_DEVICE_TOKEN'],
    workdir: env['FORGE_DAEMON_WORKDIR'] ?? process.cwd(),
    defaultRuntimeId: env['FORGE_DAEMON_DEFAULT_RUNTIME'],
  });
}
