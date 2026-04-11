import type { Client, InStatement } from '@libsql/client';

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
];

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function runMigrations(client: Client): Promise<void> {
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
    const statements: InStatement[] = splitStatements(m.sql).map((sql) => ({ sql, args: [] }));
    statements.push({
      sql: 'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
      args: [m.name, Date.now()],
    });
    await client.batch(statements, 'write');
  }
}
