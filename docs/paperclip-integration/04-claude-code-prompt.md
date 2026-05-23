# Claude Code Prompt: Paperclip Integration P2.0.1

Drop this into a Claude Code session at the root of the forge-lab repo. Use it as the opening message of a fresh conversation in Claude Code. Adjust the `--workspaces` directive to target only what you want this session to touch.

---

## OPENING PROMPT (copy from here to end)

You are working in the `forge-lab` repository (https://github.com/sugar-crash-studios/forge-lab). Phase 1 is complete. We are starting Phase 2. This session implements **P2.0.1 only**: the Workspaces and Workspace Members tables, with full test coverage. Do not start P2.0.2 or anything else. Stop and ask me when P2.0.1 is done.

### Required reading (in order)

Read these files before writing any code:

1. `context/architecture.md` (project constraints, ADRs, what NOT to do)
2. `context/project-context.md` (tech stack, conventions, forbidden patterns)
3. `packages/forge-core/src/schema/db.ts` (existing Drizzle schema)
4. `packages/forge-hub/src/db/migrate.ts` (hand-written migration pattern)
5. `packages/forge-core/src/types/user.ts` (existing Zod types for reference)
6. `packages/forge-hub/src/routes/auth.ts` (auth route pattern)
7. `packages/forge-hub/src/auth/middleware.ts` (existing auth middleware)
8. `docs/paperclip-integration/00-integration-plan.md` (the integration plan, sections 1, 2, 3, 4.1)
9. `docs/paperclip-integration/02-migrations.ts` (the SQL migration sketches)

After reading, summarize back to me in three sentences: what P2.0.1 is, what constraints apply, and what your plan is. Wait for my "go" before writing any code.

### Hard constraints (from `context/architecture.md`)

These are not negotiable. If you find yourself wanting to violate any of them, stop and ask:

- No emdashes in any output. Use hyphens, parentheses, or rephrase.
- No `any` types. Use `unknown` and narrow.
- No `better-sqlite3`. Project standard is `@libsql/client` + `drizzle-orm/libsql`.
- No `console.log` in production code paths. Use injected loggers.
- No `Content-Type: application/json` on bodyless requests (Fastify 5 rejects).
- No tsconfig relaxation (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` stay on).
- No secrets in environment variables. Use Docker secrets and the `_FILE` pattern.
- Every bug fix ships with a failing-first test (this also applies to new features).
- Zod schemas at every external boundary. Types inferred from schemas via `z.infer`.
- Dependency injection via constructor options.
- Tests colocate with source (`<name>.ts` and `<name>.test.ts` side by side).
- Hub is source of truth. Daemon talks to hub via HTTP and WebSocket only.

### Scope: P2.0.1 only

Add the workspaces and workspace_members tables to forge-lab. Concretely:

**1. SQL migration**
- Add a new migration entry `0001_workspaces` to the `MIGRATIONS` array in `packages/forge-hub/src/db/migrate.ts`
- SQL is exactly as specified in `02-migrations.ts` (the `MIGRATION_0001_WORKSPACES` constant)
- Verify it runs cleanly against an empty database AND against the current dev DB (likely empty)

**2. Drizzle schema**
- Add `workspaces` and `workspaceMembers` tables to `packages/forge-core/src/schema/db.ts`
- Column names, types, and FKs must match the SQL exactly
- Export from `packages/forge-core/src/schema/index.ts` so `schema.workspaces` and `schema.workspaceMembers` are accessible

**3. Zod types**
- Create `packages/forge-core/src/types/workspace.ts` with:
  - `WorkspaceStatusSchema` enum: `'active'`, `'paused'`, `'archived'`
  - `WorkspaceMemberRoleSchema` enum: `'owner'`, `'admin'`, `'collaborator'`, `'viewer'`
  - `WorkspaceSchema` and `WorkspaceMemberSchema`
  - `CreateWorkspaceInputSchema` and `UpdateWorkspaceInputSchema`
- Export from `packages/forge-core/src/index.ts`

**4. Routes (write the tests first)**
- Create `packages/forge-hub/src/routes/workspaces.test.ts`
- Tests should cover, in order:
  - `POST /workspaces` (authenticated user only) creates a workspace and adds the creator as owner-member
  - `POST /workspaces` rejects unauthenticated requests with 401
  - `GET /workspaces` returns only workspaces where the user is a member
  - `GET /workspaces/:id` returns 404 if not a member, even if the workspace exists
  - `GET /workspaces/:id` returns the workspace if the user is a member
  - `PATCH /workspaces/:id` requires owner role; admin and collaborator get 403
  - Members listing: `GET /workspaces/:id/members` returns members if requester is a member
- Watch the tests fail first (they should: the route file doesn't exist yet)
- Create `packages/forge-hub/src/routes/workspaces.ts` implementing the routes
- Make tests pass

**5. Wire into the app**
- Register `registerWorkspaceRoutes` in `packages/forge-hub/src/app.ts` alongside the other route registrations
- Add to imports

**6. Verification before hand-off**
- `pnpm typecheck` passes
- `pnpm test` passes (existing 28 tests still green, plus new workspace tests)
- `pnpm lint` passes

### What I do not want from this session

- Multi-tenancy scoping of existing tables (that is P2.0.2)
- Workspace-aware auth middleware extension (that is P2.0.3)
- Invites (that is P2.0.4)
- Touching `routes/tasks.ts` or any other existing route file (P2.1.1 fixes that one separately)
- Adding new dependencies. Use what is already in `package.json`.
- Drizzle Kit. Hand-written migrations only (per `context/architecture.md`).
- Speculative features beyond what is in this prompt.

### Communication style

- Be concise. State conclusions first, reasoning second.
- State confidence (1-10) when proposing a non-trivial design decision.
- When unsure about syntax or compatibility, say "I'm not sure, let me check" and verify against the actual code or docs.
- Format: What works, What are the risks, What needs to be true for success.
- No emdashes anywhere in output, including comments and commit messages.

### When P2.0.1 is done

Produce a summary:
- What changed (files added/modified)
- Test results
- Anything that surprised you or needed deviation from the plan
- Suggested next session (probably P2.0.2, but check the v2 plan to confirm)

Then stop and wait for me. Do not auto-proceed to P2.0.2.

---

## END OF PROMPT

---

## Notes for using this prompt

**Where to paste it:** Open Claude Code in the forge-lab repo root. Start a new conversation. Paste from the line "You are working in the `forge-lab` repository" to the line "Do not auto-proceed to P2.0.2."

**Required project files in context:** The docs/paperclip-integration folder in the repo is the source of truth. Claude Code can `cat` them directly. No need to paste them into the prompt.

**If the session goes sideways:** Common failure modes and how to redirect:

- *Adds dependencies without asking*: "Stop. The prompt forbids new dependencies. Use what's in package.json or ask me first."
- *Skips the failing-first test*: "Back up. The hard constraint says every change ships with a failing-first test. Write the test, watch it fail, then implement."
- *Uses emdashes*: "Replace all emdashes. This is a hard constraint."
- *Touches files outside P2.0.1 scope*: "Stop. P2.0.1 only. Revert that change."
- *Tries to do P2.0.2 in the same session*: "Stop here. P2.0.2 is a separate session."

**For P2.0.2 onward:** Use the same prompt template, swap the section headers (`P2.0.1` → `P2.0.2`), update the scope and reading list. Each phase milestone gets one focused session.

**For Pam onboarding work (eventually):** When you get to P2.0.4, give the prompt an extra constraint at the top: "Pam will use this to create her own account. The invite link must be safe to share via Signal or email. The token expires in 7 days by default."
