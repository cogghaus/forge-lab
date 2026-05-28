/**
 * Heimdall policy engine unit tests.
 *
 * Tests run against the in-memory built-in rule set. Audit log tests use an
 * in-process :memory: SQLite DB with migrations applied.
 *
 * Failing-first: these tests were written before engine.ts existed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { schema } from '@forge-lab/core';
import { runMigrations } from '../db/migrate.js';
import { checkPolicy, type PolicyPrincipal, type PolicyResource } from './engine.js';
import type { Db } from '../db/index.js';

// ---------------------------------------------------------------------------
// Test DB factory
// ---------------------------------------------------------------------------

async function openTestDb(): Promise<{ db: Db; raw: Client; close: () => void }> {
  const raw = createClient({ url: ':memory:' });
  await runMigrations(raw);
  const db = drizzle(raw, { schema }) as unknown as Db;
  return { db, raw, close: () => raw.close() };
}

// ---------------------------------------------------------------------------
// Principal factories
// ---------------------------------------------------------------------------

const fmDevice: PolicyPrincipal = {
  type: 'device',
  id: 'dev-fm',
  agentId: 'forge-master',
  deviceType: 'orchestrator',
};

const scribeDevice: PolicyPrincipal = {
  type: 'device',
  id: 'dev-scribe',
  agentId: 'scribe',
  deviceType: 'worker',
};

const furnaceDevice: PolicyPrincipal = {
  type: 'device',
  id: 'dev-furnace',
  agentId: 'furnace',
  deviceType: 'worker',
};

const orchestratorNonFm: PolicyPrincipal = {
  type: 'device',
  id: 'dev-other-orch',
  agentId: 'monitoring',
  deviceType: 'orchestrator',
};

const memberUser: PolicyPrincipal = {
  type: 'user',
  id: 'user-member',
  memberWorkspaces: ['ws-1', 'ws-2'],
  workspaceRole: 'collaborator',
};

const nonMemberUser: PolicyPrincipal = {
  type: 'user',
  id: 'user-non-member',
  memberWorkspaces: ['ws-99'],
  // workspaceRole intentionally omitted — not a member of ws-1
};

// ---------------------------------------------------------------------------
// Resource factories
// ---------------------------------------------------------------------------

const taskInWs1: PolicyResource = {
  type: 'task',
  id: 'task-1',
  workspaceId: 'ws-1',
};

const docInWs1: PolicyResource = {
  type: 'doc',
  id: 'doc-1',
  workspaceId: 'ws-1',
};

// ---------------------------------------------------------------------------
// Suite: allow rule matches
// ---------------------------------------------------------------------------

describe('checkPolicy — allow rule matches', () => {
  it('FM device can assign tasks (agent:forge-master allow @ 200)', async () => {
    const decision = await checkPolicy(fmDevice, 'task:assign', taskInWs1, {});
    expect(decision.allowed).toBe(true);
    expect(decision.effect).toBe('allow');
    expect(decision.rule).not.toBeNull();
  });

  it('Scribe device can write docs despite being role:worker (agent:scribe allow @ 200)', async () => {
    const decision = await checkPolicy(scribeDevice, 'doc:write', docInWs1, {});
    expect(decision.allowed).toBe(true);
    expect(decision.effect).toBe('allow');
  });

  it('Any orchestrator device can write docs (role:orchestrator allow @ 150, backward compat)', async () => {
    const decision = await checkPolicy(orchestratorNonFm, 'doc:write', docInWs1, {});
    expect(decision.allowed).toBe(true);
    expect(decision.effect).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Suite: deny rule matches
// ---------------------------------------------------------------------------

describe('checkPolicy — deny rule matches', () => {
  it('Worker device cannot assign tasks (role:worker deny @ 100)', async () => {
    const decision = await checkPolicy(furnaceDevice, 'task:assign', taskInWs1, {});
    expect(decision.allowed).toBe(false);
    expect(decision.effect).toBe('deny');
  });

  it('Non-Scribe worker cannot write docs (role:worker deny @ 100)', async () => {
    const decision = await checkPolicy(furnaceDevice, 'doc:write', docInWs1, {});
    expect(decision.allowed).toBe(false);
    expect(decision.effect).toBe('deny');
    expect(decision.principal).toMatch(/role:worker/);
  });

  it('Orchestrator device cannot claim tasks (role:orchestrator deny @ 100)', async () => {
    const decision = await checkPolicy(fmDevice, 'task:claim', taskInWs1, {});
    expect(decision.allowed).toBe(false);
    expect(decision.effect).toBe('deny');
  });

  it('Worker device can claim tasks (role:worker allow @ 50)', async () => {
    const decision = await checkPolicy(furnaceDevice, 'task:claim', taskInWs1, {});
    expect(decision.allowed).toBe(true);
    expect(decision.effect).toBe('allow');
  });

  it('User cannot claim tasks (user:* deny @ 10)', async () => {
    const decision = await checkPolicy(memberUser, 'task:claim', taskInWs1, {});
    expect(decision.allowed).toBe(false);
    expect(decision.effect).toBe('deny');
  });

  it('User cannot assign tasks (user:* deny @ 10)', async () => {
    const decision = await checkPolicy(memberUser, 'task:assign', taskInWs1, {});
    expect(decision.allowed).toBe(false);
    expect(decision.effect).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Suite: default deny (no matching rule)
// ---------------------------------------------------------------------------

describe('checkPolicy — default deny', () => {
  it('Unknown action with no matching rule returns default deny', async () => {
    const decision = await checkPolicy(furnaceDevice, 'unknown:action', taskInWs1, {});
    expect(decision.allowed).toBe(false);
    expect(decision.effect).toBe('deny');
    expect(decision.rule).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite: priority evaluation
// ---------------------------------------------------------------------------

describe('checkPolicy — priority', () => {
  it('agent:scribe allow @ 200 overrides role:worker deny @ 100 (Scribe can write docs)', async () => {
    // Scribe is simultaneously agent:scribe AND role:worker.
    // The allow at priority 200 must win over the deny at priority 100.
    const decision = await checkPolicy(scribeDevice, 'doc:write', docInWs1, {});
    expect(decision.allowed).toBe(true);
  });

  it('role:worker deny @ 100 applies when no agent-specific allow rule exists', async () => {
    const decision = await checkPolicy(furnaceDevice, 'task:assign', taskInWs1, {});
    expect(decision.allowed).toBe(false);
    expect(decision.effect).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// Suite: user rules with conditions
// ---------------------------------------------------------------------------

describe('checkPolicy — user rules with workspace conditions', () => {
  it('workspace member can cancel tasks', async () => {
    const decision = await checkPolicy(
      memberUser,
      'task:cancel',
      { type: 'task', id: 'task-1', workspaceId: 'ws-1' },
      {},
    );
    expect(decision.allowed).toBe(true);
  });

  it('non-member user cannot cancel tasks in workspace they do not belong to', async () => {
    const decision = await checkPolicy(
      nonMemberUser,
      'task:cancel',
      { type: 'task', id: 'task-1', workspaceId: 'ws-1' },
      {},
    );
    expect(decision.allowed).toBe(false);
  });

  it('collaborator user can write docs (workspace_role_gte collaborator)', async () => {
    const decision = await checkPolicy(
      memberUser,
      'doc:write',
      { type: 'doc', id: 'doc-1', workspaceId: 'ws-1' },
      {},
    );
    expect(decision.allowed).toBe(true);
  });

  it('viewer user cannot write docs (workspaceRole=viewer < collaborator)', async () => {
    const viewerUser: PolicyPrincipal = {
      type: 'user',
      id: 'user-viewer',
      memberWorkspaces: ['ws-1'],
      workspaceRole: 'viewer',
    };
    const decision = await checkPolicy(
      viewerUser,
      'doc:write',
      { type: 'doc', id: 'doc-1', workspaceId: 'ws-1' },
      {},
    );
    expect(decision.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite: audit log
// ---------------------------------------------------------------------------

describe('checkPolicy — audit log', () => {
  let db: Db;
  let raw: Client;
  let close: () => void;

  beforeEach(async () => {
    ({ db, raw, close } = await openTestDb());
  });

  afterEach(() => {
    close();
  });

  it('writes policy_decisions row on allow', async () => {
    await checkPolicy(fmDevice, 'task:assign', taskInWs1, { db, workspaceId: 'ws-1' });

    const rows = await raw.execute('SELECT * FROM policy_decisions');
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row['effect']).toBe('allow');
    expect(row['action']).toBe('task:assign');
    expect(row['workspace_id']).toBe('ws-1');
    expect(row['rule_id']).not.toBeNull();
  });

  it('writes policy_decisions row on deny', async () => {
    await checkPolicy(furnaceDevice, 'task:assign', taskInWs1, { db, workspaceId: 'ws-1' });

    const rows = await raw.execute('SELECT * FROM policy_decisions');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!['effect']).toBe('deny');
  });

  it('writes policy_decisions row on default deny with rule_id = null', async () => {
    await checkPolicy(furnaceDevice, 'unknown:action', taskInWs1, { db, workspaceId: 'ws-1' });

    const rows = await raw.execute('SELECT * FROM policy_decisions');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!['effect']).toBe('deny');
    expect(rows.rows[0]!['rule_id']).toBeNull();
  });

  it('audit log write failure does not throw — checkPolicy resolves even with no db', async () => {
    const decision = await checkPolicy(fmDevice, 'task:assign', taskInWs1, {});
    expect(decision.allowed).toBe(true);
  });
});
