/**
 * Heimdall principal helpers.
 *
 * Builds PolicyPrincipal objects from authenticated request context and
 * resolves the set of principal strings a request matches for rule evaluation.
 */

import type { WorkspaceRole } from './defaults.js';

// ---------------------------------------------------------------------------
// PolicyPrincipal type
// ---------------------------------------------------------------------------

export interface PolicyPrincipal {
  type: 'user' | 'device';
  id: string;
  /** For device principals: the registered agentId (e.g. 'scribe', 'forge-master'). */
  agentId?: string | null;
  /** For device principals: the device classification. */
  deviceType?: 'worker' | 'orchestrator';
  /** For user principals: workspaceIds the user is a member of. */
  memberWorkspaces?: string[];
  /**
   * For user principals in a workspace context: the user's role in that workspace.
   * Populated by the caller when a workspaceId is known.
   */
  workspaceRole?: WorkspaceRole;
}

// ---------------------------------------------------------------------------
// buildPrincipal
// ---------------------------------------------------------------------------

/**
 * Build a PolicyPrincipal from an authenticated device.
 * Synchronous: no DB lookup needed for device principals.
 */
export function buildDevicePrincipal(device: {
  id: string;
  agentId: string | null | undefined;
  deviceType: 'worker' | 'orchestrator';
}): PolicyPrincipal {
  return {
    type: 'device',
    id: device.id,
    agentId: device.agentId ?? null,
    deviceType: device.deviceType,
  };
}

// ---------------------------------------------------------------------------
// resolvePrincipals
// ---------------------------------------------------------------------------

/**
 * Expand a PolicyPrincipal into all principal strings it matches.
 *
 * Device with agentId='scribe', deviceType='worker' resolves to:
 *   ["device:xyz", "agent:scribe", "role:worker"]
 *
 * User resolves to:
 *   ["user:uid", "user:*"]
 */
export function resolvePrincipals(principal: PolicyPrincipal): string[] {
  if (principal.type === 'device') {
    const principals: string[] = [`device:${principal.id}`];
    if (principal.agentId) {
      principals.push(`agent:${principal.agentId}`);
    }
    if (principal.deviceType === 'orchestrator') {
      principals.push('role:orchestrator');
    } else {
      principals.push('role:worker');
    }
    return principals;
  }

  // User principal
  return [`user:${principal.id}`, 'user:*'];
}

// ---------------------------------------------------------------------------
// matchesPrincipal
// ---------------------------------------------------------------------------

/**
 * Returns true if a rule's principal field matches one of the resolved principals.
 *
 * Supports exact match and trailing-wildcard match:
 *   "user:*" rule matches "user:abc123" resolved principal.
 */
export function matchesPrincipal(rulePrincipal: string, resolvedPrincipals: string[]): boolean {
  for (const resolved of resolvedPrincipals) {
    if (rulePrincipal === resolved) return true;
    // Wildcard: "user:*" matches any "user:..."
    if (rulePrincipal.endsWith(':*')) {
      const prefix = rulePrincipal.slice(0, -1); // "user:"
      if (resolved.startsWith(prefix)) return true;
    }
  }
  return false;
}
