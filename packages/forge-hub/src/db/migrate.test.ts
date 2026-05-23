import { describe, it, expect } from 'vitest';
import { createClient } from '@libsql/client';
import { runMigrations } from './migrate.js';

async function freshDb() {
  const client = createClient({ url: ':memory:' });
  await runMigrations(client);
  return client;
}

describe('runMigrations', () => {
  it('runs all migrations on a fresh database without error', async () => {
    const client = await freshDb();
    const res = await client.execute('SELECT name FROM _migrations ORDER BY name');
    const names = res.rows.map((r) => r['name'] as string);
    expect(names).toContain('0000_init');
    expect(names).toContain('0001_workspaces');
    expect(names).toContain('0002_workspace_scoping');
    client.close();
  });

  it('is idempotent — running twice does not error', async () => {
    const client = createClient({ url: ':memory:' });
    await runMigrations(client);
    await expect(runMigrations(client)).resolves.not.toThrow();
    client.close();
  });

  it('foreign_keys pragma is ON after migrations', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA foreign_keys');
    expect(res.rows[0]?.['foreign_keys']).toBe(1);
    client.close();
  });

  it('tasks table has workspace_id column', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA table_info(tasks)');
    const cols = res.rows.map((r) => r['name'] as string);
    expect(cols).toContain('workspace_id');
    client.close();
  });

  it('agents table has workspace_id column', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA table_info(agents)');
    const cols = res.rows.map((r) => r['name'] as string);
    expect(cols).toContain('workspace_id');
    client.close();
  });

  it('agent_instances table has workspace_id column', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA table_info(agent_instances)');
    const cols = res.rows.map((r) => r['name'] as string);
    expect(cols).toContain('workspace_id');
    client.close();
  });

  it('task_history table has workspace_id column', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA table_info(task_history)');
    const cols = res.rows.map((r) => r['name'] as string);
    expect(cols).toContain('workspace_id');
    client.close();
  });

  it('task_instructions table has workspace_id column', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA table_info(task_instructions)');
    const cols = res.rows.map((r) => r['name'] as string);
    expect(cols).toContain('workspace_id');
    client.close();
  });

  it('task_comments table has workspace_id column', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA table_info(task_comments)');
    const cols = res.rows.map((r) => r['name'] as string);
    expect(cols).toContain('workspace_id');
    client.close();
  });

  it('workspace_members.role CHECK constraint rejects invalid role', async () => {
    const client = await freshDb();
    await client.execute(
      `INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'a@b.com', 'hash', 'admin')`,
    );
    await client.execute(
      `INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES ('w1', 'Test', 'test', 'u1')`,
    );
    await expect(
      client.execute(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('w1', 'u1', 'superadmin')`,
      ),
    ).rejects.toThrow();
    client.close();
  });
});
