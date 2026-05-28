/**
 * Heimdall policy engine — Phase 1.
 *
 * Evaluates the built-in rule set in priority order. First matching rule
 * (principal + action + resource type + condition all satisfied) wins.
 * Default deny when no rule matches.
 *
 * Phase 2 will add DB-backed rule loading after the built-in check, with
 * the same evaluation loop — no algorithmic changes needed.
 */

import type { Db } from '../db/index.js';
import { BUILT_IN_RULES, type BuiltInRule, type WorkspaceRole } from './defaults.js';
import { resolvePrincipals, matchesPrincipal } from './principals.js';
import { logDecision } from './audit.js';

// Re-export principal type so callers import from one place.
export type { PolicyPrincipal } from './principals.js';
export type { WorkspaceRole } from './defaults.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PolicyResource {
  type: 'task' | 'doc' | 'device' | 'workspace';
  id?: string;
  workspaceId?: string | null;
  assignedAgentId?: string | null;
  assignedDeviceId?: string | null;
  status?: string;
  /** For device resources: owning user id. */
  userId?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  effect: 'allow' | 'deny';
  /**
   * The rule that triggered the decision.
   * null = default-deny (no rule matched).
   */
  rule: BuiltInRule | null;
  /**
   * The resolved principal string that matched the rule
   * (e.g. "agent:scribe", "role:worker").
   * For default-deny, the first resolved principal of the request.
   */
  principal: string;
}

export interface PolicyContext {
  db?: Db;
  workspaceId?: string;
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  collaborator: 1,
  admin: 2,
  owner: 3,
};

function roleRank(role: WorkspaceRole | undefined): number {
  if (!role) return -1;
  return ROLE_RANK[role] ?? -1;
}

function evaluateCondition(
  rule: BuiltInRule,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  principal: any, // PolicyPrincipal — imported via engine.ts re-export
  resource: PolicyResource,
): boolean {
  if (!rule.condition) return true; // no condition = always matches

  const condition = rule.condition;

  switch (condition.type) {
    case 'workspace_member': {
      if (!principal.memberWorkspaces || !Array.isArray(principal.memberWorkspaces)) return false;
      if (!resource.workspaceId) return false;
      return (principal.memberWorkspaces as string[]).includes(resource.workspaceId);
    }
    case 'workspace_role_gte': {
      const requiredRank = ROLE_RANK[condition.role] ?? -1;
      return roleRank(principal.workspaceRole as WorkspaceRole | undefined) >= requiredRank;
    }
    case 'agent_id_match': {
      return (
        resource.assignedAgentId != null &&
        resource.assignedAgentId === (principal.agentId as string | null)
      );
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a principal is allowed to perform an action on a resource.
 *
 * The audit log write is fire-and-forget — the call never throws due to DB
 * failures. Pass `ctx.db` to enable audit logging; omit for pure evaluation.
 *
 * @param principal - Resolved principal (built via buildDevicePrincipal or inline)
 * @param action    - Action verb, e.g. "task:assign", "doc:write"
 * @param resource  - Target resource with type and relevant attributes
 * @param ctx       - Optional DB + workspaceId for audit log
 */
export async function checkPolicy(
  principal: import('./principals.js').PolicyPrincipal,
  action: string,
  resource: PolicyResource,
  ctx: PolicyContext,
): Promise<PolicyDecision> {
  const resolved = resolvePrincipals(principal);

  // Collect candidate rules matching principal + action + resource type.
  const candidates = BUILT_IN_RULES.filter((r) => {
    if (!matchesPrincipal(r.principal, resolved)) return false;
    if (r.action !== action) return false;
    if (r.resourceType && r.resourceType !== resource.type) return false;
    return true;
  });

  // Sort by priority DESC. On tie, deny > allow.
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    // Same priority: deny fires before allow (conservative).
    if (a.effect === 'deny' && b.effect === 'allow') return -1;
    if (a.effect === 'allow' && b.effect === 'deny') return 1;
    return 0;
  });

  // Find first rule whose condition is satisfied.
  let matchedRule: BuiltInRule | null = null;
  for (const rule of candidates) {
    if (evaluateCondition(rule, principal, resource)) {
      matchedRule = rule;
      break;
    }
  }

  // Determine the matched principal string for the decision record.
  // If a rule matched, use the rule's principal as the canonical string.
  // For default-deny, use the first resolved principal.
  const matchedPrincipal = matchedRule?.principal ?? resolved[0] ?? principal.id;

  const decision: PolicyDecision = matchedRule
    ? {
        allowed: matchedRule.effect === 'allow',
        effect: matchedRule.effect,
        rule: matchedRule,
        principal: matchedPrincipal,
      }
    : {
        allowed: false,
        effect: 'deny',
        rule: null,
        principal: matchedPrincipal,
      };

  // Fire-and-forget audit log.
  void logDecision(
    {
      principal: matchedPrincipal,
      action,
      resourceId: resource.id ?? null,
      decision,
    },
    ctx,
  );

  return decision;
}
