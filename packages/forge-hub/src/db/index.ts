import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { schema } from '@forge-lab/core';

export type Db = LibSQLDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  raw: Client;
  close(): void;
}

/**
 * databaseUrl: libsql URL.
 *   ':memory:'  -> in-memory (tests)
 *   'file:./hub.db'  -> local file
 */
export function openDatabase(databaseUrl: string): DbHandle {
  const url = databaseUrl === ':memory:' ? ':memory:' : databaseUrl;
  const raw = createClient({ url });
  const db = drizzle(raw, { schema });
  return {
    db,
    raw,
    close: () => raw.close(),
  };
}
