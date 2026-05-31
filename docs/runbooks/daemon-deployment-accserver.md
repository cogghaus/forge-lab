# Agent Daemon Deployment (accserver, Docker)

**Status**: active — this is the LIVE production setup as of 2026-05-30.
**Supersedes**: the PM2 model in `multi-daemon-setup.md` for production. PM2 is
still valid for local/dev; production on accserver runs the daemons as Docker
containers.

---

## Where things live

| Thing | Location |
|-------|----------|
| App server | **accserver = 192.168.66.220** (NOT accskynet/.226) |
| Docker access | `adam` is in the `docker` group — plain `docker` over SSH, no sudo |
| Main stack | compose project `deploy`, `deploy/compose.yml` (hub/dash/mcp) |
| Internal network | `deploy_vibe-forge-internal` |
| Daemon stack | compose project `forge-daemons`, `deploy/daemons.compose.yml` |
| Daemon image | `vibe-forge-daemon:latest` (built on accserver from `~/dev/forge-lab`) |
| Hub (host) | `http://localhost:3000` (also `forge-hub:3000` on the internal net) |
| Hub admin | `adam@cogg.haus` / `PLACEHOLDER_CHANGE_ME` (CHANGE THIS) |
| Workspace | `forge-lab` = `KDzHTInHhuzjST8HDRy8x` |
| Claude OAuth home | `/datapool/docker/vibe-forge/claude-home` (uid 1001, seeded from accskynet `~/.claude`) |
| Device tokens | `~/dev/forge-lab/deploy/.env.daemons` on accserver (gitignored) |
| Repo checkout | `~/dev/forge-lab` on accserver |

## The 9 daemons

`forge-fm` (orchestrator, dispatcher mode) + 8 workers: `forge-architect`,
`forge-furnace`, `forge-anvil`, `forge-crucible`, `forge-oracle`,
`forge-scribe`, `forge-herald`, `forge-temper`.

One image, behavior driven by `FORGE_DAEMON_*` env per service. Each container
runs as the non-root `forge` user (uid 1001) because `claude` refuses
`--dangerously-skip-permissions` as root. Each spawns `claude --print` per task
(background runtime); the agent writes `.forge/tasks/<taskId>.done` and the
daemon reports completion to the hub.

## Auth model (subscription OAuth)

All 9 containers mount the same golden home `/datapool/docker/vibe-forge/claude-home`
at `/home/forge` (read-write — claude refreshes tokens in place). It holds
`.claude/.credentials.json` + `.claude.json` copied from an authenticated
machine (accskynet).

> **Known limitation**: a shared writable home across 9 claude processes can
> race on `.claude.json` writes and refresh-token rotation. Fine for light load;
> for heavy fan-out switch to `ANTHROPIC_API_KEY` (set it in each service env and
> drop the OAuth mount).

## Common operations

All run on accserver (`ssh adam@192.168.66.220`), from `~/dev/forge-lab`.

```bash
# Status
docker ps --filter label=com.docker.compose.project=forge-daemons \
  --format '{{.Names}}\t{{.Status}}'

# Logs
docker logs --tail 50 forge-fm
docker exec forge-furnace sh -lc 'cat /workdir/context/agent-logs/<taskId>.log'

# Start / restart all 9
docker compose -p forge-daemons -f deploy/daemons.compose.yml \
  --env-file deploy/.env.daemons up -d

# Rebuild image + restart (after daemon code changes: git pull first)
docker compose -p forge-daemons -f deploy/daemons.compose.yml \
  --env-file deploy/.env.daemons up -d --build

# One service
docker compose -p forge-daemons -f deploy/daemons.compose.yml \
  --env-file deploy/.env.daemons up -d forge-furnace

# Stop all
docker compose -p forge-daemons -f deploy/daemons.compose.yml down
```

## First-time / rebuild-from-scratch

1. Clone repo: `git clone … ~/dev/forge-lab` (accserver has git creds).
2. Build image: `cd ~/dev/forge-lab && docker build -f packages/forge-daemon/Dockerfile -t vibe-forge-daemon:latest .`
3. Seed OAuth home (from a machine with `claude` logged in, e.g. accskynet):
   ```bash
   # on the authed box:
   scp ~/.claude/.credentials.json adam@192.168.66.220:~/seed/.claude/
   scp ~/.claude.json              adam@192.168.66.220:~/seed/.claude.json
   # on accserver:
   sudo mkdir -p /datapool/docker/vibe-forge/claude-home
   sudo cp -r ~/seed/.claude        /datapool/docker/vibe-forge/claude-home/
   sudo cp    ~/seed/.claude.json   /datapool/docker/vibe-forge/claude-home/
   sudo chown -R 1001:1001          /datapool/docker/vibe-forge/claude-home
   ```
4. Mint device tokens (FM = orchestrator, the rest = worker) into
   `deploy/.env.daemons` — see `multi-daemon-setup.md` Step 1 for the curl loop,
   pointed at `http://localhost:3000`. Required keys:
   `FORGE_DAEMON_WORKSPACE_ID`, `FORGE_FM_TOKEN`, and
   `FORGE_{ARCHITECT,FURNACE,ANVIL,CRUCIBLE,ORACLE,SCRIBE,HERALD,TEMPER}_TOKEN`.
5. `docker compose -p forge-daemons … up -d`.

## Validation (smoke test)

```bash
# login, create a worker-path task assigned to furnace
curl -s -c /tmp/c -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"adam@cogg.haus","password":"PLACEHOLDER_CHANGE_ME"}' >/dev/null
curl -s -b /tmp/c -X POST http://localhost:3000/tasks \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"KDzHTInHhuzjST8HDRy8x","projectPrefix":"smoke",
       "title":"smoke","description":"Write SMOKE_OK.txt containing OK.",
       "status":"pending_agent","assignedAgentId":"furnace","priority":"normal"}'
# within ~20s the task should reach status=completed
curl -s -b /tmp/c http://localhost:3000/tasks/<id> | jq .status
```

Task-create schema gotchas: `projectPrefix` is required and must be
lowercase-alphanumeric; `priority` ∈ `low|normal|high|urgent`.

## Known benign log noise

- `forge-fm … 403 policy_denied` claiming worker tasks — Heimdall denies the
  orchestrator from claiming, by design.
- `409 not_claimable` when a task is already assigned to the claiming device.

## CD / runner

CD (`.github/workflows/cd.yml`) deploys ONLY the main 3-service stack, not the
daemons — deploy daemons manually with the commands above. The self-hosted
runner lives at `/datapool/docker/forge-lab/runner-compose.yml`; it bind-mounts
`/datapool/docker/vibe-forge` (ro) so `--env-file` resolves inside the runner.
See `reference_accserver_runner` memory for runner recovery.
