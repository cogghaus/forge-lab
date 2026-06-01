import { z } from 'zod';

export const WorkspaceRoleSchema = z.enum(['owner', 'admin', 'collaborator', 'viewer']);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const WorkspaceStatusSchema = z.enum(['active', 'archived', 'deleted']);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

const slugPattern = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$|^[a-z0-9]$/;

export const WorkspaceSlugSchema = z
  .string()
  .regex(slugPattern, 'Slug must be 1-50 lowercase alphanumeric chars or hyphens, no leading/trailing hyphens');

/** HTTPS git clone URL a workspace's worker agents check out and push to. */
export const RepoUrlSchema = z
  .string()
  .url()
  .max(500)
  .refine((u) => /^https:\/\//i.test(u), 'Repo URL must be an https:// clone URL');

/** Git branch name (the base branch worker PRs target). */
export const RepoBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s~^:?*[\\]+$/, 'Invalid git branch name');

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  slug: WorkspaceSlugSchema,
  description: z.string().nullable(),
  ownerUserId: z.string(),
  status: WorkspaceStatusSchema,
  budgetMonthlyCents: z.number().int().nonnegative(),
  // Optional repo binding: when set, worker agents in this workspace check out
  // the repo, branch per task, and open PRs. Null = no repo (output-only tasks).
  repoUrl: z.string().nullable(),
  repoBranch: z.string().nullable(),
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
  repoUrl: RepoUrlSchema.optional(),
  repoBranch: RepoBranchSchema.optional(),
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
