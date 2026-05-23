import { z } from 'zod';

export const WorkspaceRoleSchema = z.enum(['owner', 'admin', 'collaborator', 'viewer']);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const WorkspaceStatusSchema = z.enum(['active', 'archived', 'deleted']);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

const slugPattern = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$|^[a-z0-9]$/;

export const WorkspaceSlugSchema = z
  .string()
  .regex(slugPattern, 'Slug must be 1-50 lowercase alphanumeric chars or hyphens, no leading/trailing hyphens');

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  slug: WorkspaceSlugSchema,
  description: z.string().nullable(),
  ownerUserId: z.string(),
  status: WorkspaceStatusSchema,
  budgetMonthlyCents: z.number().int().nonnegative(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const WorkspaceMemberSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
  role: WorkspaceRoleSchema,
  joinedAt: z.date(),
});
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;

export const CreateWorkspaceInputSchema = z.object({
  name: z.string().min(1).max(100),
  slug: WorkspaceSlugSchema,
  description: z.string().max(500).optional(),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;

export const WorkspaceWithMembershipSchema = WorkspaceSchema.extend({
  role: WorkspaceRoleSchema,
});
export type WorkspaceWithMembership = z.infer<typeof WorkspaceWithMembershipSchema>;

export function rankAtLeast(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  const order: Record<WorkspaceRole, number> = {
    owner: 4,
    admin: 3,
    collaborator: 2,
    viewer: 1,
  };
  return order[actual] >= order[required];
}
