# forge-lab — authoritative handoff (2026-06-20)

This is the canonical entry document for a fresh clone. It supersedes the
`continue-YYYY-MM-DD.md` handoffs and the (stale) `docs/roadmap/current-state.md`.
Read this first. It is self-contained: nothing here depends on external memory
(graphiti) or files outside the repo.

---

## 1. Snapshot

- **Branch:** `main`, in sync with `origin/main`.
- **Status:** Fully operational. 9 agent daemons live on accserver
  (192.168.66.220). Dashboard at https://lab.local.cogg.haus. CD green.
- **Dash version:** 0.8.24 (surfaced in UI; read from
  `packages/forge-dash-community/package.json`).

### Packages

| Package | Purpose | Tests |
|---|---|---|
| `forge-core` | Shared Zod types, Drizzle schema, `AgentRuntime` interface | colocated |
| `forge-hub` | Fastify 5 API, libsql + drizzle, SSE, 19 migrations (`0000`-`0018`) | ~610 |
| `forge-daemon` | Worker + dispatcher loops, FM circuit breaker, Scribe modes | 117 |
| `forge-agents` | 11 agent personality files | 27 |
| `forge-dash-community` | Next.js 15 dashboard | hub-integration |
| `forge-mcp` | MCP surface | colocated |

Build: `pnpm install && pnpm build && pnpm test`. Node 20+ LTS, pnpm 10+.

---

## 2. Roadmap reconciliation (what is ACTUALLY done)

Two older planning docs are stale. Reconciled against the actual code on
2026-06-20:

- **FM Roadmap Phases A-G** (`docs/roadmap/current-state.md`): that doc lists
  A-G as *future*. They are all **shipped** — task lifecycle, device
  management, analytics, org profile, deployment validation, PM2 ecosystem,
  Heimdall Phase 1+2, plus ADR-004 single-fleet multi-workspace. Treat
  `current-state.md` as historical only.

- **Paperclip Phase 2** (`docs/paperclip-integration/`): the backlog and
  starting prompt there are **stale**. Reality:
  - **P2.0 (multi-tenancy)** — DONE. Workspaces, members, scoping, invites
    (migrations `0001`-`0003`).
  - **P2.1** — mostly DONE. Goals + ancestry (`0004`), X-Forge-Run-Id
    middleware, atomic claim. Leftover: `expectedStatuses` on claim;
    generalize `task_history` -> `entity_history`.
  - **P2.2 / P2.3 / P2.4** (heartbeat model, governance/budgets, polish) —
    essentially greenfield. NOT the focus of this handoff.

  **Do NOT follow `docs/paperclip-integration/04-claude-code-prompt.md`** — it
  points at P2.0.1, which shipped weeks ago.

---

## 3. This handoff's scope: Ops + Security hardening

Verified code state of the four items the previous handoff listed as "open":

| Item | Verdict | Detail |
|---|---|---|
| Daemon OAuth -> `ANTHROPIC_API_KEY` | **DONE** | `deploy/daemons.compose.yml` sets `ANTHROPIC_API_KEY` in the shared daemon-env anchor; no shared claude-home volume; `FORGE_DAEMON_MODEL=claude-sonnet-4-6` pinned via compose. |
| Daemon in-progress abort | **DONE** | `POST /tasks/:id/cancel` inserts a `priority:'stop'` `task_instructions` row; daemon worker loop polls via `checkStopInstruction` and SIGTERMs the runtime. |
| Heimdall Phase 3 | **PARTIAL** | Condition evaluator (`packages/forge-hub/src/policy/conditions.ts`) and the `policy_rule_changes` audit trail (migration `0012`) are done. Enforcement is incomplete (see OPS-1). |
| Auto-add fleet devices as members | **NOT-STARTED / needs design** | `POST /workspaces` adds only the creator as owner. Membership is user-scoped; auto-adding device rows likely conflicts with ADR-004 (fleet reaches workspaces via the owning account's membership + orchestrator enumeration). Do not build blind — flag to Adam for a design call. |

### Codeable backlog (for the dev agent)

**OPS-1 (primary) — Complete Heimdall Phase 3 enforcement.**
`packages/forge-hub/src/routes/policy-rules.ts` declares ~18 `VALID_ACTIONS`,
but only a few have a `checkPolicy` call site (`task:claim`, `doc:write`,
`device:deregister`, `device:rotate-token`, and one other). Actions like
`task:assign`, `task:cancel`, `task:retry`, `task:complete`, `task:fail`,
`doc:update`, `doc:supersede`, `doc:archive`, `context:read`, `workspace:list`
can be authored as rules but nothing enforces them. Audit `VALID_ACTIONS`
against actual call sites, then wire `checkPolicy` at every declared action
that lacks it. Built-in default rules must preserve current behavior (allow
where it allows today) so this is non-breaking. Failing-first test per newly
enforced action.

**OPS-2 (secondary) — Pin daemon model to sonnet in code.**
`FORGE_DAEMON_MODEL` is pinned only in compose. In
`packages/forge-daemon/src/runtime/claude-code.ts` the `--model` flag is omitted
when `model` is unset, so an unset env var lets the CLI default to **Opus**.
This is the exact failure mode that burned ~$95 in two days. Add a safe default
(sonnet) in code so an unset env var cannot fall through to Opus. Failing-first
test.

**OPS-3 (hygiene) — Remove stale shared-OAuth retry logic.**
`packages/forge-daemon/src/daemon.ts` still carries `authRetryLimit` /
`AUTH_FAILURE_RE` machinery and comments describing "the shared OAuth token
rotating mid-run / winning daemon writes fresh shared credentials." The auth
model is now per-container `ANTHROPIC_API_KEY`. Remove or rewrite the stale
shared-credential assumptions. Keep genuine transient-auth retry if it still
applies to API-key 401s; delete only the shared-home-specific logic.

### NOT the dev agent's job (Adam / human-in-the-loop)

These involve live secrets, the production fleet, or a design decision. Do not
attempt them from a clone:

- **Revoke the leaked `gho_` OAuth token** (GitHub Settings -> Applications ->
  Authorized OAuth Apps -> revoke "GitHub CLI" -> re-auth). Org-admin scope.
- **Rotate the runner-compose `ACCESS_TOKEN` PAT** (appeared in a transcript).
- **Re-enable the disabled forge-lab-workers Anthropic key** only after OPS-2
  lands and the sonnet pin is verified.
- **Set `FORGE_SEQUENCES_ENABLED=1`** on the accserver hub env (feature flag
  exists in `tasks.ts`; just needs the env var on the server).
- **Auto-add-members design call** (see table above).

---

## 4. Hard constraints (from `context/architecture.md`)

Non-negotiable. If a change wants to violate one, stop and ask.

- No emdashes in any output, including code comments and commit messages.
- No `any` types. Use `unknown` and narrow.
- No `better-sqlite3`. Standard is `@libsql/client` + `drizzle-orm/libsql`.
- No `console.log` in production paths. Use injected loggers.
- No tsconfig relaxation (`strict`, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax` stay on).
- Every bug fix AND new feature ships with a failing-first test.
- Zod schemas at every external boundary; types via `z.infer`.
- Dependency injection via constructor options.
- Hand-written SQL migrations (append to the `MIGRATIONS` array in
  `packages/forge-hub/src/db/migrate.ts`); never edit a shipped migration.
- Hub is source of truth. Daemon talks to hub via HTTP/WebSocket only.

---

## 5. Process rules

- **Verify green before merge.** Repo ruleset blocks auto-merge:
  `gh pr merge <n> --squash --admin` once CI is green.
- **Staging:** use `git add -A` then `git reset <unwanted>` (e.g. `docs/qa/`).
  Do NOT `git add` explicit bracket pathspecs like `.../[id]/...` — the bracket
  aborts the whole add. Verify with `git diff --cached --stat`.
- **Versioning:** stay on `0.8.x` patch; bump the dash patch on any push to
  main that contains code changes. No `0.9` minor without Adam's OK. Docs-only
  pushes do not need a bump.
- **Deploy:** accserver via CD on merge to main. Verify each CD:
  `ssh accserver "docker ps --filter name=forge-hub"`. Self-hosted runner can
  flake.

---

## 6. TASK PROMPT for the dev agent (copy-paste)

> You are working in the `forge-lab` monorepo (you have cloned it; branch
> `main`). Before writing any code, read in order: `docs/handoff/HANDOFF.md`
> (authoritative status and your scope), `context/architecture.md`, and
> `context/project-context.md`. Then summarize back to me in three sentences:
> the current state, your scope, and your plan. Wait for my "go" before writing
> code.
>
> Your scope is **Ops + Security hardening**, section 3 of HANDOFF.md, in this
> order:
>
> 1. **OPS-1 — Complete Heimdall Phase 3 enforcement.** Audit
>    `VALID_ACTIONS` in `packages/forge-hub/src/routes/policy-rules.ts` against
>    the actual `checkPolicy` call sites across the routes. For every declared
>    action with no enforcement (`task:assign`, `task:cancel`, `task:retry`,
>    `task:complete`, `task:fail`, `doc:update`, `doc:supersede`, `doc:archive`,
>    `context:read`, `workspace:list`, plus any others you find), wire a
>    `checkPolicy` call. Built-in default rules must preserve current behavior
>    so this is non-breaking. Write a failing-first test for each newly
>    enforced action.
>
> 2. **OPS-2 — Pin the daemon model to sonnet in code.** In
>    `packages/forge-daemon/src/runtime/claude-code.ts`, ensure an unset
>    `FORGE_DAEMON_MODEL` cannot let the claude CLI default to Opus. Add a safe
>    sonnet default. Failing-first test proving an unset env var no longer omits
>    `--model`.
>
> 3. **OPS-3 — Remove the stale shared-OAuth retry logic** in
>    `packages/forge-daemon/src/daemon.ts`. The auth model is per-container
>    `ANTHROPIC_API_KEY` now; delete the shared-home-credential assumptions and
>    comments. Keep any genuine API-key 401 retry that still applies.
>
> Ship each as its own PR: CI green -> `gh pr merge <n> --squash --admin`.
> Respect every hard constraint in section 4 and every process rule in section
> 5 of HANDOFF.md (failing-first tests, no emdashes, no `any`, append-only
> migrations, hand-written SQL). Do NOT touch production secrets, restart the
> fleet, or build the auto-add-members feature (that needs a design call from
> me). Stop and ask if anything is ambiguous or wants to exceed this scope.
