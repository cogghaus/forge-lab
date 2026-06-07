import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createSession, pruneExpiredSessionsGlobal } from './sessions.js';
import { hashPassword } from './password.js';
import { hashToken } from './tokens.js';
import { schema } from '@forge-lab/core';
import { nanoid } from 'nanoid';

async function freshHandle(): Promise<DbHandle> {
  const handle = openDatabase(':memory:');
  await runMigrations(handle.raw);
  return handle;
}

async function insertUser(handle: DbHandle, email: string): Promise<string> {
  const id = nanoid();
  const passwordHash = await hashPassword('password123', 4);
  await handle.db.insert(schema.users).values({ id, email, passwordHash, role: 'user' });
  return id;
}

/** Insert a session row directly, bypassing createSession's built-in prune. */
async function insertExpiredSession(handle: DbHandle, userId: string): Promise<void> {
  await handle.db.insert(schema.sessions).values({
    id: nanoid(),
    userId,
    tokenHash: hashToken(nanoid()),
    expiresAt: new Date(Date.now() - 60_000), // 1 minute in the past
    lastSeenAt: null,
    userAgent: null,
    ipAddress: null,
  });
}

describe('pruneExpiredSessionsGlobal', () => {
  let handle: DbHandle;

  beforeEach(async () => {
    handle = await freshHandle();
  });

  afterEach(() => {
    handle.close();
  });

  it('deletes expired sessions across all users', async () => {
    const u1 = await insertUser(handle, 'a@example.com');
    const u2 = await insertUser(handle, 'b@example.com');

    // One live session per user, one expired per user inserted directly.
    await createSession(handle.db, u1, 24);
    await insertExpiredSession(handle, u1);
    await createSession(handle.db, u2, 24);
    await insertExpiredSession(handle, u2);

    const deleted = await pruneExpiredSessionsGlobal(handle.db);

    expect(deleted).toBe(2);
    const remaining = await handle.db.select({ id: schema.sessions.id }).from(schema.sessions).all();
    expect(remaining).toHaveLength(2);
  });

  it('returns 0 when no expired sessions exist', async () => {
    const u1 = await insertUser(handle, 'a@example.com');
    await createSession(handle.db, u1, 24);

    const deleted = await pruneExpiredSessionsGlobal(handle.db);
    expect(deleted).toBe(0);
  });

  it('returns 0 on empty table', async () => {
    const deleted = await pruneExpiredSessionsGlobal(handle.db);
    expect(deleted).toBe(0);
  });
});
