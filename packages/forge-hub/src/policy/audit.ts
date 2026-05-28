/**
 * Heimdall policy audit log.
 *
 * Writes policy_decisions rows asynchronously. Errors are logged but never
 * propagate to the caller — audit writes are non-blocking fire-and-forget.
 */

import { nanoid } from 'nanoid';
import type { Db } from '../db/index.js';
import type { PolicyDecision } from './engine.js';

export interface AuditContext {
  db?: Db;
  workspaceId?: string;
}

export interface AuditEntry {
  principal: string;
  action: string;
  resourceId?: string | null;
  decision: PolicyDecision;
}

/**
 * Write a policy_decisions row for this decision.
 * Uses the raw libsql client obtained from the drizzle db object.
 * Non-blocking: caller should fire-and-forget (void logDecision(...)).
 */
export async function logDecision(entry: AuditEntry, ctx: AuditContext): Promise<void> {
  if (!ctx.db) return; // no DB context — skip audit (e.g. unit tests)

  try {
    // Access the underlying libsql client from the drizzle wrapper.
    // LibSQLDatabase exposes .$client in drizzle-orm >= 0.30 (used here via the
    // internal session object). We use raw execute to avoid adding policy_decisions
    // to the Drizzle schema in Phase 1.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = (ctx.db as any).$client as
      | { execute: (opts: { sql: string; args: unknown[] }) => Promise<unknown> }
      | undefined;

    if (!client) return;

    await client.execute({
      sql: `INSERT INTO policy_decisions
              (id, workspace_id, principal, action, resource_id, effect, rule_id, decided_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        nanoid(),
        ctx.workspaceId ?? null,
        entry.principal,
        entry.action,
        entry.resourceId ?? null,
        entry.decision.effect,
        entry.decision.rule?.id ?? null,
        Date.now(),
      ],
    });
  } catch {
    // Audit write failures are explicitly non-fatal. Log to stderr for ops visibility.
    // In production, a metric counter would be incremented here.
    process.stderr.write(`[heimdall] audit write failed for action=${entry.action}\n`);
  }
}
