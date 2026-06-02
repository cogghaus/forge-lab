# ADR-004: Single Agent Fleet Across Workspaces (Multi-Workspace FM + Shared Workers)

**Status**: Accepted
**Date**: 2026-06-02
**Authors**: Adam + Claude (Architect lens)
**Supersedes**: deployment topology implied by [ADR-001](./ADR-001-forge-master-orchestrator.md) (per-workspace daemon set)

---

## Context

Today every workspace gets its own full set of daemons. The committed `deploy/daemons.compose.yml` defines `forge-fm` + 8 workers (architect, furnace, anvil, crucible, oracle, scribe, herald, temper), all pinned to a single workspace via a shared `FORGE_DAEMON_WORKSPACE_ID` anchor. Onboarding HAL meant standing up a **parallel** set (`hal-fm`, `hal-furnace`, …). The live `devices` table shows both fleets.

This is **O(workspaces × agents)** daemons. At 2 workspaces it's ~18 containers; at 5 it's ~45. It does not scale and it's operationally noisy (per-workspace tokens, volumes, restarts).

Two code facts force the duplication:

1. **FM requires a single workspace.** `forge-daemon/src/daemon.ts:391` — dispatcher mode logs an error and returns if `workspaceId` is unset. `pollDispatcher` fetches exactly one workspace's context (`getWorkspaceContext(workspaceId)`) and triages it. So one FM ⇒ one workspace.
2. **Repo-bound workers own one checkout.** A worker with `repoUrl` set runs at `maxConcurrentTasks=1` (`daemon.ts:173`) against a single working tree. A worker bound to forge-lab's repo cannot also serve HAL's repo.

Neither is fundamental:

- Workers **already** support running unscoped — with `FORGE_DAEMON_WORKSPACE_ID` unset, `listTasks(undefined)` returns tasks across all the device's workspaces and the scope guard at `daemon.ts:529` is skipped, so the worker claims its agent's tasks in **any** workspace the device's owning account is a member of.
- FM's single-workspace restriction is a `if (!workspaceId) return`, not an architectural constraint. It can iterate the workspaces it serves.

---

## Decision

Move to **one fleet for the whole hub**: a single multi-workspace FM plus a single shared pool of workers, regardless of how many workspaces exist.

### 1. Multi-workspace FM

FM stops being workspace-pinned. Each dispatcher tick it:

1. Enumerates the workspaces it serves (the FM device's memberships, via `GET /dispatcher/workspaces`).
2. For each workspace with a non-empty `pending_dispatcher_action` inbox, runs the existing single-workspace triage cycle (stale-requeue → fetch context → spawn FM agent → assign).

The existing per-workspace triage logic is **reused unchanged**; only the *selection of which workspace(s) to triage* changes. The global `fmRunning` guard still serializes — at most one FM agent runs at a time, triaging workspaces in sequence. Workspace errors are isolated (per-workspace try/catch); a transient failure in one workspace does not abort triage of others. Hub state remains FM's memory (still ephemeral per cycle, per ADR-001).

### 2. Shared worker pool

Output-only workers (the default, no `repoUrl`) run **unscoped** — one `furnace`, one `anvil`, etc., serving every workspace. This is already supported; the change is purely deployment (stop deploying per-workspace copies).

### 3. Repo-bound workers (dev-capability)

A worker that checks out a repo is the one case that can't trivially share. Two options, in preference order:

- **(a) Repo-switching worker (target):** since repo-bound workers are already serial (`maxConcurrentTasks=1`), teach the worker to check out the *task's* workspace repo at claim time (clean/reset between tasks). One worker then serves many repos sequentially. Collapses repo-bound work into the shared pool.
- **(b) Per-repo worker (interim):** keep one repo-bound worker per active repo until (a) lands. Still far fewer than per-workspace × per-agent.

### End state

**1 FM + ~8 shared workers**, independent of workspace count. Repo-bound work is the only thing that may add workers, and (a) removes even that.

---

## Scope — FM multi-workspace change

**Config (`forge-daemon/src/config.ts`)**
- `workspaceId` stays optional. Add `dispatcherWorkspaceMode: 'single' | 'all'` (env `FORGE_DAEMON_DISPATCHER_SCOPE`, default `single` for back-compat). `all` = serve every membership.
- When `dispatcherMode=true` and `dispatcherWorkspaceMode='all'`, drop the hard requirement that `workspaceId` must be set; log a warning if `workspaceId` is set along with `scope=all` (ambiguous config).

**Hub**
- `GET /workspaces` requires a user session and cannot be called with a device token. Add `GET /dispatcher/workspaces` — orchestrator-device-only endpoint (requires `requireDevice` + `deviceType=orchestrator` check, same pattern as `GET /workspaces/:id/context`). Returns `{ id: string }[]` for workspaces where the device's owning account has **active** membership (archived or deactivated workspaces excluded).
- Extend Heimdall built-in rules: add `{ principal: 'agent:forge-master', action: 'workspace:list', effect: 'allow', priority: 200 }` alongside the existing `task:assign` / `context:read` grants.
- `getWorkspaceContext` / `requeueStaleAssigned` are already per-workspace; called in a loop. No other hub change required.

**Daemon (`daemon.ts`)**
- `HubClient.listWorkspaces()` — calls `GET /dispatcher/workspaces`, returns workspace IDs the FM should triage.
- `pollDispatcher`: when scope is `all`, replace the single-`workspaceId` body with a loop over `await listWorkspaces()`. `fmRunning` is acquired once at the start of the full dispatcher tick and released after all workspaces are processed (or on fatal error) — it is not toggled per workspace iteration. For each workspace, run the existing requeue+context+spawn sequence wrapped in a per-workspace `try/catch`. Transient errors (network timeout, context fetch failure) are logged with `workspaceId` and the loop continues. Structural errors (auth failure, FM device missing) abort the whole tick and release `fmRunning`. Each FM spawn gets its own unique `syntheticTaskId` (`_fm_${Date.now()}-${workspaceId}-${randomSuffix}`) to prevent ID collision when multiple workspace triages run in the same tick; the marker file is per-spawn.
- Logging gains a `workspaceId` dimension on all triage log lines (info/error) within the loop.

**Tests**
- `GET /dispatcher/workspaces` hub route: orchestrator device returns its workspaces; worker device returns 403; non-member workspace excluded.
- Dispatcher integration (scope=all): 2 workspaces, inboxes in each → one FM run triages both; empty inbox workspace is skipped; `fmRunning` gate prevents a concurrent second dispatch call from spawning a second FM while the first is active (assert no double-spawn); error in any workspace-1 triage step (context fetch, spawn, or assign) does not abort workspace-2 triage.
- Backward compat (scope=single): `dispatcherWorkspaceMode='single'` with `workspaceId` set still triages exactly one workspace (regression guard for existing behavior).

**Effort:** small-to-medium, mostly in `daemon.ts` + one new hub route + Heimdall rule. No schema change.

---

## Migration — consolidate existing workers to a single batch

Goal: collapse `forge-*` + `hal-*` (and any future per-workspace sets) into **1 FM + 8 workers**, no dropped tasks.

**Pre-flight (before any config change):**
- Identify repo-bound workers: query the hub for devices with `repoUrl` set, or inspect `daemons.compose.yml` for any `FORGE_DAEMON_REPO_URL` entries. Handle these per §3 before proceeding.
- Confirm in-progress task count is 0 on both fleets: `docker logs forge-fm --tail 20` + check task statuses in the hub.
- Verify `GET /dispatcher/workspaces` is reachable with the FM device token: `curl -H 'Authorization: Bearer <fm-token>' http://forge-hub:3000/dispatcher/workspaces` should return both workspace IDs.

**Steps:**

1. **Add memberships.** Ensure the owning account for the shared FM + worker devices is a member of every workspace (forge-lab, HAL, …). Workers claim tasks only in workspaces the device's owning account belongs to. Add memberships via the hub UI (Org → Members) or API before cutover.
2. **Reconfigure the canonical fleet.** In `daemons.compose.yml`: remove the `FORGE_DAEMON_WORKSPACE_ID` pin from the worker services (run unscoped); set `FORGE_DAEMON_DISPATCHER_SCOPE=all` on `forge-fm`. Drop the `&daemon-env` anchor's workspace var. Commit this change.
3. **Drain, don't kill.** Stop the HAL workers from claiming new tasks: `docker compose -p forge-daemons stop hal-furnace hal-anvil …` (not scale-to-0 — that is not a valid Compose v2 command). Wait for any in-progress tasks on hal-* workers to finish; the 30-minute stale-requeue path backstops anything stranded. Note: there is a ~10-second race window between confirming idle and the stop command — at worst, 1-2 tasks may be dispatched to a hal-* worker during that window and will auto-requeue after 30 minutes.
4. **Cut over.** `docker compose -p forge-daemons up -d --build` the reconfigured single fleet. The unscoped workers now claim across forge-lab + HAL. The single FM triages both inboxes via `scope=all`.
5. **Validate before retiring.** Create a `pending_dispatcher_action` task in each workspace and confirm the single FM triages both. Create a plain worker task in the HAL workspace and confirm a shared (unscoped) worker claims it. Only proceed to step 6 when all three checks pass.
6. **Retire duplicates.** Remove the `hal-*` services from `daemons.compose.yml` and their volumes; deregister their device tokens in the hub (Org → Agent daemons → deregister). Keep their tokens revoked, not just stopped.

**Rollback (before step 6):** re-pin `FORGE_DAEMON_WORKSPACE_ID`, set dispatcher scope back to `single`, re-up the per-workspace sets. State lives in the hub, so flipping daemon config is reversible; no data migration. **If rollback is needed after step 6**, the hal-* device tokens have been deregistered and cannot be reused; new tokens must be minted via `POST /devices` and `deploy/.env.daemons` updated before re-upping the hal-* set. Plan to complete rollback before step 6 if confidence is low.

---

## Consequences

**Positive**
- Daemon count is **O(1)** in workspaces, not O(workspaces × agents). Adding a workspace = grant memberships, deploy nothing.
- One place to configure/auth/monitor the fleet. Fewer tokens, volumes, restarts.
- FM triage logic unchanged — lower risk.

**Negative / risks**
- **Single FM = serial triage latency per workspace.** FM spawns an LLM agent (claude CLI) per triage cycle; expect ~3-5 seconds of LLM roundtrip per workspace (measure actual cycle time via logger timestamps on triage start/end lines). With N workspaces, workspace N waits for workspaces 1…N-1 to complete before its inbox is processed. At current scale (2-5 workspaces) this is acceptable for async task routing; revisit if inbox latency becomes user-visible. Shard FM by workspace-hash if needed.
- **Worker pool starvation.** A long-running task in workspace A holds one of the 8 shared worker slots for its duration. No per-workspace fairness guarantee exists in the current `listTasks` scheduling. Workspaces generating many long-running tasks may delay others. Mitigation at current scale: 8 workers is well above per-workspace concurrency today; add workspace-aware round-robin to `listTasks` if contention appears.
- **Cross-workspace blast radius.** A shared worker bug now touches all workspaces. Mitigation: Heimdall policy gates worker actions; per-task file isolation scopes what a worker may write.
- **Membership is now load-bearing.** A worker not a member of a workspace silently won't serve it. Make membership part of workspace creation/onboarding (see Follow-ups).
- **Repo-bound work** still needs care until repo-switching lands (option a).

---

## Follow-ups

- Implement repo-switching workers (option a) so dev-capability collapses into the shared pool.
- Make "add the fleet's devices as members" automatic on workspace creation.
- Optional FM sharding if single-FM triage throughput becomes a constraint.
