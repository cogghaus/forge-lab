# Paperclip Integration

> **STALE (2026-06-20).** P2.0 (multi-tenancy) and most of P2.1 are already
> **shipped** (migrations `0001`-`0004`). The starting prompt in
> `04-claude-code-prompt.md` targets P2.0.1 and must NOT be followed as-is.
> See [`docs/handoff/HANDOFF.md`](../handoff/HANDOFF.md) section 2 for what
> actually remains on this track (P2.1 leftovers, P2.2-P2.4).

Phase 2 work for forge-lab. Adopts patterns from [Paperclip](https://github.com/paperclipai/paperclip) (MIT-licensed agent orchestration platform) while preserving forge-lab's existing architecture decisions in `context/architecture.md`.

## Status

Planning complete (2026-05-13). Implementation begins with P2.0.1.

## Files

| File | Purpose |
|---|---|
| `00-integration-plan.md` | The full plan. Phased tasks, confidence ratings, risks, open questions. Read this first. |
| `01-task-backlog.md` | Compact task list, organized by phase. Convert to issues if useful. |
| `02-migrations.ts` | Hand-written SQL migrations for each phase. Drop into `MIGRATIONS` array in `packages/forge-hub/src/db/migrate.ts` in order. |
| `03-atomic-claim.ts` | Reference implementation of P2.1.1 (fix the TOCTOU race in `/tasks/:id/claim`). |
| `04-claude-code-prompt.md` | Opening prompt template for Claude Code sessions, configured for P2.0.1. Adapt for each subsequent task. |

## Origin

These docs were produced in a Claude conversation that read both Paperclip's source/docs and forge-lab's current state, then mapped the integration. The plan is grounded in:

- Paperclip docs at https://docs.paperclip.ing and `paperclipai/paperclip` @ master (2026-05-13)
- forge-lab @ master (2026-05-13), specifically `context/architecture.md`, `context/project-context.md`, `packages/forge-core/src/schema/db.ts`, `packages/forge-hub/src/db/migrate.ts`, and the existing routes in `packages/forge-hub/src/routes/`

## What this is NOT

- A migration to Paperclip. forge-lab stays forge-lab.
- A rewrite. The existing schema, status enums, runtime abstraction, and personality system are preserved.
- A wholesale lift of every Paperclip feature. Only the patterns that fit forge-lab's architecture.

## What this IS

- A plan to add multi-tenancy (workspaces + members + invites) so Pam can use forge-lab alongside Adam without sharing data unintentionally
- A plan to add goals, runs, cost events, approvals, budget enforcement, wakeup queues, and routines as forge-lab concepts
- A bug fix for the TOCTOU race in `/tasks/:id/claim`
- A formalization of the AgentRuntime interface to surface cost reporting and session resume

## Phase order

1. **P2.0** Multi-tenancy foundation (workspaces, member roles, workspace-scoped tables, admin invites). Blocking for Pam-sharing.
2. **P2.1** Foundation primitives (atomic claim, entity_history generalization, goals, run-id middleware).
3. **P2.2** Heartbeat execution model (the big lift; daemon-side wakeup queue, runs, cost events, runtime extensions).
4. **P2.3** Governance and budget (budgets, approvals, agent lifecycle endpoints).
5. **P2.4** Polish (org chart, routines, skill discovery, forge templates).

After P2.0 + P2.1, stop, use it for two weeks, decide if P2.2 is worth the time.

## Hard constraints (cribbed from `context/architecture.md`)

Every change must respect these. The Claude Code prompt enforces them.

- No emdashes in any output
- No `any` types
- No `better-sqlite3` (libsql + drizzle-libsql only)
- No `console.log` in production code paths
- No tsconfig relaxation
- Every bug fix ships with a failing-first test
- Zod schemas at every external boundary, types inferred via `z.infer`
- Dependency injection via constructor options
- Hand-written SQL migrations until drizzle-kit comes in Phase 2

## Working with these docs

For planning, design questions, or architecture trade-offs: paste the relevant section of `00-integration-plan.md` into a Claude conversation. The `app-forge-lab` Claude project has all these files in context.

For implementation work: open Claude Code in this repo, paste the prompt from `04-claude-code-prompt.md` (adjusted for the current task), and proceed.
