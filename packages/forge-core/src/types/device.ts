import { z } from 'zod';

export const DevicePlatformSchema = z.enum(['win32', 'darwin', 'linux']);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

export const DeviceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().min(1).max(100),
  hostname: z.string().nullable(),
  platform: DevicePlatformSchema.nullable(),
  lastSeen: z.date().nullable(),
  createdAt: z.date(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const RegisterDeviceInputSchema = z.object({
  name: z.string().min(1).max(100),
  hostname: z.string().nullable().optional(),
  platform: DevicePlatformSchema.nullable().optional(),
});
export type RegisterDeviceInput = z.infer<typeof RegisterDeviceInputSchema>;
