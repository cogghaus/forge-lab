import { describe, it, expect } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { runMigrations, MIGRATIONS } from './migrate.js';

async function freshDb() {
  const client = createClient({ url: ':memory:' });
  await runMigrations(client);
  return client;
}

/**
 * Apply every migration up to (but excluding) `stopBeforeName`, mirroring
 * runMigrations' own statement-splitting so the resulting db is in the exact
 * pre-migration state a real deploy would be in. Used to test 0018's backfill
 * against pre-existing in_progress rows that predate the lease columns.
 */
async function dbBeforeMigration(stopBeforeName: string): Promise<Client> {
  const client = createClient({ url: ':memory:' });
  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute(
    `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
  );
  for (const m of MIGRATIONS) {
    if (m.name === stopBeforeName) break;
    for (const stmt of m.sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0)) {
      await client.execute({ sql: stmt, args: [] });
    }
    await client.execute({
      sql: 'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
      args: [m.name, Date.now()],
    });
  }
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

  it('tasks.workspace_id FK is enforced — inserting nonexistent workspace_id fails', async () => {
    const client = await freshDb();
    await client.execute(
      `INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'a@b.com', 'hash', 'admin')`,
    );
    await expect(
      client.execute(
        `INSERT INTO tasks (id, project_prefix, title, status, priority, created_by, workspace_id)
         VALUES ('fl-001', 'fl', 'Test', 'pending_agent', 'normal', 'u1', 'nonexistent-ws')`,
      ),
    ).rejects.toThrow();
    client.close();
  });

  it('task_history, task_instructions, task_comments have workspace_id indexes', async () => {
    const client = await freshDb();
    const indexRes = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%workspace%'`,
    );
    const idxNames = indexRes.rows.map((r) => r['name'] as string);
    expect(idxNames).toContain('task_history_workspace_idx');
    expect(idxNames).toContain('task_instructions_workspace_idx');
    expect(idxNames).toContain('task_comments_workspace_idx');
    client.close();
  });

  // ---------------------------------------------------------------------------
  // 0005_fm_routing
  // ---------------------------------------------------------------------------

  it('migration 0005_fm_routing is recorded', async () => {
    const client = await freshDb();
    const res = await client.execute('SELECT name FROM _migrations ORDER BY name');
    const names = res.rows.map((r) => r['name'] as string);
    expect(names).toContain('0005_fm_routing');
    client.close();
  });

  it('devices table has agent_id column', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA table_info(devices)');
    const cols = res.rows.map((r) => r['name'] as string);
    expect(cols).toContain('agent_id');
    client.close();
  });

  it('devices.agent_id is nullable — inserting NULL succeeds', async () => {
    const client = await freshDb();
    await client.execute(
      `INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'a@b.com', 'hash', 'admin')`,
    );
    await expect(
      client.execute(
        `INSERT INTO devices (id, user_id, name, token_hash, agent_id)
         VALUES ('d1', 'u1', 'test', 'hash1', NULL)`,
      ),
    ).resolves.not.toThrow();
    client.close();
  });

  it('devices table has device_type column defaulting to worker', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA table_info(devices)');
    const cols = res.rows.map((r) => r['name'] as string);
    expect(cols).toContain('device_type');
    // Verify default value is 'worker'
    const dfltRes = res.rows.find((r) => r['name'] === 'device_type');
    expect(dfltRes?.['dflt_value']).toBe("'worker'");
    client.close();
  });

  it('devices.device_type CHECK constraint rejects invalid value', async () => {
    const client = await freshDb();
    await client.execute(
      `INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'a@b.com', 'hash', 'admin')`,
    );
    await expect(
      client.execute(
        `INSERT INTO devices (id, user_id, name, token_hash, device_type)
         VALUES ('d1', 'u1', 'test', 'hash1', 'supervisor')`,
      ),
    ).rejects.toThrow();
    client.close();
  });

  it('tasks table has assigned_at column', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA table_info(tasks)');
    const cols = res.rows.map((r) => r['name'] as string);
    expect(cols).toContain('assigned_at');
    client.close();
  });

  it('tasks.assigned_at is nullable — inserting NULL succeeds', async () => {
    const client = await freshDb();
    await client.execute(
      `INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'a@b.com', 'hash', 'admin')`,
    );
    await client.execute(
      `INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES ('w1', 'Test', 'test', 'u1')`,
    );
    await expect(
      client.execute(
        `INSERT INTO tasks (id, project_prefix, title, status, priority, created_by, workspace_id, assigned_at)
         VALUES ('fl-001', 'fl', 'Test', 'pending_agent', 'normal', 'u1', 'w1', NULL)`,
      ),
    ).resolves.not.toThrow();
    client.close();
  });

  it('workspace_docs table exists with required columns', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA table_info(workspace_docs)');
    const cols = res.rows.map((r) => r['name'] as string);
    expect(cols).toContain('id');
    expect(cols).toContain('workspace_id');
    expect(cols).toContain('key');
    expect(cols).toContain('title');
    expect(cols).toContain('content');
    expect(cols).toContain('category');
    expect(cols).toContain('status');
    expect(cols).toContain('superseded_by_id');
    expect(cols).toContain('superseded_reason');
    expect(cols).toContain('updated_by');
    expect(cols).toContain('updated_at');
    expect(cols).toContain('created_at');
    client.close();
  });

  it('workspace_docs.status defaults to active', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA table_info(workspace_docs)');
    const statusRow = res.rows.find((r) => r['name'] === 'status');
    expect(statusRow?.['dflt_value']).toBe("'active'");
    client.close();
  });

  it('workspace_docs.status CHECK constraint rejects invalid value', async () => {
    const client = await freshDb();
    await client.execute(
      `INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'a@b.com', 'hash', 'admin')`,
    );
    await client.execute(
      `INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES ('w1', 'Test', 'test', 'u1')`,
    );
    await expect(
      client.execute(
        `INSERT INTO workspace_docs (id, workspace_id, key, title, content, category, status, updated_by)
         VALUES ('d1', 'w1', 'test-key', 'Test', 'content', 'architecture', 'draft', 'scribe')`,
      ),
    ).rejects.toThrow();
    client.close();
  });

  it('workspace_docs.category CHECK constraint rejects invalid value', async () => {
    const client = await freshDb();
    await client.execute(
      `INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'a@b.com', 'hash', 'admin')`,
    );
    await client.execute(
      `INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES ('w1', 'Test', 'test', 'u1')`,
    );
    await expect(
      client.execute(
        `INSERT INTO workspace_docs (id, workspace_id, key, title, content, category, updated_by)
         VALUES ('d1', 'w1', 'test-key', 'Test', 'content', 'unknown', 'scribe')`,
      ),
    ).rejects.toThrow();
    client.close();
  });

  it('workspace_docs(workspace_id, key) unique constraint is enforced', async () => {
    const client = await freshDb();
    await client.execute(
      `INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'a@b.com', 'hash', 'admin')`,
    );
    await client.execute(
      `INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES ('w1', 'Test', 'test', 'u1')`,
    );
    await client.execute(
      `INSERT INTO workspace_docs (id, workspace_id, key, title, content, category, updated_by)
       VALUES ('d1', 'w1', 'architecture-overview', 'Arch', 'content', 'architecture', 'scribe')`,
    );
    await expect(
      client.execute(
        `INSERT INTO workspace_docs (id, workspace_id, key, title, content, category, updated_by)
         VALUES ('d2', 'w1', 'architecture-overview', 'Arch2', 'content2', 'architecture', 'scribe')`,
      ),
    ).rejects.toThrow();
    client.close();
  });

  it('same key allowed in different workspaces', async () => {
    const client = await freshDb();
    await client.execute(
      `INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'a@b.com', 'hash', 'admin')`,
    );
    await client.execute(
      `INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES ('w1', 'WS1', 'ws1', 'u1')`,
    );
    await client.execute(
      `INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES ('w2', 'WS2', 'ws2', 'u1')`,
    );
    await client.execute(
      `INSERT INTO workspace_docs (id, workspace_id, key, title, content, category, updated_by)
       VALUES ('d1', 'w1', 'architecture-overview', 'Arch', 'content', 'architecture', 'scribe')`,
    );
    // Same key in different workspace — should succeed
    await expect(
      client.execute(
        `INSERT INTO workspace_docs (id, workspace_id, key, title, content, category, updated_by)
         VALUES ('d2', 'w2', 'architecture-overview', 'Arch', 'content', 'architecture', 'scribe')`,
      ),
    ).resolves.not.toThrow();
    client.close();
  });

  it('workspace_docs CASCADE deletes when workspace is deleted', async () => {
    const client = await freshDb();
    await client.execute(
      `INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'a@b.com', 'hash', 'admin')`,
    );
    await client.execute(
      `INSERT INTO workspaces (id, name, slug, owner_user_id) VALUES ('w1', 'Test', 'test', 'u1')`,
    );
    await client.execute(
      `INSERT INTO workspace_docs (id, workspace_id, key, title, content, category, updated_by)
       VALUES ('d1', 'w1', 'arch', 'Arch', 'content', 'architecture', 'scribe')`,
    );
    // Workspaces use soft-delete (status='deleted') so we test FK directly via DELETE
    await client.execute(`DELETE FROM workspaces WHERE id = 'w1'`);
    const res = await client.execute(`SELECT id FROM workspace_docs WHERE id = 'd1'`);
    expect(res.rows).toHaveLength(0);
    client.close();
  });

  it('workspace_docs has composite indexes for active and category queries', async () => {
    const client = await freshDb();
    const indexRes = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'workspace_docs%'`,
    );
    const idxNames = indexRes.rows.map((r) => r['name'] as string);
    expect(idxNames).toContain('workspace_docs_active_idx');
    expect(idxNames).toContain('workspace_docs_category_idx');
    expect(idxNames).toContain('workspace_docs_key_idx');
    client.close();
  });

  // ---------------------------------------------------------------------------
  // 0018_task_lease (M3 issue 1)
  // ---------------------------------------------------------------------------

  it('migration 0018_task_lease is recorded', async () => {
    const client = await freshDb();
    const res = await client.execute('SELECT name FROM _migrations ORDER BY name');
    const names = res.rows.map((r) => r['name'] as string);
    expect(names).toContain('0018_task_lease');
    client.close();
  });

  it('tasks table has lease_expires_at and reclaim_count columns', async () => {
    const client = await freshDb();
    const res = await client.execute('PRAGMA table_info(tasks)');
    const cols = res.rows.map((r) => r['name'] as string);
    expect(cols).toContain('lease_expires_at');
    expect(cols).toContain('reclaim_count');
    client.close();
  });

  it('reclaim_count defaults to 0', async () => {
    const client = await freshDb();
    await client.execute(
      `INSERT INTO tasks (id, project_prefix, title, status, priority, created_by)
       VALUES ('fl-001', 'fl', 'Test', 'pending_agent', 'normal', 'u1')`,
    );
    const res = await client.execute(`SELECT reclaim_count FROM tasks WHERE id = 'fl-001'`);
    expect(res.rows[0]?.['reclaim_count']).toBe(0);
    client.close();
  });

  it('tasks_lease_idx index exists', async () => {
    const client = await freshDb();
    const indexRes = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='index' AND name = 'tasks_lease_idx'`,
    );
    expect(indexRes.rows).toHaveLength(1);
    client.close();
  });

  it('backfills lease_expires_at for pre-existing in_progress rows', async () => {
    // Set up a db at the exact state a real deploy would be in just before
    // 0018 runs: an in_progress task from before the lease columns existed.
    const client = await dbBeforeMigration('0018_task_lease');
    await client.execute(
      `INSERT INTO tasks (id, project_prefix, title, status, priority, created_by)
       VALUES ('fl-001', 'fl', 'Legacy in-flight task', 'in_progress', 'normal', 'u1')`,
    );
    await client.execute(
      `INSERT INTO tasks (id, project_prefix, title, status, priority, created_by)
       VALUES ('fl-002', 'fl', 'Legacy pending task', 'pending_agent', 'normal', 'u1')`,
    );

    const before = Date.now();
    await runMigrations(client); // applies 0018_task_lease and its backfill

    const res = await client.execute(
      `SELECT id, status, lease_expires_at FROM tasks ORDER BY id`,
    );
    const rows = res.rows as unknown as Array<{ id: string; status: string; lease_expires_at: number | null }>;

    const inProgressRow = rows.find((r) => r.id === 'fl-001');
    expect(inProgressRow?.status).toBe('in_progress');
    // Backfilled to now + 1800s (the default TTL), so it must land comfortably
    // in the future relative to the migration run, not be left NULL.
    expect(inProgressRow?.lease_expires_at).not.toBeNull();
    expect(inProgressRow!.lease_expires_at as number).toBeGreaterThan(before + 1_000_000);

    // A pending_agent row was never leased and must NOT be backfilled.
    const pendingRow = rows.find((r) => r.id === 'fl-002');
    expect(pendingRow?.lease_expires_at).toBeNull();

    client.close();
  });

  it('is idempotent for 0018 - running migrations twice does not re-backfill or error', async () => {
    const client = await dbBeforeMigration('0018_task_lease');
    await client.execute(
      `INSERT INTO tasks (id, project_prefix, title, status, priority, created_by)
       VALUES ('fl-001', 'fl', 'Legacy in-flight task', 'in_progress', 'normal', 'u1')`,
    );
    await runMigrations(client);
    const firstRes = await client.execute(`SELECT lease_expires_at FROM tasks WHERE id = 'fl-001'`);
    const firstLease = firstRes.rows[0]?.['lease_expires_at'];

    await expect(runMigrations(client)).resolves.not.toThrow();
    const secondRes = await client.execute(`SELECT lease_expires_at FROM tasks WHERE id = 'fl-001'`);
    expect(secondRes.rows[0]?.['lease_expires_at']).toBe(firstLease);

    client.close();
  });
});
