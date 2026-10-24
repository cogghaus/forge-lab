import type { FastifyRequest } from 'fastify';
import { rankAtLeast, type WorkspaceRole } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { findWorkspaceMembership } from './middleware.js';

/** An authorization failure: the status code and error body to reply with. */
export interface AccessDenied {
  code: number;
  error: string;
}

/**
 * The user a caller acts for: the session user, or a device's owning user.
 * Devices are not workspace members themselves, and any user can register any
 * device type, so a device is authorized through its owner.
 */
export function callerUserId(req: FastifyRequest): string | null {
  return req.authUser?.id ?? req.authDevice?.userId ?? null;
}

/**
 * Authorize a user against a workspace. Returns null when the user is a member
 * of the live workspace at `minRole` or above.
 */
export async function authorizeUserForWorkspace(
  db: Db,
  userId: string,
  workspaceId: string,
  minRole?: WorkspaceRole,
): Promise<AccessDenied | null> {
  const membership = await findWorkspaceMembership(db, workspaceId, userId);
  if (!membership) return { code: 403, error: 'forbidden' };
  if (membership.workspaceStatus === 'deleted') return { code: 404, error: 'not_found' };
  if (minRole && !rankAtLeast(membership.role, minRole)) return { code: 403, error: 'insufficient_role' };
  return null;
}

/** authorizeUserForWorkspace for a request's caller (user session or device owner). */
export async function authorizeCallerForWorkspace(
  db: Db,
  req: FastifyRequest,
  workspaceId: string,
  minRole?: WorkspaceRole,
): Promise<AccessDenied | null> {
  const userId = callerUserId(req);
  if (userId === null) return { code: 401, error: 'unauthorized' };
  return authorizeUserForWorkspace(db, userId, workspaceId, minRole);
}
