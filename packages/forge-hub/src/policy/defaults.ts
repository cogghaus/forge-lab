/**
 * Heimdall built-in policy rules — Phase 1.
 *
 * Rules live here as code constants. No DB queries for rule lookup.
 * Phase 2 adds DB-backed rules from the policy_rules table on top of these.
 *
 * Priority guide:
 *   200 — named agent allows (agent:forge-master, agent:scribe)
 *   150 — role-level backward-compat allows (role:orchestrator -> doc:write)
 *   100 — role-level denies (role:worker, role:orchestrator)
 *    50 — user allows scoped by workspace membership or role
 *    10 — broad user denies (user:* -> task:claim, task:assign)
 *     0 — implicit default deny (no rule needed)
 */

export type WorkspaceRole = 'owner' | 'admin' | 'collaborator' | 'viewer';

export type BuiltInCondition =
  | { type: 'workspace_member' }                        // resource.workspaceId in principal.memberWorkspaces
  | { type: 'workspace_role_gte'; role: WorkspaceRole } // principal.workspaceRole >= role
  | { type: 'agent_id_match' };                         // resource.assignedAgentId === principal.agentId

export interface BuiltInRule {
  /** Stable identifier used as rule_id in audit log. */
  id: string;
  /** Principal string: "agent:forge-master", "role:worker", "user:*", etc. */
  principal: string;
  /** Action verb: "task:assign", "doc:write", etc. */
  action: string;
  /** Resource type filter. null = any resource type. */
  resourceType?: string;
  /** Optional condition. null = no condition (always matches when principal + action match). */
  condition?: BuiltInCondition;
  effect: 'allow' | 'deny';
  priority: number;
}

/**
 * Default policy rule set for Phase 1.
 * Evaluated in priority order (highest first). First matching rule wins.
 * If no rule matches: default deny.
 */
export const BUILT_IN_RULES: readonly BuiltInRule[] = [
  // ── Priority 200: named agent allows ────────────────────────────────────

  {
    id: 'builtin_fm_task_assign_allow',
    principal: 'agent:forge-master',
    action: 'task:assign',
    effect: 'allow',
    priority: 200,
  },
  {
    id: 'builtin_fm_context_read_allow',
    principal: 'agent:forge-master',
    action: 'context:read',
    effect: 'allow',
    priority: 200,
  },
  {
    id: 'builtin_fm_workspace_list_allow',
    principal: 'agent:forge-master',
    action: 'workspace:list',
    effect: 'allow',
    priority: 200,
  },
  {
    id: 'builtin_scribe_doc_write_allow',
    principal: 'agent:scribe',
    action: 'doc:write',
    effect: 'allow',
    priority: 200,
  },
  {
    id: 'builtin_scribe_doc_update_allow',
    principal: 'agent:scribe',
    action: 'doc:update',
    effect: 'allow',
    priority: 200,
  },
  {
    id: 'builtin_scribe_doc_supersede_allow',
    principal: 'agent:scribe',
    action: 'doc:supersede',
    effect: 'allow',
    priority: 200,
  },

  // ── Priority 150: backward-compat role allows ────────────────────────────

  // Any orchestrator-type device may write docs. To be tightened to agent:scribe
  // only once Heimdall is stable in production (Phase 2 hardening).
  {
    id: 'builtin_orchestrator_doc_write_allow_compat',
    principal: 'role:orchestrator',
    action: 'doc:write',
    effect: 'allow',
    priority: 150,
  },

  // ── Priority 100: role-level denies ─────────────────────────────────────

  // Workers should not route tasks — FM assigns.
  {
    id: 'builtin_worker_task_assign_deny',
    principal: 'role:worker',
    action: 'task:assign',
    effect: 'deny',
    priority: 100,
  },
  // Workers should not supersede docs — Scribe manages doc lifecycle.
  {
    id: 'builtin_worker_doc_supersede_deny',
    principal: 'role:worker',
    action: 'doc:supersede',
    effect: 'deny',
    priority: 100,
  },
  // Workers should not write docs (Scribe has explicit allow at 200 that beats this).
  {
    id: 'builtin_worker_doc_write_deny',
    principal: 'role:worker',
    action: 'doc:write',
    effect: 'deny',
    priority: 100,
  },
  // Orchestrators assign — they do not claim tasks.
  {
    id: 'builtin_orchestrator_task_claim_deny',
    principal: 'role:orchestrator',
    action: 'task:claim',
    effect: 'deny',
    priority: 100,
  },

  // ---- Priority 150: backward-compat orchestrator allows -----------------

  // Any orchestrator may read the FM context bundle and enumerate workspaces.
  // To be tightened to agent:forge-master only once Heimdall is stable in
  // production (Phase 2 hardening).
  {
    id: 'builtin_orchestrator_context_read_allow_compat',
    principal: 'role:orchestrator',
    action: 'context:read',
    effect: 'allow',
    priority: 150,
  },
  {
    id: 'builtin_orchestrator_workspace_list_allow_compat',
    principal: 'role:orchestrator',
    action: 'workspace:list',
    effect: 'allow',
    priority: 150,
  },
  // Any orchestrator may update, supersede, or archive docs. To be tightened
  // to agent:scribe once Heimdall is stable.
  {
    id: 'builtin_orchestrator_doc_update_allow_compat',
    principal: 'role:orchestrator',
    action: 'doc:update',
    effect: 'allow',
    priority: 150,
  },
  {
    id: 'builtin_orchestrator_doc_supersede_allow_compat',
    principal: 'role:orchestrator',
    action: 'doc:supersede',
    effect: 'allow',
    priority: 150,
  },
  {
    id: 'builtin_orchestrator_doc_archive_allow_compat',
    principal: 'role:orchestrator',
    action: 'doc:archive',
    effect: 'allow',
    priority: 150,
  },

  // ---- Priority 50: worker allows -----------------------------------------

  // Workers claim tasks -- that is their primary function.
  // The SQL agentId filter in the claim handler is defense-in-depth.
  {
    id: 'builtin_worker_task_claim_allow',
    principal: 'role:worker',
    action: 'task:claim',
    effect: 'allow',
    priority: 50,
  },
  // Workers complete and fail tasks they have claimed.
  {
    id: 'builtin_worker_task_complete_allow',
    principal: 'role:worker',
    action: 'task:complete',
    effect: 'allow',
    priority: 50,
  },
  {
    id: 'builtin_worker_task_fail_allow',
    principal: 'role:worker',
    action: 'task:fail',
    effect: 'allow',
    priority: 50,
  },

  // ── Priority 50: user allows scoped by workspace ─────────────────────────

  {
    id: 'builtin_user_task_cancel_allow',
    principal: 'user:*',
    action: 'task:cancel',
    condition: { type: 'workspace_member' },
    effect: 'allow',
    priority: 50,
  },
  {
    id: 'builtin_user_task_retry_allow',
    principal: 'user:*',
    action: 'task:retry',
    condition: { type: 'workspace_member' },
    effect: 'allow',
    priority: 50,
  },
  {
    id: 'builtin_user_doc_write_allow',
    principal: 'user:*',
    action: 'doc:write',
    condition: { type: 'workspace_role_gte', role: 'collaborator' },
    effect: 'allow',
    priority: 50,
  },
  {
    id: 'builtin_user_doc_update_allow',
    principal: 'user:*',
    action: 'doc:update',
    condition: { type: 'workspace_role_gte', role: 'collaborator' },
    effect: 'allow',
    priority: 50,
  },
  {
    id: 'builtin_user_doc_supersede_allow',
    principal: 'user:*',
    action: 'doc:supersede',
    condition: { type: 'workspace_role_gte', role: 'collaborator' },
    effect: 'allow',
    priority: 50,
  },
  {
    id: 'builtin_user_doc_archive_allow',
    principal: 'user:*',
    action: 'doc:archive',
    condition: { type: 'workspace_role_gte', role: 'collaborator' },
    effect: 'allow',
    priority: 50,
  },

  // ── Priority 10: broad user denies ──────────────────────────────────────

  // Users do not claim tasks — only daemons do.
  {
    id: 'builtin_user_task_claim_deny',
    principal: 'user:*',
    action: 'task:claim',
    effect: 'deny',
    priority: 10,
  },
  // Task routing is FM-only. User reassign uses the Phase-A user path
  // which does not call checkPolicy in Phase 1 (it uses requireWorkspaceMember directly).
  {
    id: 'builtin_user_task_assign_deny',
    principal: 'user:*',
    action: 'task:assign',
    effect: 'deny',
    priority: 10,
  },

  // ── Priority 50: user device management allows ───────────────────────────
  // Added in Phase 2 alongside Heimdall enforcement on device endpoints.
  // Admins can override with a higher-priority deny rule if needed.

  {
    id: 'builtin_user_device_deregister_allow',
    principal: 'user:*',
    action: 'device:deregister',
    resourceType: 'device',
    effect: 'allow',
    priority: 50,
  },
  {
    id: 'builtin_user_device_rotate_token_allow',
    principal: 'user:*',
    action: 'device:rotate-token',
    resourceType: 'device',
    effect: 'allow',
    priority: 50,
  },
];
