import type { Client } from '@libsql/client';

interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    name: '0000_init',
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hostname TEXT,
  platform TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  last_seen INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX devices_user_id_idx ON devices(user_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_prefix TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending_agent',
  priority TEXT NOT NULL DEFAULT 'normal',
  assigned_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  assigned_agent_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  completed_at INTEGER
);

CREATE INDEX tasks_status_idx ON tasks(status);

CREATE INDEX tasks_project_idx ON tasks(project_prefix);

CREATE INDEX tasks_assigned_device_idx ON tasks(assigned_device_id);

CREATE TABLE task_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX task_history_task_id_idx ON task_history(task_id);

CREATE TABLE task_instructions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  priority TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL,
  acknowledged_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX task_instructions_task_id_idx ON task_instructions(task_id);

CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX task_comments_task_id_idx ON task_comments(task_id);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  personality TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE agent_instances (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  runtime_instance_id TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  ended_at INTEGER
);

CREATE INDEX agent_instances_device_idx ON agent_instances(device_id);

CREATE INDEX agent_instances_task_idx ON agent_instances(task_id);

CREATE TABLE runtime_configs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX runtime_configs_user_idx ON runtime_configs(user_id);
`,
  },
  {
    name: '0001_workspaces',
    sql: `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  budget_monthly_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX workspaces_owner_idx ON workspaces(owner_user_id);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'collaborator', 'viewer')),
  joined_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);
`,
  },
  {
    name: '0002_workspace_scoping',
    sql: `
ALTER TABLE tasks ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
CREATE INDEX tasks_workspace_idx ON tasks(workspace_id);

ALTER TABLE agents ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
CREATE INDEX agents_workspace_idx ON agents(workspace_id);

ALTER TABLE agent_instances ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
CREATE INDEX agent_instances_workspace_idx ON agent_instances(workspace_id);

ALTER TABLE task_history ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
CREATE INDEX task_history_workspace_idx ON task_history(workspace_id);

ALTER TABLE task_instructions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
CREATE INDEX task_instructions_workspace_idx ON task_instructions(workspace_id);

ALTER TABLE task_comments ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
CREATE INDEX task_comments_workspace_idx ON task_comments(workspace_id);
`,
  },
  {
    name: '0003_invites',
    sql: `
CREATE TABLE invites (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  workspace_role TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  accepted_at INTEGER,
  accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX invites_token_hash_idx ON invites(token_hash);
`,
  },
  {
    name: '0004_goals',
    sql: `
CREATE TABLE goals (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX goals_workspace_idx ON goals(workspace_id);
CREATE INDEX goals_parent_idx ON goals(parent_id);

ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX tasks_parent_idx ON tasks(parent_id);

ALTER TABLE tasks ADD COLUMN goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL;
CREATE INDEX tasks_goal_idx ON tasks(goal_id);
`,
  },
  {
    name: '0005_fm_routing',
    sql: `
-- Forge Master routing infrastructure (Phase 1, Cycle 1)
-- Devices gain a logical agent role and device type classification.
-- Tasks gain an assignment timestamp for reassignment timeout.
-- New workspace_docs table provides the Scribe-maintained knowledge base.

ALTER TABLE devices ADD COLUMN agent_id TEXT;
ALTER TABLE devices ADD COLUMN device_type TEXT NOT NULL DEFAULT 'worker' CHECK (device_type IN ('worker', 'orchestrator'));

ALTER TABLE tasks ADD COLUMN assigned_at INTEGER;

CREATE TABLE workspace_docs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('architecture', 'api', 'pattern', 'adr', 'agent', 'feature', 'runbook')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'superseded')),
  superseded_by_id TEXT REFERENCES workspace_docs(id) ON DELETE SET NULL,
  superseded_reason TEXT,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX workspace_docs_active_idx ON workspace_docs(workspace_id, status);
CREATE INDEX workspace_docs_category_idx ON workspace_docs(workspace_id, category);
CREATE UNIQUE INDEX workspace_docs_key_idx ON workspace_docs(workspace_id, key);
`,
  },
  {
    name: '0006_device_status',
    sql: `
ALTER TABLE devices ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
CREATE INDEX devices_status_idx ON devices(status);
`,
  },
];

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function runMigrations(client: Client): Promise<void> {
  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute(
    `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
  );
  const res = await client.execute('SELECT name FROM _migrations');
  const applied = new Set<string>();
  for (const row of res.rows) {
    const name = row['name'];
    if (typeof name === 'string') applied.add(name);
  }
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    // Run each DDL statement individually — ALTER TABLE cannot be batched in libsql.
    for (const sql of splitStatements(m.sql)) {
      await client.execute({ sql, args: [] });
    }
    await client.execute({
      sql: 'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
      args: [m.name, Date.now()],
    });
  }
}
