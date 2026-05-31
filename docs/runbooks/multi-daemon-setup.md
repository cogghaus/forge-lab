# Multi-Daemon Setup Runbook

**Maintained by**: Scribe  
**Category**: runbook  
**Status**: active (PM2 model — local/dev)

> **Production note**: the live accserver fleet runs the daemons as **Docker
> containers**, not PM2. For the production deploy, creds, tokens, and ops see
> [`daemon-deployment-accserver.md`](./daemon-deployment-accserver.md). This
> document covers the PM2 model, still used for local/dev runs.

---

## Overview

forge-lab supports running one daemon process per agent type using PM2. Every daemon is the same `forge-daemon` binary; behavior is controlled by environment variables. The FM orchestrator daemon runs in dispatcher mode (no task claiming); worker daemons claim and execute tasks routed to their `agentId`.

```
forge-fm          orchestrator — triages pending_dispatcher_action tasks
forge-architect   worker — system design, ADRs, cross-cutting concerns
forge-furnace     worker — backend: API endpoints, DB schema, migrations
forge-anvil       worker — frontend: components, pages, hooks, styling
forge-crucible    worker — QA: tests, bug reproduction, coverage
forge-oracle      worker — product/BA: requirements, story breakdown
forge-scribe      worker — knowledge base: doc creation, audit, supersede
```

---

## Prerequisites

1. **PM2 installed globally**: `npm install -g pm2`
2. **forge-daemon built**: `pnpm --filter forge-daemon build`
3. **Hub running**: `pnpm --filter forge-hub dev` (or production equivalent)
4. **Device tokens**: one registered device token per daemon (see below)

---

## Step 1 — Register device tokens

Each daemon needs a unique device token registered in the hub. Run these once per workspace setup.

> **Hub port**: The hub listens on port **3000** by default. The registration endpoint is `POST /devices` (no `/register` suffix). The examples below use `localhost:3000`.

**FM Orchestrator** (deviceType must be `orchestrator`):
```bash
# Log in first and save the session cookie
curl -s -c /tmp/forge-cookies.txt -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@hub.local","password":"<password>"}' \
  | jq .

# Register the FM device (deviceType must be "orchestrator")
curl -s -b /tmp/forge-cookies.txt -X POST http://localhost:3000/devices \
  -H "Content-Type: application/json" \
  -d '{"name":"forge-fm","agentId":"forge-master","deviceType":"orchestrator"}' \
  | jq -r '.token'
```

**Worker daemons** (use `worker` deviceType):
```bash
for agent in architect furnace anvil crucible oracle scribe herald temper; do
  echo -n "$agent: "
  curl -s -b /tmp/forge-cookies.txt -X POST http://localhost:3000/devices \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"forge-${agent}\",\"agentId\":\"${agent}\",\"deviceType\":\"worker\"}" \
    | jq -r '.token'
done
```

Save each token — you cannot retrieve it again. Store in the corresponding `.env.<agent>` file.

---

## Step 2 — Create .env files

Copy the example templates and fill in the token and workspace ID:

```bash
cp .env.example.fm        .env.fm
cp .env.example.architect .env.architect
cp .env.example.furnace   .env.furnace
cp .env.example.anvil     .env.anvil
cp .env.example.crucible  .env.crucible
cp .env.example.oracle    .env.oracle
cp .env.example.scribe    .env.scribe
cp .env.example.herald    .env.herald
cp .env.example.temper    .env.temper
```

For each file, set:
- `FORGE_DAEMON_DEVICE_TOKEN=<token from Step 1>`
- `FORGE_DAEMON_WORKSPACE_ID=<your workspace ID>`

Workspace ID is available on the hub workspace page or via `GET /workspaces`.

---

## Step 3 — Start daemons

```bash
# Start all daemons
pm2 start ecosystem.config.cjs

# Check status
pm2 status

# Save process list so PM2 restarts on system reboot
pm2 save
pm2 startup   # follow the output instructions
```

---

## Common operations

### Start/stop individual daemons

```bash
pm2 start   ecosystem.config.cjs --only forge-furnace
pm2 stop    forge-furnace
pm2 restart forge-furnace
pm2 delete  forge-furnace
```

### Tail logs

```bash
pm2 logs forge-fm          # FM orchestrator logs
pm2 logs forge-furnace     # Furnace worker logs
pm2 logs                   # all daemons combined
```

Agent execution logs also appear in `./forge-workdir/context/agent-logs/`.

### Rolling restart after a daemon update

```bash
pnpm --filter forge-daemon build
pm2 restart ecosystem.config.cjs
```

### Reload config changes (zero-downtime for stateless workers)

```bash
pm2 reload ecosystem.config.cjs
```

---

## Add a new agent type

1. Register a new device token (worker type) as in Step 1.
2. Create a `.env.example.<agentname>` from any existing template.
3. Add a new app entry to `ecosystem.config.cjs`:
   ```js
   {
     name: 'forge-<agentname>',
     script: DAEMON_BIN,
     env_file: '.env.<agentname>',
     env: {
       ...COMMON_ENV,
       FORGE_DAEMON_AGENT_ID: '<agentname>',
     },
     max_memory_restart: '512M',
     restart_delay: 5000,
   },
   ```
4. Copy `.env.example.<agentname>` to `.<agentname>` and fill in token + workspace.
5. `pm2 start ecosystem.config.cjs --only forge-<agentname>`

---

## Scale a worker (run multiple instances)

PM2 supports multiple named instances of the same agent type. Atomic SQL claim prevents double-claiming.

```bash
# Copy the .env file for the second instance
cp .env.furnace .env.furnace-2
# (Optionally register a new device token for the second instance)
# Edit .env.furnace-2 to use the new token

# Start manually (not via ecosystem.config.cjs — avoids overwriting the first)
pm2 start ./packages/forge-daemon/dist/bin/forge-daemon.js \
  --name forge-furnace-2 \
  --env-file .env.furnace-2
```

Both instances compete for `assignedAgentId=furnace` tasks. FM's bottleneck detection observes queue depth and will note when an agent is overloaded.

---

## Concurrency per daemon

Set `FORGE_DAEMON_MAX_CONCURRENT_TASKS` in the daemon's `.env` file to allow one daemon to run multiple tasks in parallel. Default is `1`.

```bash
# Allow forge-furnace to run 3 tasks simultaneously
FORGE_DAEMON_MAX_CONCURRENT_TASKS=3
```

Each task spawns one Claude Code background process. Monitor memory: `pm2 monit`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Daemon exits immediately | Invalid `FORGE_DAEMON_DEVICE_TOKEN` or `FORGE_DAEMON_HUB_URL` | Verify hub is running; check token |
| Tasks stuck in `pending_dispatcher_action` | FM daemon not running | `pm2 start ecosystem.config.cjs --only forge-fm` |
| Tasks stuck in `pending_agent` (assigned) | Target worker daemon not running | Start the relevant worker daemon |
| FM stale requeue not happening | `FORGE_DAEMON_WORKSPACE_ID` not set on FM daemon | Required for dispatcher mode |
| 403 on FM assign attempts | FM device registered as `worker` instead of `orchestrator` | Re-register with `deviceType: "orchestrator"` |
| High memory usage | Many concurrent tasks per daemon | Reduce `FORGE_DAEMON_MAX_CONCURRENT_TASKS` |

---

## Environment variable reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FORGE_DAEMON_HUB_URL` | Yes | — | Hub API base URL |
| `FORGE_DAEMON_DEVICE_TOKEN` | Yes | — | Registered device token |
| `FORGE_DAEMON_AGENT_ID` | Yes | `architect` | Agent identity for task routing |
| `FORGE_DAEMON_WORKSPACE_ID` | Yes (FM) | — | Workspace scope; required for dispatcher mode |
| `FORGE_DAEMON_DISPATCHER_MODE` | FM only | `false` | `true` enables FM orchestrator mode |
| `FORGE_DAEMON_STALE_TTL_MINUTES` | FM only | `30` | Minutes before stale assigned tasks are requeued |
| `FORGE_DAEMON_MAX_CONCURRENT_TASKS` | No | unlimited | Max simultaneous task instances per daemon |
| `FORGE_DAEMON_DEFAULT_RUNTIME` | No | `background` | Runtime ID for spawning agents |
| `FORGE_DAEMON_WORKDIR` | No | `process.cwd()` | Task files and log directory |
| `FORGE_DAEMON_SKIP_PERMISSIONS` | No | `true` | Pass `--dangerously-skip-permissions` to Claude |

---

---

## Validation Checklist

Run after every fresh deployment or after restarting the daemon fleet. The automated smoke-test script (`scripts/smoke-test.sh`) covers items 1-6 automatically.

### Pre-flight

- [ ] `curl http://localhost:3000/healthz` returns `{"status":"ok"}`
- [ ] `pm2 status` shows all processes as `online`
- [ ] All daemon `.env` files exist and contain non-empty `FORGE_DAEMON_DEVICE_TOKEN`

### FM dispatcher path (full triage cycle)

- [ ] Create a task with `status: pending_dispatcher_action` in the target workspace
- [ ] Wait up to 60 seconds; confirm task status advances to `assigned` (FM triage ran)
- [ ] Confirm task status advances to `in_progress` (worker claimed it)
- [ ] Confirm `pm2 logs forge-fm` shows `[forge-daemon] claimed task` and `[forge-daemon] spawning agent`
- [ ] Confirm agent log appears at `$FORGE_DAEMON_WORKDIR/context/agent-logs/<taskId>.log`
- [ ] Confirm task reaches `completed` or `failed` within `TIMEOUT` seconds (default: 120)
- [ ] Confirm done marker at `$FORGE_DAEMON_WORKDIR/.forge/tasks/<taskId>.done`

### Worker-only path (bypass FM)

- [ ] Create a task with `status: pending_agent` and `assignedAgentId: architect`
- [ ] Confirm `forge-architect` daemon claims the task within 10 seconds
- [ ] Confirm agent log and done marker appear as above

### Done-file protocol verification

The done-file protocol determines how the daemon signals task completion to the hub and dashboard:

1. The daemon spawns a Claude Code process with `--dangerously-skip-permissions` (when `FORGE_DAEMON_SKIP_PERMISSIONS=true`).
2. Claude writes a `.done` file at `$FORGE_DAEMON_WORKDIR/.forge/tasks/<taskId>.done` when the task is finished.
3. The daemon polls for this file. On detection, it calls `PATCH /tasks/<taskId>` to set `status: completed`.
4. The hub emits a `task.completed` SSE event. Connected dashboard clients update in real time.

**Known deviations / limitations:**

- The done-file is written by the agent process (Claude CLI), not the daemon. If the Claude process crashes before writing the marker, the task stays `in_progress` indefinitely. The workaround is to cancel the task via the dashboard (`/workspaces/:id/tasks/:id`) and retry.
- `FORGE_DAEMON_SKIP_PERMISSIONS` must be `true` for unattended operation. In supervised mode (`false`), Claude prompts for each tool-use approval; the daemon cannot proceed without human input.
- PM2 strips the shell's PATH. If the `claude` binary is not on the system-wide PATH used by PM2, the spawn will fail silently. Fix: add `PATH` to `env_production` in `ecosystem.config.cjs`, or use the absolute path to `claude`.

### Automated smoke test

```bash
# Install dependencies: curl, jq, bash 4.0+

# Full FM triage path
./scripts/smoke-test.sh \
  --hub-url http://localhost:3000 \
  --email admin@hub.local \
  --password <password> \
  --workspace-id <workspaceId> \
  --timeout 120

# Worker-only path
./scripts/smoke-test.sh \
  --hub-url http://localhost:3000 \
  --email admin@hub.local \
  --password <password> \
  --workspace-id <workspaceId> \
  --task-type worker \
  --timeout 60
```

Exit code 0 = all checks passed. Exit code 1 = test failed or timed out.

---

*Note: When Scribe is running, it automatically ingests this runbook into the hub knowledge base as a `runbook` category doc on first task completion. The hub copy is what FM and other agents read from context.*
