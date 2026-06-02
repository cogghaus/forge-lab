# ADR-004: Single Agent Fleet Across Workspaces (Multi-Workspace FM + Shared Workers)

**Status**: Proposed
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

- Workers **already** support running unscoped — with `FORGE_DAEMON_WORKSPACE_ID` unset, `listTasks(undefined)` returns tasks across all the device's workspaces and the scope guard at `daemon.ts:529` is skipped, so the worker claims its agent's tasks in **any** workspace.
- FM's single-workspace restriction is a `if (!workspaceId) return`, not an architectural constraint. It can iterate the workspaces it serves.

---

## Decision

Move to **one fleet for the whole hub**: a single multi-workspace FM plus a single shared pool of workers, regardless of how many workspaces exist.

### 1. Multi-workspace FM

FM stops being workspace-pinned. Each dispatcher tick it:

1. Enumerates the workspaces it serves (the FM device's memberships).
2. For each workspace with a non-empty `pending_dispatcher_action` inbox, runs the existing single-workspace triage cycle (stale-requeue → fetch context → spawn FM agent → assign).

The existing per-workspace triage logic is **reused unchanged**; only the *selection of which workspace(s) to triage* changes. The global `fmRunning` guard still serializes — at most one FM agent runs at a time, triaging workspaces in sequence. Hub state remains FM's memory (still ephemeral per cycle, per ADR-001).

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
- `workspaceId` stays optional. Add `dispatcherWorkspaceMode: 'single' | 'all'` (env `FORGE_DAEMON_DISPATCHER_SCOPE`, default `single` for back-comat). `all` = serve every membership.
- Drop the hard requirement that dispatcher mode needs `workspaceId` when scope is `all`.

**Hub**
- New client need: enumerate the orchestrator's workspaces. Reuse `GET /workspaces` (already returns the caller's memberships) — confirm it authorizes an **orchestrator device** token, not just a user session; if not, add a thin `GET /dispatcher/workspaces` (orchestrator-only) returning `{id}` for workspaces the device may triage. (Heimdall already gates `task:assign` / `context:read` to `agent:forge-master` at priority 200 — extend the same principal to the listing route.)
- `getWorkspaceContext` / `requeueStaleAssigned` are already per-workspace; called in a loop. No hub change beyond the listing route.

**Daemon (`daemon.ts`)**
- `HubClient.listWorkspaces()` (GET /workspaces) — new method.
- `pollDispatcher`: when scope is `all`, replace the single-`workspaceId` body with `for (const ws of await listWorkspaces())` running the existing requeue+context+spawn per workspace whose `inboxTasks` is non-empty. Keep `fmRunning` as a global gate (sequential triage). Preserve the synthetic `_fm_` marker per cycle.
- Logging/metrics gain a `workspaceId` dimension per triaged workspace.

**Tests**
- Dispatcher integration: 2 workspaces, inboxes in each → one FM run triages both; empty inboxes skipped; `fmRunning` prevents overlap; a workspace error doesn't abort the others.

**Effort:** small-to-medium, mostly in `daemon.ts` + one client method + a possible orchestrator-scoped listing route. No schema change.

---

## Migration — consolidate existing workers to a single batch

Goal: collapse `forge-*` + `hal-*` (and any future per-workspace sets) into **1 FM + 8 workers**, no dropped tasks.

**Pre:** FM multi-workspace change deployed; the FM device + each worker device are members of *all* target workspaces (add memberships via the hub before cutover — workers must be members to claim).

1. **Add memberships.** Ensure the shared FM + worker devices' owning account is a member of every workspace (forge-lab, HAL, …). Workers only claim in workspaces they belong to.
2. **Reconfigure the canonical fleet.** In `daemons.compose.yml`: remove the `FORGE_DAEMON_WORKSPACE_ID` pin from the worker services (run unscoped); set `forge-fm` to `FORGE_DAEMON_DISPATCHER_SCOPE=all`. The `&daemon-env` anchor's workspace var is dropped.
3. **Drain, don't kill.** Bring the HAL set's workers to idle (stop *new* claims): scale `hal-*` workers to 0 **after** confirming no in-progress tasks on them (`dprod ps` / task statuses). In-progress tasks finish on their current worker; the requeue-stale path (30 min) backstops anything stranded.
4. **Cut over.** `docker compose -p forge-daemons up -d` the reconfigured single fleet. The unscoped workers now claim across forge-lab + HAL. The single FM triages both inboxes.
5. **Retire duplicates.** Once the single fleet is claiming HAL tasks, remove the `hal-*` services + their volumes; deregister their device tokens in the hub (Org → Agent daemons → deregister). Keep their tokens revoked, not just stopped.
6. **Repo-bound caveat.** If any HAL worker was repo-bound, keep one per-repo worker (option b) until repo-switching (option a) ships. Flag which agents are repo-bound before step 3.

**Rollback:** re-pin `FORGE_DAEMON_WORKSPACE_ID`, set dispatcher scope back to `single`, re-up the per-workspace sets. State lives in the hub, so flipping daemon config is reversible; no data migration.

**Validation:** create a `pending_dispatcher_action` task in each workspace → confirm the single FM triages both; create a worker task in HAL → confirm a shared (unscoped) worker claims it; confirm `0` duplicate daemons remain registered.

---

## Consequences

**Positive**
- Daemon count is **O(1)** in workspaces, not O(workspaces × agents). Adding a workspace = grant memberships, deploy nothing.
- One place to configure/auth/monitor the fleet. Fewer tokens, volumes, restarts.
- FM triage logic unchanged — lower risk.

**Negative / risks**
- **Single FM = single triage throughput.** One FM serializes triage across all workspaces. Mitigation: triage is fast (assign/decompose, not execution); if it ever bottlenecks, shard FM by workspace-hash later. Revisit if inbox latency grows.
- **Cross-workspace blast radius.** A shared worker bug now touches all workspaces. Mitigation: Heimdall policy + per-task isolation already scope what a worker may do.
- **Membership is now load-bearing.** A worker not a member of a workspace silently won't serve it. Make membership part of workspace creation/onboarding.
- **Repo-bound work** still needs care until repo-switching lands (option a).

---

## Follow-ups

- Implement repo-switching workers (option a) so dev-capability collapses into the shared pool.
- Make "add the fleet's devices as members" automatic on workspace creation.
- Optional FM sharding if single-FM triage throughput becomes a constraint.
