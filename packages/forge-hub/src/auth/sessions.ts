import { eq, and, gt, ne, lt, or, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { schema } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { generateToken, hashToken } from './tokens.js';

export interface CreatedSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
}

export interface SessionMeta {
  userAgent?: string | null;
  ipAddress?: string | null;
}

/** Only bump last_seen_at when it's at least this stale, to avoid a write per request. */
const TOUCH_THROTTLE_MS = 5 * 60 * 1000;

export async function createSession(
  db: Db,
  userId: string,
  ttlHours: number,
  meta: SessionMeta = {},
): Promise<CreatedSession> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const id = nanoid();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
  await db.insert(schema.sessions).values({
    id,
    userId,
    tokenHash,
    expiresAt,
    userAgent: meta.userAgent ?? null,
    ipAddress: meta.ipAddress ?? null,
    lastSeenAt: now,
  });
  return { id, userId, token, expiresAt };
}

export async function verifySession(
  db: Db,
  token: string,
): Promise<{ id: string; userId: string; expiresAt: Date } | null> {
  const tokenHash = hashToken(token);
  const row = await db
    .select({
      id: schema.sessions.id,
      userId: schema.sessions.userId,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .where(
      and(eq(schema.sessions.tokenHash, tokenHash), gt(schema.sessions.expiresAt, new Date())),
    )
    .get();
  return row ?? null;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash));
}

export interface SessionListItem {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  expiresAt: Date;
  /** True for the session making the request (matched by token hash). */
  current: boolean;
}

/** Lists a user's non-expired sessions, flagging the one owning `currentToken`. */
export async function listSessions(
  db: Db,
  userId: string,
  currentToken: string,
): Promise<SessionListItem[]> {
  const currentHash = hashToken(currentToken);
  const rows = await db
    .select({
      id: schema.sessions.id,
      tokenHash: schema.sessions.tokenHash,
      userAgent: schema.sessions.userAgent,
      ipAddress: schema.sessions.ipAddress,
      createdAt: schema.sessions.createdAt,
      lastSeenAt: schema.sessions.lastSeenAt,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), gt(schema.sessions.expiresAt, new Date())))
    .all();

  return rows
    .map((r) => ({
      id: r.id,
      userAgent: r.userAgent,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt,
      current: r.tokenHash === currentHash,
    }))
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      const at = (a.lastSeenAt ?? a.createdAt).getTime();
      const bt = (b.lastSeenAt ?? b.createdAt).getTime();
      return bt - at;
    });
}

/** Revokes one of a user's sessions by id. Returns false if it isn't theirs. */
export async function revokeSessionById(db: Db, userId: string, sessionId: string): Promise<boolean> {
  const res = await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, userId)))
    .run();
  return res.rowsAffected > 0;
}

/** Revokes every session for the user except the one owning `currentToken`. */
export async function revokeOtherSessions(
  db: Db,
  userId: string,
  currentToken: string,
): Promise<number> {
  const currentHash = hashToken(currentToken);
  const res = await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.tokenHash, currentHash)))
    .run();
  return res.rowsAffected;
}

/** Bumps last_seen_at for the session owning `token`, throttled to one write per window. */
export async function touchSession(db: Db, token: string): Promise<void> {
  const tokenHash = hashToken(token);
  const now = new Date();
  const threshold = new Date(now.getTime() - TOUCH_THROTTLE_MS);
  await db
    .update(schema.sessions)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(schema.sessions.tokenHash, tokenHash),
        or(isNull(schema.sessions.lastSeenAt), lt(schema.sessions.lastSeenAt, threshold)),
      ),
    )
    .run();
}
