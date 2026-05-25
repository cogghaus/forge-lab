import { z } from 'zod';

export const DevicePlatformSchema = z.enum(['win32', 'darwin', 'linux']);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

export const DeviceTypeSchema = z.enum(['worker', 'orchestrator']);
export type DeviceType = z.infer<typeof DeviceTypeSchema>;

export const DeviceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().min(1).max(100),
  hostname: z.string().nullable(),
  platform: DevicePlatformSchema.nullable(),
  lastSeen: z.date().nullable(),
  createdAt: z.date(),
  /** Logical agent role (e.g. 'architect', 'furnace', 'forge-master'). Null for untyped devices. */
  agentId: z.string().nullable(),
  /** Whether this device runs as an orchestrator (FM) or a worker (specialist). */
  deviceType: DeviceTypeSchema,
});
export type Device = z.infer<typeof DeviceSchema>;

export const RegisterDeviceInputSchema = z.object({
  name: z.string().min(1).max(100),
  hostname: z.string().nullable().optional(),
  platform: DevicePlatformSchema.nullable().optional(),
  /** Logical agent role this device will run. */
  agentId: z.string().min(1).max(100).nullable().optional(),
  /** Defaults to 'worker' if not provided. */
  deviceType: DeviceTypeSchema.optional(),
});
export type RegisterDeviceInput = z.infer<typeof RegisterDeviceInputSchema>;
