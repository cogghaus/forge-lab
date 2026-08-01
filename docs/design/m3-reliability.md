# M3 Reliability design

Author: Claude Fable 5, 2026-07-08. Covers issues 1, 4, 14, 15, 50.
Status: approved plan scope (milestone plan approved 2026-07-07); this doc fixes
the semantics before implementation so hub and daemon land against one contract.

Guiding decision: the system is **at-least-once**. A task may run twice after a
daemon crash (lease reclaim re-runs it); it must never be lost or stuck forever.
Idempotent terminal transitions on the hub are the safety net for the retry paths.

## Landing order

1. Issue 50 (CI/GHCR) ships FIRST as its own push. Every later M3 push then
   deploys without an on-box docker build. Until it lands, pushes keep wedging
   risk (M1 postmortem, load ~1400).
2. Issues 1, 4, 14, 15 land together in a second push (hub + daemon are one
   protocol change; shipping the heartbeat route without the daemon loop is
   inert but shipping the reclaim sweep without daemon heartbeats would reclaim
   live work; see Compatibility).

## Issue 50: build images in CI, push to GHCR, deploy-host only pulls

Today `cd.yml` runs `docker compose up -d --build` for 4 images (hub, dash, mcp,
daemon) plus the waker on the deploy-host self-hosted runner. The builds crushed
the host (prod containers, runner, and builds share one box).

Changes:

- New `build` job in `cd.yml` on `ubuntu-latest` (NOT self-hosted), gated on CI
  success exactly as today. Matrix over the five images:
  `vibe-forge-{hub,dash,mcp,daemon,waker}` built with `docker/build-push-action`
  (buildx, `cache-from/to: type=gha`), pushed to
  `ghcr.io/cogghaus/<image>` tagged `:latest` and `:<short-sha>`.
  Workflow `permissions: packages: write, contents: read`. Waker context is
  `deploy/waker`; the rest use their existing Dockerfiles with repo-root context.
- The `deploy` job (self-hosted, deploy-host) `needs: build` and shrinks to:
  `docker login ghcr.io` with `GITHUB_TOKEN`, `git pull`, then
  `docker compose ... pull` followed by `docker compose ... up -d --no-build
  --remove-orphans` for both compose files. `--no-build` is a hard guard: an
  accidental build on the box becomes an error, not a load spike.
- Compose files: `image:` becomes `ghcr.io/cogghaus/forge-lab-<svc>:${IMAGE_TAG:-latest}`.
  Keep the `build:` blocks so local dev `up --build` still works. The deploy job
  exports `IMAGE_TAG=<short-sha>` so prod runs the exact CI-built image and
  rollback is `IMAGE_TAG=<previous-sha> docker compose up -d --no-build`.
- `BUILD_SHA` for the dash footer keeps working: deploy job passes
  `BUILD_SHA=$(git rev-parse --short HEAD)` as today.
- Registry hygiene: images are org-internal packages; first push must be
  followed by (manual, Adam or gh api) granting the deploy-host runner read
  access if the packages default to private. Document in the workflow header.

Non-goals: no runner watchdog, no multi-arch (deploy-host is linux/amd64 only).

## Issue 1: in_progress lease + heartbeat + reclaim sweep

Today claim sets `status=in_progress, assignedDeviceId` and nothing ever takes
it back; a daemon crash orphans the task forever (stale sweeps only cover
`assigned` and stale-phase).

DB (migration `0018_task_lease`, append-only in migrate.ts):

- `ALTER TABLE tasks ADD COLUMN lease_expires_at INTEGER;` (epoch ms, NULL when
  not leased)
- `ALTER TABLE tasks ADD COLUMN reclaim_count INTEGER NOT NULL DEFAULT 0;`
- `CREATE INDEX tasks_lease_idx ON tasks(status, lease_expires_at);`
- Backfill in the same migration: `UPDATE tasks SET lease_expires_at =
  <now + lease TTL> WHERE status = 'in_progress' AND lease_expires_at IS NULL;`
  so pre-existing in_progress rows join the lease world instead of being
  permanently exempt.

Hub:

- Config: `leaseTtlSeconds` (env `FORGE_HUB_TASK_LEASE_SECONDS`, default 1800),
  `reclaimSweepSeconds` (env `FORGE_HUB_RECLAIM_SWEEP_SECONDS`, default 60, 0
  disables), `maxReclaims` (env `FORGE_HUB_TASK_MAX_RECLAIMS`, default 3).
- Claim (`POST /tasks/:id/claim`): also set
  `lease_expires_at = now + leaseTtl` in the same atomic UPDATE.
- New `POST /tasks/:id/heartbeat` (requireDevice, policy action `task:heartbeat`
  allowed for role:worker like task:complete): atomic UPDATE extending
  `lease_expires_at = now + leaseTtl` WHERE id, `status='in_progress'`,
  `assignedDeviceId = device.id`. 0 rows -> `409 {error:'lease_lost'}`. Response
  `{ok:true, leaseExpiresAt}`. No history row per beat (too chatty); nothing on
  the event bus either.
- Reclaim sweep: in-process `setInterval` started with the server (skipped when
  `reclaimSweepSeconds` is 0; tests use 0 and call the exported sweep function
  directly). Each pass, atomically for every task with `status='in_progress'
  AND lease_expires_at < now`:
  - `reclaim_count + 1 <= maxReclaims`: requeue. `status` goes to `'assigned'`
    when `assignedAgentId` is set (the routed worker re-claims it) else
    `'pending_agent'`; clear `assignedDeviceId` and `lease_expires_at`,
    increment `reclaim_count`. History event `task.lease_reclaimed` with
    `{reclaimCount}`; bus event of the same name (wakes the waker).
  - Over the cap: `status='failed'`, history + bus `task.failed` with
    `payload.reason='lease_expired_max_reclaims'`. Caps crash-loop tasks.
  - Phase tasks (`phaseIndex IS NOT NULL`): same reclaim, and over-cap failure
    must route through the same blocked-root bookkeeping the stale-phase requeue
    uses (set root `blockedReason`), not silently strand the sequence.

Daemon:

- Config: `heartbeatMs` (env `FORGE_DAEMON_HEARTBEAT_MS`, default 60000, 0
  disables; must be well under the hub's lease TTL, document the pairing).
- One interval beats every active real task (skip `_fm_` synthetics; they are
  not hub tasks). hub-client gains `heartbeatTask(taskId)`.
- On `409 lease_lost` (or 404): the hub took the task back. Kill the local
  instance (`runtime.stop`), `cleanupTaskFiles`, drop from `activeInstances`,
  log ERROR `task lease lost, killed local agent`. Do NOT failTask (we no
  longer own it). This is the double-run window closing from the loser's side.
- Network errors on heartbeat: log at info and keep going; the next beat
  retries. Missing several beats is exactly what the lease TTL absorbs.

Compatibility: hub and daemons deploy together on deploy-host (single compose
fleet), so the sweep and the heartbeat arrive at once. The backfill plus a
30-minute default TTL gives old-style daemons (none in prod after the deploy)
one lease window before their work is reclaimed.

## Issue 4: wall-clock timeout for hung agents

`isAlive` is file-based; a hung-but-alive process holds a slot forever.

- `ActiveInstance` gains `startedAt: number` (set at spawn).
- Config: `maxTaskRuntimeMs` (env `FORGE_DAEMON_MAX_TASK_RUNTIME_MS`, default
  3_600_000 = 60 min, 0 disables).
- In `pollForPendingTasks`, before the isAlive check: if
  `now - startedAt > maxTaskRuntimeMs`, stop the instance via its runtime,
  then treat as failed: `failTask(taskId, 'max runtime exceeded (<mins>m)')`
  through the issue-14 retry path, cleanup, drop from map. For `_fm_`
  synthetics: stop, cleanup, reset `fmRunning` and the cooldown exactly like
  the dead-FM path (no hub call; synthetics are not hub tasks).
- The timeout is a backstop, not scheduling: one check per poll tick is enough;
  no per-task timers.

## Issue 14: bounded retry on terminal calls, cleanup only after hub confirms

Today `completeTask`/`failTask` failures are logged and dropped AFTER local
files were already cleaned: a transient 5xx at completion loses finished work.

- hub-client (or a small helper in daemon.ts): `retryTerminal(fn)` with bounded
  exponential backoff. Config `terminalRetryLimit`
  (env `FORGE_DAEMON_TERMINAL_RETRY_LIMIT`, default 4) and delays
  1s, 5s, 15s, 60s (capped). Retry ONLY on network errors, 429, and 5xx.
  4xx (403/404/409) means the hub decided we do not own the outcome: stop
  retrying, log, and clean up local state WITHOUT marking anything (the lease
  system owns recovery from here).
- `handleTaskDone`: call `completeTask` through the retry helper FIRST;
  `cleanupTaskFiles` + `activeInstances.delete` move AFTER a confirmed success
  (2xx). On retry exhaustion: keep the done file and the map entry, log ERROR
  `completion unconfirmed, will re-attempt via poll`; the poll loop re-detects
  the finished instance (isAlive false + done file present) - extend that
  branch (daemon.ts:438-440) to re-enter handleTaskDone instead of skipping,
  so completion is re-attempted every poll tick until the hub confirms or the
  lease reclaims the task. Memory save stays best-effort before completion
  (R10 ordering unchanged).
- All `failTask` call sites (spawn failure, dead worker, timeout) go through
  the same helper with the same 4xx semantics.
- Hub idempotency (verify, add test): `complete` on an already-completed task
  and `fail` on an already-failed task must return a benign response (2xx or a
  distinct already-terminal marker), never 5xx, so retries after a half-applied
  first attempt converge.

## Issue 15: fail fast on :memory: outside tests

`config.ts:7` defaults `databaseUrl` to `:memory:`; an unset env var in prod
silently loses everything on restart.

- Keep the schema default (tests rely on it). At server startup (the real boot
  path, not loadConfig, so unit tests of config stay green): if
  `databaseUrl === ':memory:'` and `NODE_ENV === 'production'`, throw with a
  message naming `FORGE_HUB_DATABASE_URL`. Outside production, log a single
  loud startup warning that data is volatile. Escape hatch
  `FORGE_HUB_ALLOW_MEMORY_DB=1` suppresses the throw (CI smoke of prod images).
- Doc note (QUICKSTART "If something looks wrong" + handoff): EventBus is
  in-process; events in flight during a restart are dropped; the poll loop is
  the durability backstop; with the M3 lease sweep, in_progress recovery is now
  automatic.

## Test plan (failing-first per fix)

- Hub: claim sets a lease; heartbeat extends it and 409s for non-owner /
  non-in_progress; sweep requeues expired in_progress to the right status,
  increments reclaim_count, fails over the cap, handles phase tasks; migration
  0018 backfills; :memory: throw in production env; complete/fail idempotency.
- Daemon: heartbeat loop beats active tasks and skips synthetics; lease_lost
  kills the local instance without failTask; wall-clock timeout kills and fails
  through retry; completeTask retry defers cleanup, exhaustion keeps the done
  file and the poll loop re-attempts; 4xx stops retries and cleans up.
- End-to-end (verifier, smoke skill): kill a worker daemon mid-task (SIGKILL),
  watch the hub reclaim after lease expiry (short TTL via env), watch a fresh
  worker re-claim and complete. Second scenario: hub briefly down at task
  completion; daemon retries; task completes when hub returns.

## Worker split

- infra (issue 50): cd.yml, compose files, workflow docs. No package code.
- hub-engineer (1 hub-side, 15, idempotency checks): migrate.ts 0018, config,
  claim, heartbeat route, sweep, tests.
- daemon-engineer (1 daemon-side, 4, 14): config, hub-client, daemon.ts loops,
  tests. Contract with hub: `POST /tasks/:id/heartbeat` ->
  `{ok:true, leaseExpiresAt}` | `409 {error:'lease_lost'}`.
