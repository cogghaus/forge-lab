# Multi-Daemon Setup Runbook

**Maintained by**: Scribe  
**Category**: runbook  
**Status**: active

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

**FM Orchestrator** (deviceType must be `orchestrator`):
```bash
curl -s -X POST http://localhost:3001/devices/register \
  -H "Content-Type: application/json" \
  -d '{"name":"forge-fm","agentId":"forge-master","deviceType":"orchestrator"}' \
  | jq -r '.token'
```

**Worker daemons** (use `worker` deviceType):
```bash
for agent in architect furnace anvil crucible oracle scribe; do
  echo -n "$agent: "
  curl -s -X POST http://localhost:3001/devices/register \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"forge-$agent\",\"agentId\":\"$agent\",\"deviceType\":\"worker\"}" \
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

*Note: When Scribe is running, it automatically ingests this runbook into the hub knowledge base as a `runbook` category doc on first task completion. The hub copy is what FM and other agents read from context.*
