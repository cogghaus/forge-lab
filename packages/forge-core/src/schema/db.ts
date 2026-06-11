import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

const timestampMs = (name: string) => integer(name, { mode: 'timestamp_ms' });
const nowDefault = sql`(unixepoch() * 1000)`;

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'user'] })
    .notNull()
    .default('user'),
  createdAt: timestampMs('created_at').notNull().default(nowDefault),
});

export const emailVerifications = sqliteTable(
  'email_verifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    newEmail: text('new_email').notNull(),
    token: text('token').notNull().unique(),
    expiresAt: timestampMs('expires_at').notNull(),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    userIdIdx: index('email_verifications_user_idx').on(t.userId),
  }),
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestampMs('expires_at').notNull(),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
    /** Raw User-Agent header captured at login (for labelling the session). */
    userAgent: text('user_agent'),
    /** Client IP captured at login. */
    ipAddress: text('ip_address'),
    /** Bumped on use (throttled) so "last active" is meaningful. */
    lastSeenAt: timestampMs('last_seen_at'),
  },
  (t) => ({
    userIdIdx: index('sessions_user_id_idx').on(t.userId),
  }),
);

export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    hostname: text('hostname'),
    platform: text('platform', { enum: ['win32', 'darwin', 'linux'] }),
    tokenHash: text('token_hash').notNull().unique(),
    lastSeen: timestampMs('last_seen'),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
    /** Logical agent role this device runs (e.g. 'architect', 'furnace'). Set on registration. */
    agentId: text('agent_id'),
    /** Whether this device acts as an orchestrator (FM) or a worker (specialist). */
    deviceType: text('device_type', { enum: ['worker', 'orchestrator'] })
      .notNull()
      .default('worker'),
    /** Lifecycle status. Deregistered devices have their token invalidated. */
    status: text('status', { enum: ['active', 'deregistered'] })
      .notNull()
      .default('active'),
  },
  (t) => ({
    userIdIdx: index('devices_user_id_idx').on(t.userId),
    statusIdx: index('devices_status_idx').on(t.status),
  }),
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    projectPrefix: text('project_prefix').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', {
      enum: [
        'pending_design',
        'design_review',
        'pending_agent',
        'assigned',
        'in_progress',
        'pending_dispatcher_action',
        'sequenced_running',
        'sequenced_complete',
        'waiting_on_deps',
        'completed',
        'failed',
        'cancelled',
      ],
    })
      .notNull()
      .default('pending_agent'),
    priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] })
      .notNull()
      .default('normal'),
    assignedDeviceId: text('assigned_device_id').references(() => devices.id, {
      onDelete: 'set null',
    }),
    assignedAgentId: text('assigned_agent_id'),
    /** Unix ms timestamp set by FM when assignedAgentId is written. Used for reassignment timeout. */
    assignedAt: timestampMs('assigned_at'),
    parentId: text('parent_id'),
    goalId: text('goal_id'),
    createdBy: text('created_by').notNull(),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
    updatedAt: timestampMs('updated_at').notNull().default(nowDefault),
    completedAt: timestampMs('completed_at'),
    /** JSON array of {name,content} baked at FM assignment time. NULL = no context. */
    contextSnapshot: text('context_snapshot'),
    taskKind: text('task_kind').notNull().default('coding'),
    /** JSON-encoded ReviewConfig. Null for coding tasks. */
    reviewConfig: text('review_config'),
    /** JSON-encoded SequenceSpec blob stored on the parent task. */
    sequenceSpec: text('sequence_spec'),
    /** Ordinal position within a sequenced parent (0-based). NULL = not part of a sequence. */
    phaseIndex: integer('phase_index'),
    /** JSON-encoded task result payload written by the agent on completion. */
    result: text('result'),
    /** JSON array of task IDs this task must wait for before becoming eligible. */
    dependsOn: text('depends_on').notNull().default('[]'),
    /** Human-readable explanation when status = 'blocked' (FM-written). */
    blockedReason: text('blocked_reason'),
    /** SHA-256 of sequence_spec JSON, used for idempotent re-plan detection. */
    sequenceSpecHash: text('sequence_spec_hash'),
  },
  (t) => ({
    statusIdx: index('tasks_status_idx').on(t.status),
    projectIdx: index('tasks_project_idx').on(t.projectPrefix),
    assignedDeviceIdx: index('tasks_assigned_device_idx').on(t.assignedDeviceId),
    workspaceIdx: index('tasks_workspace_idx').on(t.workspaceId),
    /** Enforce one phase_index per parent — partial index skips NULL rows. */
    parentPhaseIdx: uniqueIndex('tasks_parent_phase_idx')
      .on(t.parentId, t.phaseIndex)
      .where(sql`${t.phaseIndex} IS NOT NULL`),
  }),
);

export const taskHistory = sqliteTable(
  'task_history',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    eventName: text('event_name').notNull(),
    source: text('source').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    taskIdIdx: index('task_history_task_id_idx').on(t.taskId),
    workspaceIdx: index('task_history_workspace_idx').on(t.workspaceId),
  }),
);

export const taskInstructions = sqliteTable(
  'task_instructions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    priority: text('priority', { enum: ['redirect', 'stop'] }).notNull(),
    body: text('body').notNull(),
    createdBy: text('created_by').notNull(),
    acknowledgedAt: timestampMs('acknowledged_at'),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    taskIdIdx: index('task_instructions_task_id_idx').on(t.taskId),
    workspaceIdx: index('task_instructions_workspace_idx').on(t.workspaceId),
  }),
);

export const taskComments = sqliteTable(
  'task_comments',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    authorType: text('author_type', { enum: ['user', 'agent', 'dispatcher', 'system'] }).notNull(),
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    taskIdIdx: index('task_comments_task_id_idx').on(t.taskId),
    workspaceIdx: index('task_comments_workspace_idx').on(t.workspaceId),
  }),
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    name: text('name').notNull(),
    personality: text('personality').notNull(),
    runtimeId: text('runtime_id').notNull(),
    config: text('config', { mode: 'json' }).notNull().default(sql`'{}'`),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    workspaceIdx: index('agents_workspace_idx').on(t.workspaceId),
  }),
);

export const agentInstances = sqliteTable(
  'agent_instances',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').references(() => workspaces.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    runtimeInstanceId: text('runtime_instance_id'),
    status: text('status', {
      enum: ['spawning', 'running', 'idle', 'stopping', 'stopped', 'crashed'],
    }).notNull(),
    startedAt: timestampMs('started_at').notNull().default(nowDefault),
    endedAt: timestampMs('ended_at'),
  },
  (t) => ({
    deviceIdx: index('agent_instances_device_idx').on(t.deviceId),
    taskIdx: index('agent_instances_task_idx').on(t.taskId),
    workspaceIdx: index('agent_instances_workspace_idx').on(t.workspaceId),
  }),
);

export const runtimeConfigs = sqliteTable(
  'runtime_configs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    runtimeId: text('runtime_id').notNull(),
    name: text('name').notNull(),
    config: text('config', { mode: 'json' }).notNull(),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    userIdx: index('runtime_configs_user_idx').on(t.userId),
  }),
);

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    description: text('description'),
    ownerUserId: text('owner_user_id')
      .notNull()
      // RESTRICT: deleting a user who owns a workspace is blocked by design; transfer ownership first
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status', { enum: ['active', 'archived', 'deleted'] })
      .notNull()
      .default('active'),
    budgetMonthlyCents: integer('budget_monthly_cents').notNull().default(0),
    // Optional repo binding for worker dev-capability (checkout + branch + PR).
    repoUrl: text('repo_url'),
    repoBranch: text('repo_branch'),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
    updatedAt: timestampMs('updated_at').notNull().default(nowDefault),
  },
  (t) => ({
    ownerIdx: index('workspaces_owner_idx').on(t.ownerUserId),
  }),
);

export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'collaborator', 'viewer'] }).notNull(),
    joinedAt: timestampMs('joined_at').notNull().default(nowDefault),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
    userIdx: index('workspace_members_user_idx').on(t.userId),
  }),
);

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  email: text('email'),
  createdBy: text('created_by').notNull(),
  workspaceId: text('workspace_id'),
  workspaceRole: text('workspace_role'),
  expiresAt: timestampMs('expires_at').notNull(),
  createdAt: timestampMs('created_at').notNull().default(nowDefault),
  acceptedAt: timestampMs('accepted_at'),
  acceptedBy: text('accepted_by'),
});

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  parentId: text('parent_id'),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', { enum: ['active', 'completed', 'cancelled'] }).notNull().default('active'),
  createdBy: text('created_by').notNull(),
  createdAt: timestampMs('created_at').notNull().default(nowDefault),
  updatedAt: timestampMs('updated_at').notNull().default(nowDefault),
});

/**
 * Workspace knowledge base — structured documentation maintained by Scribe and FM.
 *
 * Status semantics:
 *   active     — current, true, included in FM's Tier 0 context
 *   archived   — completed/done, no longer a live concern, excluded from FM context
 *   superseded — was true, something replaced it; supersededReason explains what changed
 *
 * Docs are never deleted — audit trail is permanent.
 * Only status transitions are permitted (active → archived | superseded).
 */
export const workspaceDocs = sqliteTable(
  'workspace_docs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Slug identifier — unique per workspace. e.g. 'architecture-overview', 'adr-003' */
    key: text('key').notNull(),
    title: text('title').notNull(),
    /** Markdown content */
    content: text('content').notNull(),
    category: text('category', {
      enum: ['architecture', 'api', 'pattern', 'adr', 'agent', 'feature', 'runbook'],
    }).notNull(),
    status: text('status', {
      enum: ['active', 'archived', 'superseded'],
    })
      .notNull()
      .default('active'),
    /**
     * id of the workspace_docs row that replaces this one (null if not superseded).
     * FK is intentionally not declared in Drizzle — self-referential FKs are defined
     * in migrate.ts SQL only, following the goals.parentId pattern.
     */
    supersededById: text('superseded_by_id'),
    /** Required when status = 'superseded'. Explains what changed and why. */
    supersededReason: text('superseded_reason'),
    /** Agent name or user id that last wrote this doc */
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestampMs('updated_at').notNull().default(nowDefault),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    workspaceActiveIdx: index('workspace_docs_active_idx').on(t.workspaceId, t.status),
    workspaceCategoryIdx: index('workspace_docs_category_idx').on(t.workspaceId, t.category),
    /** Enforces one doc per key per workspace */
    workspaceKeyIdx: uniqueIndex('workspace_docs_key_idx').on(t.workspaceId, t.key),
  }),
);

/**
 * Workspace-scoped (or global) policy rule overrides for the Heimdall engine.
 * workspace_id IS NULL = global (applies to all workspaces).
 * Rows are never hard-deleted; use archived_at to retire a rule.
 */
export const policyRules = sqliteTable(
  'policy_rules',
  {
    id: text('id').primaryKey(),
    /** NULL = global rule (applies across all workspaces). */
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Principal selector: "agent:scribe", "role:worker", "user:*", etc. */
    principal: text('principal').notNull(),
    /** Action verb: "doc:write", "task:assign", etc. */
    action: text('action').notNull(),
    /** Optional resource type filter. NULL = any resource type. */
    resourceType: text('resource_type'),
    /** Optional JSON condition. NULL = no condition (always matches). */
    resourceCondition: text('resource_condition'),
    effect: text('effect', { enum: ['allow', 'deny'] }).notNull(),
    priority: integer('priority').notNull().default(0),
    /** Set to retire a rule without deleting it (preserves audit trail). */
    archivedAt: timestampMs('archived_at'),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    workspaceIdx: index('policy_rules_workspace_idx').on(t.workspaceId),
    actionIdx: index('policy_rules_action_idx').on(t.action),
  }),
);

/**
 * Named markdown blobs attached to a workspace — injected into agent task prompts
 * by FM at assignment time so workers start with architectural context pre-loaded.
 * Content is capped at 10 000 UTF-8 bytes (app-enforced). Max 10 docs per workspace.
 */
export const workspaceContext = sqliteTable(
  'workspace_context',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    content: text('content').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestampMs('created_at').notNull().default(nowDefault),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestampMs('updated_at').notNull().default(nowDefault),
  },
  (t) => ({
    uniqueKey: uniqueIndex('workspace_context_name_idx').on(t.workspaceId, t.name),
    wsIdx: index('workspace_context_ws_idx').on(t.workspaceId, t.updatedAt),
  }),
);

/** Immutable audit log of workspace context doc mutations (create/update/delete). */
export const workspaceContextChanges = sqliteTable(
  'workspace_context_changes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    action: text('action', { enum: ['create', 'update', 'delete'] }).notNull(),
    changedBy: text('changed_by').notNull(),
    changedAt: timestampMs('changed_at').notNull().default(nowDefault),
    snapshot: text('snapshot'),
  },
  (t) => ({
    wsIdx: index('workspace_context_changes_ws_idx').on(t.workspaceId, t.changedAt),
  }),
);

/**
 * Immutable audit log of policy rule mutations (create / archive).
 * Never hard-deleted. workspace_id IS NULL = global rule change.
 */
export const policyRuleChanges = sqliteTable(
  'policy_rule_changes',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id').notNull(),
    workspaceId: text('workspace_id'),
    action: text('action', { enum: ['create', 'archive'] }).notNull(),
    changedBy: text('changed_by').notNull(),
    changedAt: timestampMs('changed_at').notNull().default(nowDefault),
    snapshot: text('snapshot').notNull(),
  },
  (t) => ({
    ruleIdx: index('policy_rule_changes_rule_idx').on(t.ruleId, t.changedAt),
    userIdx: index('policy_rule_changes_user_idx').on(t.changedBy, t.changedAt),
  }),
);

/**
 * Per-agent, per-task working memory. Written by agents at end of work session
 * via the daemon (.forge/tasks/TASKID.memory file), persisted here by the hub.
 * Read back on next agent spawn for the same task to resume context.
 * Cleaned up automatically when the task row is deleted (ON DELETE CASCADE).
 */
export const agentMemory = sqliteTable(
  'agent_memory',
  {
    agentId: text('agent_id').notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    /** Compact markdown, max 1500 chars. */
    content: text('content').notNull(),
    updatedAt: timestampMs('updated_at').notNull().default(nowDefault),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agentId, t.taskId, t.workspaceId] }),
    // Index required for ON DELETE CASCADE FK enforcement (SQLite does not auto-index FK targets)
    taskIdx: index('agent_memory_task_idx').on(t.taskId),
  }),
);
