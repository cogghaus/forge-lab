# Quickstart: clone to first dispatched task

Boots the full forge-lab stack (hub, FM dispatcher daemon, one worker daemon,
dashboard) on a single machine and walks a task from creation through FM
triage to a completed done-file. Everything below is the local/dev boot
path. For the production deployment model (Docker Compose + CD to
deploy-host), see `docs/runbooks/production-deployment.md`'s superseded
banner, and `deploy/daemons.compose.yml` in the repo root.

Total time: about 10-15 minutes plus one agent run (a few minutes, depending
on the task).

---

## 1. Prerequisites

| Dependency | Version | Verify |
|---|---|---|
| Node.js | 20.11.0+ LTS | `node --version` |
| pnpm | 10+ | `pnpm --version` |
| Claude CLI | any, authenticated | `claude --version` |
| Git | any | `git --version` |
| curl | any (or an HTTP client of your choice) | `curl --version` |

The Claude CLI must be on `PATH` and already authenticated (`claude` should
work interactively with no login prompt) before you boot any daemon. Daemons
spawn `claude` as a child process; if it cannot authenticate, agents never
produce output and tasks stall in `in_progress` forever (there is no
lease/heartbeat/reclaim yet, so a stuck task needs a manual cancel or
retry).

---

## 2. Clone and build

```bash
git clone https://github.com/cogghaus/forge-lab.git
cd forge-lab
pnpm install
pnpm build
```

`pnpm build` runs `turbo run build` and compiles every package in
dependency order. The two binaries you run directly are:

- `packages/forge-hub/dist/bin/forge-hub.js`
- `packages/forge-daemon/dist/bin/forge-daemon.js`

The dashboard (`packages/forge-dash-community`) is a Next.js app; you run it
with `pnpm dev`, not a compiled binary (see step 6).

If you only want to sanity-check the build without booting anything:

```bash
pnpm test
```

Node 20+ and pnpm 10+ are hard requirements; the repo is TypeScript strict
(`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` on) and will not
build under older tooling.

---

## 3. Boot the hub with a fresh database

Never point a fresh-machine walkthrough at `packages/forge-hub/dev.db` or
any existing database file - that may be someone's real data. Always use a
new file and delete it when you tear down.

From `packages/forge-hub`:

```bash
cd packages/forge-hub
FORGE_HUB_PORT=3000 \
FORGE_HUB_DATABASE_URL=file:./quickstart.db \
FORGE_HUB_SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
FORGE_HUB_COOKIE_SECURE=false \
node dist/bin/forge-hub.js
```

On Windows PowerShell, set the env vars first and run the binary separately,
or use the Bash tool / Git Bash shown above. `FORGE_HUB_SESSION_SECRET` must
be at least 32 characters; the `node -e` one-liner generates a random one.
`FORGE_HUB_COOKIE_SECURE=false` is required for local HTTP (no TLS); leave
it unset (defaults true-equivalent behavior in prod) once you're behind
HTTPS.

Migrations run automatically on startup (18 hand-written migrations,
`0000_init` through `0017_agent_memory` as of this writing). Verify the hub
is up:

```bash
curl http://localhost:3000/healthz
# {"status":"ok"}
```

There is no `/health` route, only `/healthz`, and it is the one endpoint
that skips auth.

Keep this terminal running (or background it and log to a file - do not
leave a foreground process blocking your only shell if you plan to do
everything from one machine).

---

## 4. Create the first user, a workspace, and register devices

All of this happens over HTTP against the hub you just started. Use a
cookie jar file so the session cookie persists across curl calls.

### 4.1 Register the first user (becomes admin automatically)

```bash
curl -s -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"a-strong-password"}'
```

The **first** registered user becomes admin. All subsequent `/auth/register`
calls return `403 registration_disabled` by design - this is a
single-operator tool, not a multi-tenant signup flow.

### 4.2 Log in and save the session cookie

```bash
curl -s -c cookies.txt -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"a-strong-password"}'
```

`cookies.txt` now holds the session cookie; pass `-b cookies.txt` on every
authenticated call below.

### 4.3 Create a workspace

```bash
curl -s -b cookies.txt -X POST http://localhost:3000/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name":"Quickstart","slug":"quickstart","description":"First workspace"}'
```

Save the returned `id` as `WORKSPACE_ID`. **Do not** include `"repoUrl":
null` in this payload - the schema declares `repoUrl` as optional but
**not nullable**, so an explicit `null` fails validation with `422`. Omit
the field entirely if you have no repo to bind yet.

Creating a workspace automatically:
- makes you its `owner` (sufficient role for everything in this walkthrough
  - task creation only requires `collaborator` or above)
- seeds a default 9-agent roster (`architect`, `furnace`, `anvil`,
  `crucible`, `oracle`, `scribe`, `herald`, `temper`, `aegis`) into the
  workspace's `agents` table, so FM has something to route to immediately.
  You do not need a manual `POST /workspaces/:id/agents` step.

### 4.4 Register the FM (dispatcher) device

```bash
curl -s -b cookies.txt -X POST http://localhost:3000/devices \
  -H "Content-Type: application/json" \
  -d '{"name":"quickstart-fm","deviceType":"orchestrator","agentId":"forge-master"}'
```

The response includes a `token` field. **Copy it now - tokens are shown
exactly once.** If you lose it, delete the device and register again. Save
it as `FM_TOKEN`.

### 4.5 Register a worker device

```bash
curl -s -b cookies.txt -X POST http://localhost:3000/devices \
  -H "Content-Type: application/json" \
  -d '{"name":"quickstart-worker","deviceType":"worker","agentId":"architect"}'
```

Save the returned `token` as `WORKER_TOKEN`.

**This `agentId` field is not optional in practice, even though the schema
allows omitting it.** Claim eligibility is enforced entirely from the
device row's `agentId`. A worker device with no `agentId` on its row can
only claim tasks with `assignedAgentId IS NULL` (unrouted tasks); once FM
triages a task and assigns it to a specific agent (e.g. `architect`), that
worker gets `409 not_claimable` for the task until the device row is
fixed. Register the worker WITH `agentId` set to one of the seeded roster
names (`architect` is used above) so FM can route to it by name.

If the device row ends up with the wrong `agentId` (or none), the repair
path is:

- Inspect the row the hub actually has, using the device's bearer token:
  ```bash
  curl -s -H "Authorization: Bearer <WORKER_TOKEN>" http://localhost:3000/devices/me
  ```
- Update it with your session cookie (unknown agent identifiers are
  rejected with `422 unknown_agent`):
  ```bash
  curl -s -b cookies.txt -X PATCH http://localhost:3000/devices/<deviceId> \
    -H "Content-Type: application/json" \
    -d '{"agentId":"architect"}'
  ```

`FORGE_DAEMON_AGENT_ID` (the daemon's own env var, set in step 5) only
selects which personality file the daemon spawns with; it does not affect
what the hub lets the device claim. The device row is authoritative.

---

## 5. Boot the daemons

Open two more terminals (or background these too). Both run the same
binary, `packages/forge-daemon/dist/bin/forge-daemon.js`, with different
env vars. Run both from `packages/forge-daemon`.

**Always set `FORGE_DAEMON_MODEL=claude-sonnet-4-6` explicitly.** The code
now defaults to sonnet if this is unset, but do not rely on that - a past
incident where an unpinned model silently fell through to Opus burned
significant API spend in two days. Pin it explicitly every time.

### 5.1 FM (dispatcher) daemon

```bash
cd packages/forge-daemon
FORGE_DAEMON_HUB_URL=http://localhost:3000 \
FORGE_DAEMON_DEVICE_TOKEN=<FM_TOKEN> \
FORGE_DAEMON_DISPATCHER_MODE=true \
FORGE_DAEMON_DISPATCHER_PERSONALITY=forge-master \
FORGE_DAEMON_WORKSPACE_ID=<WORKSPACE_ID> \
FORGE_DAEMON_WORKDIR=<scratch-dir, e.g. /path/to/forge-quickstart-workdir> \
FORGE_DAEMON_MODEL=claude-sonnet-4-6 \
FORGE_DAEMON_SKIP_PERMISSIONS=true \
node dist/bin/forge-daemon.js
```

### 5.2 Worker daemon

```bash
cd packages/forge-daemon
FORGE_DAEMON_HUB_URL=http://localhost:3000 \
FORGE_DAEMON_DEVICE_TOKEN=<WORKER_TOKEN> \
FORGE_DAEMON_AGENT_ID=architect \
FORGE_DAEMON_WORKSPACE_ID=<WORKSPACE_ID> \
FORGE_DAEMON_WORKDIR=<same scratch-dir as above> \
FORGE_DAEMON_MODEL=claude-sonnet-4-6 \
FORGE_DAEMON_SKIP_PERMISSIONS=true \
node dist/bin/forge-daemon.js
```

Set `FORGE_DAEMON_AGENT_ID` on the worker to match the `agentId` you
registered its device with (`architect` in this walkthrough) - it selects
which personality file the spawned agent uses. If you leave it unset, the
daemon silently defaults to `architect` anyway and logs a startup warning;
better to set it explicitly so the personality and the device's claim
eligibility agree.

`FORGE_DAEMON_WORKDIR` is where task files, agent logs, and done markers
get written. **Point it at a scratch directory outside this repo** (e.g.
`~/forge-quickstart-workdir`), never at the forge-lab working tree itself -
spawned agents can and do write files relative to their cwd, and you do not
want that landing in your clone.

Both daemons should log that they connected to the hub and are polling.
Leave them running.

---

## 6. Boot the dashboard

In a fourth terminal, from `packages/forge-dash-community`:

```bash
cd packages/forge-dash-community
FORGE_HUB_URL=http://localhost:3000 \
FORGE_WORKDIR=<same scratch-dir as the daemons> \
pnpm dev
```

This runs `next dev --port 3001`. First compile takes roughly 30 seconds.
Open `http://localhost:3001` and log in with the user you created in step
4.1. `FORGE_WORKDIR` must match the daemons' `FORGE_DAEMON_WORKDIR` exactly
- the dashboard's SSE log-stream route reads agent logs and done markers
from that same path.

---

## 7. Create a task and watch it dispatch

You can do this from the dashboard UI (Workspaces -> your workspace ->
create task) or via curl. The curl version, scoped to the workspace you
created:

```bash
curl -s -b cookies.txt -X POST http://localhost:3000/workspaces/<WORKSPACE_ID>/tasks \
  -H "Content-Type: application/json" \
  -d '{"projectPrefix":"qs","title":"Quickstart smoke task","description":"Write a one-line file to prove the loop works."}'
```

Two things to get right here:

- **`projectPrefix` must be 2-6 lowercase letters, no digits, no
  uppercase** (`^[a-z]+$`). `qs`, `fl`, `demo` are all valid; `QS`, `q1`,
  `a` (too short), `toolongforthis` (too long) all fail with `400`/`422`.
- **Do not set `assignedAgentId`.** Leaving it unset is what routes the
  task to FM for triage. This is the workspace-scoped endpoint
  (`POST /workspaces/:id/tasks`), which is deliberately different from the
  flat device/automation endpoint (`POST /tasks`): the flat endpoint
  defaults straight to `pending_agent` so a worker can claim it directly
  with no triage step, while the workspace endpoint routes an unassigned
  task to `pending_dispatcher_action` (FM's inbox) so Forge Master decides
  who should do it. Use the workspace endpoint for anything you want FM to
  triage, and only pre-assign `assignedAgentId` yourself when you want to
  bypass triage on purpose.

### What you should see

1. Task status starts at `pending_dispatcher_action`.
2. The FM daemon polls, claims it, and spawns the `forge-master` personality
   to triage. Watch its terminal output, or:
   ```bash
   curl -s -b cookies.txt http://localhost:3000/workspaces/<WORKSPACE_ID>/tasks/<taskId> | jq .status
   ```
3. FM assigns the task to an agent it picks from the workspace roster;
   status moves to `assigned` (a distinct status, not `pending_agent`)
   with `assignedAgentId` set. FM makes a real routing decision here: it
   may pick `architect`, or it may pick another roster agent entirely (a
   live verification run of this exact walkthrough got `crucible`). Check
   what it chose:
   ```bash
   curl -s -b cookies.txt http://localhost:3000/workspaces/<WORKSPACE_ID>/tasks/<taskId> | jq .assignedAgentId
   ```
4. If the routed agent differs from the `agentId` you registered your
   worker device with, that is a normal first-run occurrence, not an
   error: your single worker can only claim tasks routed to its own
   agentId. Point the device at the routed agent (this is the PATCH
   repair path from step 4.5):
   ```bash
   curl -s -b cookies.txt -X PATCH http://localhost:3000/devices/<deviceId> \
     -H "Content-Type: application/json" \
     -d '{"agentId":"<routed value>"}'
   ```
   The worker claims the task on its next poll. This same mismatch is
   what produces the `409 not_claimable` entry under "If something looks
   wrong" below.
5. The worker daemon claims the task; status moves to `in_progress`.
6. The worker daemon spawns `claude` with its personality. An agent log
   appears at:
   ```
   <scratch-dir>/context/agent-logs/<taskId>.log
   ```
7. When the agent finishes, the task status flips to `completed` (or
   `failed` if the agent process errored out; check the agent log first).
   Success evidence is that `completed` status plus the artifact the agent
   wrote in the scratch workdir (for the example task above, the one-line
   file it was asked to create). The agent does write a done marker at
   `<scratch-dir>/.forge/tasks/<taskId>.done`, but do not go looking for
   it as proof: it is a transient protocol marker, and the daemon deletes
   it (along with the task file) as soon as it reports completion to the
   hub, so on a successful run you will normally never see it.

You can watch all of this live in the dashboard task detail view too; it
shows the full history timeline and streams the agent log over SSE.

### If something looks wrong

- **Task never leaves `pending_dispatcher_action`:** confirm the FM
  daemon's `FORGE_DAEMON_WORKSPACE_ID` matches the workspace you created
  the task in, and that its device token is still valid.
- **Task reaches `assigned` (or `pending_agent`) but no worker claims it,
  and the worker logs `409 not_claimable`:** almost always the device
  `agentId` mismatch described in steps 4.5 and 7.4. Compare the task's
  `assignedAgentId` against `GET /devices/me` for the worker, and repair
  with `PATCH /devices/:deviceId {"agentId":"<routed value>"}`.
- **Task marked `failed` but you can see output in the agent log and a
  file was written somewhere:** check whether the artifact landed in the
  scratch dir specifically, not a parent directory. Agents can lose track
  of their working directory; a "failed" status with a legitimate-looking
  artifact in the wrong place is a done-file path bug, not necessarily a
  broken agent run.
- **A task sits in `in_progress` forever:** there is no automatic
  reclaim for a daemon that crashes mid-task. Cancel it manually
  (`POST /tasks/:id/cancel` or the dashboard's cancel action) and retry.

---

## 8. Tearing down

- Stop the hub, both daemons, and the dashboard (Ctrl-C each, or kill the
  pids you started).
- Delete `packages/forge-hub/quickstart.db` (and any `-wal`/`-shm`
  sidecar files next to it).
- Delete or `git clean` your scratch `FORGE_DAEMON_WORKDIR` - it will
  contain `.forge/tasks/`, `context/agent-logs/`, and whatever artifacts
  the agent produced.
- Double check you did not leave stray files inside the forge-lab clone
  itself (agents occasionally lose cwd and write there instead of the
  scratch dir - see the troubleshooting note above).

---

## Where to go next

- **Production / always-on deployment:** `docs/runbooks/production-deployment.md`
  is superseded - read the banner at its top, then use the compose +
  Traefik model (`deploy/daemons.compose.yml`, `lab.local` domain, CD on
  merge to `main`) instead of the PM2 instructions in the body of that
  file.
- **Repo-wide context and hard constraints:** `docs/handoff/HANDOFF.md` and
  `.claude/HANDOFF.md`.
- **Known traps and issue tracking:** `issues/issues.json`.
- **The validated end-to-end smoke procedure** (used to verify hub/daemon/
  dash changes, not a first-time walkthrough): `.claude/skills/smoke/SKILL.md`.
