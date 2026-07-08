---
name: smoke
description: Boot the full Vibe Forge stack locally (hub + FM daemon + worker daemon + dash) and run one real task through dispatch to done-file. Use to verify any change to the hub/daemon/dash interplay end-to-end.
---

# Local end-to-end smoke (validated 2026-07-07)

Boots hub + dispatcher daemon + worker daemon + dashboard on this machine and runs a
real task through the loop. Total ~5 min plus one Sonnet agent run.

## Rules

- Never touch `packages/forge-hub/dev.db` (Adam's dev data). Always use a fresh DB
  file (`product-pass.db` pattern) and delete it after.
- Point `FORGE_DAEMON_WORKDIR` at a scratch repo OUTSIDE forge-lab (e.g.
  `G:\dev\forge-pass-smoke`) so spawned agents cannot touch the real working tree.
- ALWAYS set `FORGE_DAEMON_MODEL=claude-sonnet-4-6` (never let the CLI default win;
  that is the $95 Opus failure mode - issue 6).
- Kill only pids you started. Log daemons to files; no visible windows.

## Boot sequence

1. `pnpm install && pnpm build` at repo root (dist binaries are what you run).
2. Hub (from `packages/forge-hub`):
   `FORGE_HUB_PORT=3000 FORGE_HUB_DATABASE_URL=file:./smoke.db FORGE_HUB_SESSION_SECRET=<32+ chars> FORGE_HUB_COOKIE_SECURE=false node dist/bin/forge-hub.js`
   Migrations auto-run. Verify: `curl http://localhost:3000/healthz` -> `{"status":"ok"}`.
3. Onboard via API (cookie jar in scratchpad):
   - `POST /auth/register {"email","password"}` (first user = admin)
   - `POST /auth/login` (save cookie)
   - `POST /workspaces {"name","slug","description"}` - do NOT send `repoUrl: null`
     (422, issue 29); omit optional fields.
   - `POST /devices {"name":"smoke-fm","deviceType":"orchestrator","agentId":"forge-master"}`
   - `POST /devices {"name":"smoke-worker","deviceType":"worker","agentId":"architect"}`
     The device row's agentId (set only at registration, issue 47) controls claim
     eligibility; a worker registered without it cannot claim tasks FM routes to a
     named agent.
   - Tokens are shown ONCE in the response; capture them.
4. Daemons (from `packages/forge-daemon`, `node dist/bin/forge-daemon.js`):
   - FM: `FORGE_DAEMON_HUB_URL=http://localhost:3000 FORGE_DAEMON_DEVICE_TOKEN=<orch> FORGE_DAEMON_DISPATCHER_MODE=true FORGE_DAEMON_DISPATCHER_PERSONALITY=forge-master FORGE_DAEMON_WORKSPACE_ID=<ws> FORGE_DAEMON_WORKDIR=<scratch> FORGE_DAEMON_MODEL=claude-sonnet-4-6 FORGE_DAEMON_SKIP_PERMISSIONS=true`
   - Worker: same minus dispatcher vars, with the worker token. Note: unset
     `FORGE_DAEMON_AGENT_ID` silently means `architect` (issue 12).
5. Dash (from `packages/forge-dash-community`):
   `FORGE_HUB_URL=http://localhost:3000 FORGE_WORKDIR=<scratch> pnpm dev` (port 3001).
   First compile ~30s; login with the smoke user.
6. Create a task. Two paths, intentionally different behavior:
   - Flat `POST /tasks` (device/user) -> status `pending_agent`, worker claims
     directly, FM never triages (documented automation path).
   - FM triage path (issue 2, FIXED in M1): `POST /workspaces/:id/tasks` with no
     `assignedAgentId` -> status `pending_dispatcher_action`, FM triages and routes.
     See the initialStatus logic in forge-hub tasks.ts around line 1932 (plain
     non-sequenced branch of the workspace create handler). No workaround needed.
7. Watch: task status via `GET /tasks/:id` (worker bearer token), daemon logs, agent
   log at `<scratch>/context/agent-logs/<taskId>.log`, done file at
   `<scratch>/.forge/tasks/<taskId>.done`.

## Success criteria

Task reaches `completed`; the work artifact exists IN THE SCRATCH REPO (check the
path - issue 3: agents can lose cwd and write to a parent dir; a "failed" task with
"agent exited without completing" plus artifacts elsewhere means the done-file race,
not a real failure); dash task detail shows the history timeline.

## Teardown

Kill hub/daemon/dash pids you started (they are recorded when you launch them),
delete the smoke DB file, `git -C <scratch> clean -fdx` or delete stray artifacts in
the scratch repo AND check `G:\dev` for strays (`SMOKE_RESULT.md`, `.forge/`).
