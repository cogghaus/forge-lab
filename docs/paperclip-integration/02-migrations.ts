/**
 * forge-lab Migrations: Paperclip Integration (v2)
 *
 * Hand-written SQL migrations matching the existing pattern in
 * packages/forge-hub/src/db/migrate.ts. Drop these into the MIGRATIONS
 * array in order. drizzle-kit comes in Phase 2 per the architecture doc.
 *
 * Each migration is one entry in MIGRATIONS. The migration runner splits
 * on semicolons, so keep each statement self-contained and end every one
 * with a semicolon.
 *
 * Confidence: 8/10. Validated against existing schema 2026-05-13.
 *
 * Order matters. Run in P2.0 sequence: 0001 → 0002 → 0003 → 0004 → 0005.
 */

// ============================================================================
// 0001_workspaces.sql (P2.0.1)
// ============================================================================

export const MIGRATION_0001_WORKSPACES = {
  name: '0001_workspaces',
  sql: `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active',
  budget_monthly_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX workspaces_owner_idx ON workspaces(owner_user_id);

CREATE INDEX workspaces_status_idx ON workspaces(status);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  joined_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);
`,
};

// ============================================================================
// 0002_workspace_scoping.sql (P2.0.2)
//
// Adds workspace_id to existing tables. SQLite doesn't support adding a
// NOT NULL column without a default, so we add nullable first, backfill,
// then table-swap to enforce NOT NULL.
//
// IMPORTANT: This migration assumes you want the backfill. If starting
// fresh (no existing data), the backfill block is a no-op and harmless.
// ============================================================================

export const MIGRATION_0002_WORKSPACE_SCOPING = {
  name: '0002_workspace_scoping',
  sql: `
-- Step 1: Add nullable workspace_id columns
ALTER TABLE tasks ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

ALTER TABLE agents ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

ALTER TABLE agent_instances ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

ALTER TABLE task_comments ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

ALTER TABLE task_instructions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

ALTER TABLE task_history ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);

-- Step 2: Backfill - create Default Workspace owned by the first admin
INSERT INTO workspaces (id, name, description, owner_user_id, status)
SELECT 'ws_default', 'Default Workspace', 'Auto-created during workspace migration', id, 'active'
FROM users
WHERE role = 'admin'
ORDER BY created_at ASC
LIMIT 1;

-- Step 3: Add the admin as owner-member of the Default Workspace
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT 'ws_default', id, 'owner'
FROM users
WHERE role = 'admin'
ORDER BY created_at ASC
LIMIT 1;

-- Step 4: Backfill workspace_id on existing rows
UPDATE tasks SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

UPDATE agents SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

UPDATE agent_instances SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

UPDATE task_comments SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

UPDATE task_instructions SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

UPDATE task_history SET workspace_id = 'ws_default' WHERE workspace_id IS NULL;

-- Step 5: Add indexes
CREATE INDEX tasks_workspace_idx ON tasks(workspace_id);

CREATE INDEX agents_workspace_idx ON agents(workspace_id);

CREATE INDEX agent_instances_workspace_idx ON agent_instances(workspace_id);

CREATE INDEX task_comments_workspace_idx ON task_comments(workspace_id);
`,
};

// NOTE on NOT NULL enforcement:
//
// To make workspace_id NOT NULL, you'd recreate the table:
//
//   CREATE TABLE tasks_new (... workspace_id TEXT NOT NULL REFERENCES workspaces(id) ...);
//   INSERT INTO tasks_new SELECT * FROM tasks;
//   DROP TABLE tasks;
//   ALTER TABLE tasks_new RENAME TO tasks;
//   CREATE INDEX tasks_status_idx ON tasks(status);
//   ... etc for all indexes
//
// This is doable but error-prone in raw SQL. Recommended approach:
//   - Phase A: Land 0002 (nullable column + backfill). All routes enforce
//     workspace_id at the service layer.
//   - Phase B (later): A dedicated 0002b migration does the table-swap once
//     you're confident nothing is inserting NULL.
//
// For most of forge-lab's needs, "NOT NULL at the service layer" is
// sufficient and simpler.

// ============================================================================
// 0003_invites.sql (P2.0.4)
// ============================================================================

export const MIGRATION_0003_INVITES = {
  name: '0003_invites',
  sql: `
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  invited_by_user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  workspace_role TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by_user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX invites_email_idx ON invites(email);

CREATE INDEX invites_workspace_idx ON invites(workspace_id);
`,
};

// ============================================================================
// 0004_goals_and_task_hierarchy.sql (P2.1.3)
// ============================================================================

export const MIGRATION_0004_GOALS = {
  name: '0004_goals_and_task_hierarchy',
  sql: `
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by_user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX goals_workspace_idx ON goals(workspace_id);

CREATE INDEX goals_status_idx ON goals(status);

ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id);

ALTER TABLE tasks ADD COLUMN goal_id TEXT REFERENCES goals(id);

CREATE INDEX tasks_parent_idx ON tasks(parent_id);

CREATE INDEX tasks_goal_idx ON tasks(goal_id);
`,
};

// ============================================================================
// 0005_entity_history.sql (P2.1.2)
//
// Generalizes task_history to support non-task entities. Adds entity_type
// and entity_id columns, backfills existing rows.
// ============================================================================

export const MIGRATION_0005_ENTITY_HISTORY = {
  name: '0005_entity_history',
  sql: `
ALTER TABLE task_history ADD COLUMN entity_type TEXT;

ALTER TABLE task_history ADD COLUMN entity_id TEXT;

UPDATE task_history SET entity_type = 'task', entity_id = task_id WHERE entity_type IS NULL;

CREATE INDEX task_history_entity_idx ON task_history(entity_type, entity_id);
`,
};
// NOTE: We keep the table name as task_history for compatibility. The
// (entity_type, entity_id) pair becomes the canonical lookup; task_id
// stays as a denormalized convenience column.

// ============================================================================
// 0006_runs_and_costs.sql (P2.2.3, P2.2.4)
// ============================================================================

export const MIGRATION_0006_RUNS_AND_COSTS = {
  name: '0006_runs_and_costs',
  sql: `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  agent_instance_id TEXT REFERENCES agent_instances(id),
  task_id TEXT REFERENCES tasks(id),
  wakeup_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  trigger_reason TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  session_id TEXT,
  exit_code INTEGER,
  error_text TEXT,
  stdout_path TEXT,
  stderr_path TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX runs_workspace_idx ON runs(workspace_id);

CREATE INDEX runs_agent_idx ON runs(agent_id);

CREATE INDEX runs_task_idx ON runs(task_id);

CREATE INDEX runs_status_idx ON runs(status);

CREATE TABLE cost_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  run_id TEXT REFERENCES runs(id),
  task_id TEXT REFERENCES tasks(id),
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX cost_events_workspace_created_idx ON cost_events(workspace_id, created_at);

CREATE INDEX cost_events_agent_created_idx ON cost_events(agent_id, created_at);
`,
};

// ============================================================================
// 0007_wakeups.sql (P2.2.2)
// ============================================================================

export const MIGRATION_0007_WAKEUPS = {
  name: '0007_wakeups',
  sql: `
CREATE TABLE wakeups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  trigger_entity_type TEXT,
  trigger_entity_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  coalesced_into_id TEXT,
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  run_id TEXT REFERENCES runs(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX wakeups_agent_state_idx ON wakeups(agent_id, state);

CREATE INDEX wakeups_state_scheduled_idx ON wakeups(state, scheduled_at);
`,
};

// ============================================================================
// 0008_approvals.sql (P2.3.2)
// ============================================================================

export const MIGRATION_0008_APPROVALS = {
  name: '0008_approvals',
  sql: `
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by_agent_id TEXT REFERENCES agents(id),
  payload TEXT NOT NULL,
  decision_note TEXT,
  decided_by_user_id TEXT REFERENCES users(id),
  decided_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX approvals_workspace_status_idx ON approvals(workspace_id, status);

CREATE INDEX approvals_requester_idx ON approvals(requested_by_agent_id);
`,
};

// ============================================================================
// 0009_agent_lifecycle_and_budget.sql (P2.3.1, P2.3.3, P2.4.1)
// ============================================================================

export const MIGRATION_0009_AGENT_LIFECYCLE = {
  name: '0009_agent_lifecycle_and_budget',
  sql: `
ALTER TABLE agents ADD COLUMN budget_monthly_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE agents ADD COLUMN reports_to TEXT REFERENCES agents(id);

ALTER TABLE agents ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE agents ADD COLUMN pause_reason TEXT;

CREATE INDEX agents_reports_to_idx ON agents(reports_to);

CREATE INDEX agents_lifecycle_idx ON agents(lifecycle_status);
`,
};
// lifecycle_status enum: 'active', 'paused', 'terminated'
// (kept separate from agent_instances.status which is the runtime state)
