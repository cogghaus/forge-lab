import { eq, and, gt } from 'drizzle-orm';
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

export async function createSession(
  db: Db,
  userId: string,
  ttlHours: number,
): Promise<CreatedSession> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const id = nanoid();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await db.insert(schema.sessions).values({ id, userId, tokenHash, expiresAt });
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
