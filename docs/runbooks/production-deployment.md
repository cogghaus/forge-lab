# Production Deployment Runbook

**Date**: 2026-05-27
**Status**: SUPERSEDED (retired PM2 deployment model)
**Maintained by**: Ember

---

> ## Superseded
>
> This runbook describes a **retired PM2-based deployment** (`ecosystem.config.cjs`,
> per-daemon `.env.*` files, nginx at `hub.local.cogg.haus`). It is kept for
> historical reference only and does **not** describe how forge-lab is
> actually deployed today.
>
> **Current production model:** Docker Compose plus CD. The hub and daemon
> fleet run as containers defined in `deploy/daemons.compose.yml`
> (`ANTHROPIC_API_KEY` per-container, `FORGE_DAEMON_MODEL=claude-sonnet-4-6`
> pinned in compose), deployed to accserver via CD on merge to `main`, and
> served behind Traefik at `lab.local.cogg.haus` (not `hub.local.cogg.haus`,
> which is the stale hostname used below). See `docs/handoff/HANDOFF.md` for the
> current deployment snapshot and `context/architecture.md` /
> `context/project-context.md` for the current architecture.
>
> **For local/dev boot** (not production), use **`docs/QUICKSTART.md`**
> instead of this document: it walks a fresh clone through hub boot,
> device registration, daemon boot, and dashboard boot with the currently
> correct env vars and API calls.
>
> Nothing below this banner has been re-verified against the current
> codebase. Do not follow it for a new deployment.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [First-Time Setup](#2-first-time-setup)
3. [Environment Variables](#3-environment-variables)
4. [PM2 Ecosystem Config](#4-pm2-ecosystem-config)
5. [Device Registration](#5-device-registration)
6. [nginx Configuration](#6-nginx-configuration)
7. [Health Checks](#7-health-checks)
8. [Backup Procedure](#8-backup-procedure)
9. [Verification Procedure](#9-verification-procedure)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Prerequisites

Install and verify each dependency before proceeding.

| Dependency | Version | Verify |
|---|---|---|
| Node.js | 20.11.0+ LTS | `node --version` |
| pnpm | 10+ | `pnpm --version` |
| PM2 | latest | `pm2 --version` |
| Claude CLI | any | `claude --version` |
| Git | any | `git --version` |
| nginx | 1.18+ | `nginx -v` (optional, recommended) |
| sqlite3 | any | `sqlite3 --version` (for admin/backup) |

```bash
# Install PM2 globally
npm install -g pm2

# Verify claude CLI is on PATH and authenticated
claude --version

# Verify the claude binary absolute path (you'll need this for PM2)
which claude        # Linux/macOS
where claude        # Windows
```

> **Windows note**: This runbook assumes Linux/macOS for most shell steps. On Windows, substitute `where` for `which` and use PowerShell syntax where applicable (e.g. `$env:VAR` instead of `$VAR`, backtick for line continuation).

> **Claude CLI PATH note**: PM2 spawns processes with a stripped environment. If `claude` is not on the system-wide PATH, daemons will fail to spawn agents. Use the absolute path in `ecosystem.config.cjs` (see Section 4).

---

## 2. First-Time Setup

### 2.1 Clone and install

```bash
git clone https://github.com/sugar-crash-studios/forge-lab.git
cd forge-lab
pnpm install
```

### 2.2 Build all packages

```bash
pnpm build
```

This runs `turbo run build` and compiles all packages in dependency order:
- `@forge-lab/core`
- `@forge-lab/agents`
- `@forge-lab/hub` (outputs to `packages/forge-hub/dist/`)
- `@forge-lab/daemon` (outputs to `packages/forge-daemon/dist/`)
- `@forge-lab/forge-dash-community` (Next.js production build)

### 2.3 Create the hub environment file

```bash
cp packages/forge-hub/.env packages/forge-hub/.env.production
# Then edit packages/forge-hub/.env.production (see Section 3)
```

### 2.4 Database migrations

Migrations run automatically when the hub starts. No manual step required. The hub calls `runMigrations()` on every startup and skips already-applied migrations. To verify after first start:

```bash
sqlite3 /path/to/forge-hub.db ".tables"
# Expected output includes: users sessions devices tasks workspaces workspace_docs goals invites ...
```

### 2.5 Create per-daemon env files

```bash
# Copy the example files and fill in tokens after device registration (Section 5)
cp .env.example.fm      .env.fm
cp .env.example.architect .env.architect
cp .env.example.crucible  .env.crucible
cp .env.example.oracle    .env.oracle
cp .env.example.scribe    .env.scribe
cp .env.example.herald    .env.herald    # create manually, see Section 3
cp .env.example.temper    .env.temper    # create manually, see Section 3

# Workers not in the built-in personality registry (use hub agents table):
cp .env.example.furnace .env.furnace
cp .env.example.anvil   .env.anvil
```

### 2.6 Create the PM2 ecosystem config

Create `ecosystem.config.cjs` at the repo root. See Section 4 for the full file content.

### 2.7 Register devices

See Section 5. You must complete device registration before starting daemons.

### 2.8 Start with PM2

```bash
# Start hub and dash first
pm2 start ecosystem.config.cjs --only forge-hub,forge-dash

# Verify hub is healthy before starting daemons
curl http://localhost:3000/healthz

# Start all daemons
pm2 start ecosystem.config.cjs

# Save the process list (survives reboots)
pm2 save

# Enable PM2 startup on boot
pm2 startup
# Follow the printed command to register the init script
```

### 2.9 Configure nginx

See Section 6.

---

## 3. Environment Variables

### forge-hub

File: `packages/forge-hub/.env` (dev) or passed via PM2 `env_production` block.

```bash
# Port the Fastify server listens on. Default: 3000.
FORGE_HUB_PORT=3000

# Bind address. Use 127.0.0.1 when nginx terminates external traffic.
# Use 0.0.0.0 only if the hub must be reachable without a proxy.
FORGE_HUB_HOST=127.0.0.1

# libsql connection URL. For a local SQLite file use the file: prefix.
# The path can be absolute or relative to the cwd of the hub process.
FORGE_HUB_DATABASE_URL=file:/home/forge/forge-lab/forge-hub.db

# Cookie signing secret. Minimum 32 characters. Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
FORGE_HUB_SESSION_SECRET=<32+ char random string>

# Alternative: load secret from a file (takes precedence over SESSION_SECRET).
# FORGE_HUB_SESSION_SECRET_FILE=/run/secrets/forge-hub-session-secret

# Set to true when serving over HTTPS (tells Fastify to set Secure on cookies).
FORGE_HUB_COOKIE_SECURE=true

# Session TTL in hours. Default: 336 (14 days).
FORGE_HUB_SESSION_TTL_HOURS=336

# bcrypt work factor. Default: 12. Range: 10-15.
# Higher = slower logins but more resistant to offline attack.
FORGE_HUB_BCRYPT_COST=12
```

### forge-dash-community

File: `packages/forge-dash-community/.env.local` (Next.js reads this automatically).

```bash
# URL of the hub API, as seen by the Next.js server-side code.
# When hub and dash run on the same machine, localhost is correct.
FORGE_HUB_URL=http://localhost:3000

# Absolute path to the forge working directory.
# The SSE log-stream route reads agent logs from:
#   ${FORGE_WORKDIR}/context/agent-logs/{taskId}.log
# and checks for task completion at:
#   ${FORGE_WORKDIR}/.forge/tasks/{taskId}.done
# Must match FORGE_DAEMON_WORKDIR used by the daemons.
FORGE_WORKDIR=/home/forge/forge-workdir
```

### forge-daemon (all workers and FM)

Each daemon process gets its own env file. The shared variables are:

```bash
# Hub API URL. Must point at the hub's internal address (bypass nginx for daemons).
FORGE_DAEMON_HUB_URL=http://localhost:3000

# Device token returned by POST /devices during registration (Section 5).
FORGE_DAEMON_DEVICE_TOKEN=<token from device registration>

# Workspace ID this daemon is scoped to. Omit to process tasks across all workspaces.
FORGE_DAEMON_WORKSPACE_ID=<workspaceId>

# Agent identity. Must match the agentId registered with the device.
FORGE_DAEMON_AGENT_ID=architect

# Working directory for task files, agent logs, and done markers.
# Must match FORGE_WORKDIR in the dash env.
FORGE_DAEMON_WORKDIR=/home/forge/forge-workdir

# Runtime used to spawn agent processes. 'background' uses the BackgroundRuntime
# (ClaudeCodeRuntime with detached process). Do not change unless you know why.
FORGE_DAEMON_DEFAULT_RUNTIME=background

# Skip --dangerously-skip-permissions on spawned claude processes.
# Defaults to true when unset. Set to false only in supervised environments.
FORGE_DAEMON_SKIP_PERMISSIONS=true

# Max concurrent tasks this daemon will claim simultaneously. Default: 1.
FORGE_DAEMON_MAX_CONCURRENT_TASKS=1
```

**FM orchestrator only** (add to `.env.fm`):

```bash
FORGE_DAEMON_AGENT_ID=forge-master
FORGE_DAEMON_DISPATCHER_MODE=true
FORGE_DAEMON_DISPATCHER_PERSONALITY=forge-master

# Tasks assigned but not claimed within this many minutes are requeued. Default: 30.
FORGE_DAEMON_STALE_TTL_MINUTES=30
```

**Per-agent files** (fill in DEVICE_TOKEN and WORKSPACE_ID after Section 5):

| File | FORGE_DAEMON_AGENT_ID | deviceType |
|---|---|---|
| `.env.fm` | `forge-master` | `orchestrator` |
| `.env.architect` | `architect` | `worker` |
| `.env.crucible` | `crucible` | `worker` |
| `.env.oracle` | `oracle` | `worker` |
| `.env.scribe` | `scribe` | `worker` |
| `.env.herald` | `herald` | `worker` |
| `.env.temper` | `temper` | `worker` |
| `.env.furnace` | `furnace` | `worker` |
| `.env.anvil` | `anvil` | `worker` |

---

## 4. PM2 Ecosystem Config

Create this file at the repo root as `ecosystem.config.cjs`.

> **Before editing**: replace `/home/forge/forge-lab` with the actual repo path, and replace `/usr/local/bin/claude` with the output of `which claude` (or `where claude` on Windows).

> **WARNING: Never commit `ecosystem.config.cjs` with real secret values.** The hub session secret must not appear as a plaintext string in this file. Use PM2's `env_file` option to load it from a file that is excluded from version control, or load it at the top of the script via `require('dotenv').config({ path: '.env.hub' })`. The example below uses `env_file` for the hub. Keep `.env.hub` in `.gitignore`.

```javascript
// ecosystem.config.cjs
// Production PM2 process list for forge-lab.
// All paths are absolute. PM2 may run from any cwd.
//
// Secrets (FORGE_HUB_SESSION_SECRET, device tokens, etc.) are loaded from
// per-process env files. These files must NOT be committed to version control.
// Add them to .gitignore. Example for the hub:
//   echo "FORGE_HUB_SESSION_SECRET=$(node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\")" > .env.hub
//   echo ".env.hub" >> .gitignore

const REPO = '/home/forge/forge-lab';
const WORKDIR = '/home/forge/forge-workdir';
const LOGS = '/home/forge/forge-logs';
const NODE = process.execPath; // inherit node binary from whichever node is on PATH when pm2 starts

module.exports = {
  apps: [
    // -------------------------------------------------------------------------
    // Hub API server
    // -------------------------------------------------------------------------
    {
      name: 'forge-hub',
      script: `${REPO}/packages/forge-hub/dist/bin/forge-hub.js`,
      cwd: `${REPO}/packages/forge-hub`,
      interpreter: NODE,
      env_file: `${REPO}/.env.hub`,   // contains FORGE_HUB_SESSION_SECRET; never commit this file
      env_production: {
        NODE_ENV: 'production',
        FORGE_HUB_PORT: '3000',
        FORGE_HUB_HOST: '127.0.0.1',
        FORGE_HUB_DATABASE_URL: `file:${REPO}/forge-hub.db`,
        // FORGE_HUB_SESSION_SECRET: loaded from .env.hub (see env_file above)
        FORGE_HUB_COOKIE_SECURE: 'true',
        FORGE_HUB_SESSION_TTL_HOURS: '336',
      },
      watch: false,
      restart_delay: 3000,
      max_restarts: 10,
      error_file: `${LOGS}/forge-hub.error.log`,
      out_file: `${LOGS}/forge-hub.out.log`,
    },

    // -------------------------------------------------------------------------
    // Dashboard (Next.js)
    // -------------------------------------------------------------------------
    {
      name: 'forge-dash',
      script: 'node_modules/.bin/next',
      args: 'start --port 3001',
      cwd: `${REPO}/packages/forge-dash-community`,
      interpreter: NODE,
      env_production: {
        NODE_ENV: 'production',
        FORGE_HUB_URL: 'http://127.0.0.1:3000',
        FORGE_WORKDIR: WORKDIR,
      },
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      error_file: `${LOGS}/forge-dash.error.log`,
      out_file: `${LOGS}/forge-dash.out.log`,
    },

    // -------------------------------------------------------------------------
    // FM Orchestrator daemon
    // -------------------------------------------------------------------------
    {
      name: 'forge-fm',
      script: `${REPO}/packages/forge-daemon/dist/bin/forge-daemon.js`,
      cwd: REPO,
      interpreter: NODE,
      env_file: `${REPO}/.env.fm`,
      env_production: {
        NODE_ENV: 'production',
        FORGE_DAEMON_HUB_URL: 'http://127.0.0.1:3000',
        FORGE_DAEMON_AGENT_ID: 'forge-master',
        FORGE_DAEMON_DISPATCHER_MODE: 'true',
        FORGE_DAEMON_DISPATCHER_PERSONALITY: 'forge-master',
        FORGE_DAEMON_DEFAULT_RUNTIME: 'background',
        FORGE_DAEMON_SKIP_PERMISSIONS: 'true',
        FORGE_DAEMON_WORKDIR: WORKDIR,
        FORGE_DAEMON_STALE_TTL_MINUTES: '30',
        // FORGE_DAEMON_DEVICE_TOKEN: loaded from .env.fm
        // FORGE_DAEMON_WORKSPACE_ID: loaded from .env.fm
      },
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      error_file: `${LOGS}/forge-fm.error.log`,
      out_file: `${LOGS}/forge-fm.out.log`,
    },

    // -------------------------------------------------------------------------
    // Worker daemons: one entry per agent type
    // -------------------------------------------------------------------------
    ...[
      { name: 'forge-architect', agentId: 'architect',    envFile: '.env.architect' },
      { name: 'forge-crucible',  agentId: 'crucible',     envFile: '.env.crucible'  },
      { name: 'forge-oracle',    agentId: 'oracle',       envFile: '.env.oracle'    },
      { name: 'forge-scribe',    agentId: 'scribe',       envFile: '.env.scribe'    },
      { name: 'forge-herald',    agentId: 'herald',       envFile: '.env.herald'    },
      { name: 'forge-temper',    agentId: 'temper',       envFile: '.env.temper'    },
      { name: 'forge-furnace',   agentId: 'furnace',      envFile: '.env.furnace'   },
      { name: 'forge-anvil',     agentId: 'anvil',        envFile: '.env.anvil'     },
    ].map(({ name, agentId, envFile }) => ({
      name,
      script: `${REPO}/packages/forge-daemon/dist/bin/forge-daemon.js`,
      cwd: REPO,
      interpreter: NODE,
      env_file: `${REPO}/${envFile}`,
      env_production: {
        NODE_ENV: 'production',
        FORGE_DAEMON_HUB_URL: 'http://127.0.0.1:3000',
        FORGE_DAEMON_AGENT_ID: agentId,
        FORGE_DAEMON_DEFAULT_RUNTIME: 'background',
        FORGE_DAEMON_SKIP_PERMISSIONS: 'true',
        FORGE_DAEMON_WORKDIR: WORKDIR,
        FORGE_DAEMON_MAX_CONCURRENT_TASKS: '1',
        // FORGE_DAEMON_DEVICE_TOKEN: loaded from env_file
        // FORGE_DAEMON_WORKSPACE_ID: loaded from env_file
      },
      watch: false,
      restart_delay: 5000,
      max_restarts: 10,
      error_file: `${LOGS}/${name}.error.log`,
      out_file: `${LOGS}/${name}.out.log`,
    })),
  ],
};
```

Create the log directory:

```bash
mkdir -p /home/forge/forge-logs
mkdir -p /home/forge/forge-workdir
```

> **env_file vs env_production**: PM2's `env_file` loads a dotenv file. `env_production` values set here are merged on top when you run `pm2 start --env production`. If a key appears in both, `env_production` wins. Use `env_file` to carry the per-daemon secrets (device token, workspace ID) that differ per process.

---

## 5. Device Registration

Each daemon needs a device record in the hub's `devices` table. The hub returns a one-time token on registration; save it immediately.

### 5.1 Start the hub first

```bash
pm2 start ecosystem.config.cjs --only forge-hub --env production

# Wait for it to be online
pm2 status forge-hub

# Verify
curl http://localhost:3000/healthz
# Expected: {"status":"ok"}
```

### 5.2 Create a user account and log in

```bash
# Register the first admin user
curl -s -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@hub.local","password":"<strong-password>"}' \
  | jq .

# Log in and capture the session cookie
curl -s -c /tmp/forge-cookies.txt -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@hub.local","password":"<strong-password>"}' \
  | jq .
```

### 5.3 Create a workspace

```bash
curl -s -b /tmp/forge-cookies.txt -X POST http://localhost:3000/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name":"Production","slug":"production","description":"Main production workspace"}' \
  | jq .
# Save the returned "id" as WORKSPACE_ID
```

### 5.4 Register devices

The device registration route is `POST /devices`. Run each registration while authenticated (using the session cookie from 5.2).

Devices are scoped to a **user**, not a workspace. The `POST /devices` endpoint does not accept a `workspaceId` field. Workspace filtering for a daemon is configured entirely on the daemon side via the `FORGE_DAEMON_WORKSPACE_ID` environment variable; the hub uses that value when the daemon polls for tasks. The workspace ID is written to each daemon's env file below, but it is not sent to the device registration endpoint.

```bash
WORKSPACE_ID="<id from step 5.3>"   # Used only for daemon env config, NOT sent to POST /devices
HUB="http://localhost:3000"
COOKIES="/tmp/forge-cookies.txt"

# FM Orchestrator (deviceType must be "orchestrator")
TOKEN=$(curl -s -b $COOKIES -X POST $HUB/devices \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"forge-fm\",\"agentId\":\"forge-master\",\"deviceType\":\"orchestrator\"}" \
  | jq -r '.token')
echo "FORGE_DAEMON_DEVICE_TOKEN=$TOKEN" >> .env.fm
echo "FORGE_DAEMON_WORKSPACE_ID=$WORKSPACE_ID" >> .env.fm   # daemon-side workspace binding

# Worker daemons
for agent in architect crucible oracle scribe herald temper furnace anvil; do
  TOKEN=$(curl -s -b $COOKIES -X POST $HUB/devices \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"forge-${agent}\",\"agentId\":\"${agent}\",\"deviceType\":\"worker\"}" \
    | jq -r '.token')
  echo "FORGE_DAEMON_DEVICE_TOKEN=$TOKEN" >> .env.${agent}
  echo "FORGE_DAEMON_WORKSPACE_ID=$WORKSPACE_ID" >> .env.${agent}   # daemon-side workspace binding
  echo "Registered $agent: ${TOKEN:0:8}..."
done
```

> **Tokens are shown only once.** If you lose a token, delete the device and re-register.

### 5.5 Start all daemons

```bash
pm2 start ecosystem.config.cjs --env production
pm2 status
pm2 save
```

All processes should show `online` within 10-15 seconds.

---

## 6. nginx Configuration

Nginx acts as TLS terminator and reverse proxy. The dashboard is the default location (`/`); hub API routes live under `/api/hub/`.

The SSE endpoint (`GET /events` on the hub, exposed at `/api/hub/events` through the dash's Next.js proxy) requires `proxy_buffering off` and an extended read timeout to prevent connection drops.

```nginx
# /etc/nginx/sites-available/forge-lab

upstream forge_hub {
    server 127.0.0.1:3000;
    keepalive 64;
}

upstream forge_dash {
    server 127.0.0.1:3001;
    keepalive 32;
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name hub.local.cogg.haus;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name hub.local.cogg.haus;

    # --- TLS ---
    ssl_certificate     /etc/ssl/certs/hub.local.cogg.haus.crt;
    ssl_certificate_key /etc/ssl/private/hub.local.cogg.haus.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;

    # --- Security headers ---
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;

    # --- Hub API ---
    # Routes all /api/hub/* requests to the hub Fastify server.
    # 120s timeout is the safe floor: some hub routes (e.g. the task claim
    # endpoint) can block briefly waiting for available tasks before returning.
    # The more specific /api/hub/events location below overrides this for SSE.
    location /api/hub/ {
        proxy_pass         http://forge_hub/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Connection        "";
        proxy_read_timeout 120s;   # 120s floor: covers long-polling task claim; bump if needed
    }

    # --- SSE endpoint (task lifecycle events) ---
    # The Next.js dashboard proxies SSE at /api/hub/events; nginx routes that
    # path to the hub's own /events endpoint. This location must be listed AFTER
    # /api/hub/ so nginx's longest-prefix matching picks it up correctly.
    #
    # proxy_buffering off: required. Buffering would hold SSE frames until the
    #   buffer fills, so the browser would never receive individual events.
    # proxy_read_timeout 3600s: SSE connections are long-lived. The hub sends a
    #   heartbeat comment every 25s to keep the connection alive; 3600s keeps
    #   extended browser sessions connected without nginx closing the pipe.
    location /api/hub/events {
        proxy_pass         http://forge_hub/events;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Connection        "";
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 3600s;   # long-lived SSE connection; must exceed any idle window
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;
    }

    # --- Dashboard (everything else) ---
    location / {
        proxy_pass         http://forge_dash;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 60s;
    }
}
```

Enable and reload:

```bash
ln -s /etc/nginx/sites-available/forge-lab /etc/nginx/sites-enabled/forge-lab
nginx -t
systemctl reload nginx
```

---

## 7. Health Checks

### Hub

The hub exposes a health endpoint at `/healthz`. It does not require authentication.

```bash
curl http://localhost:3000/healthz
# Expected: {"status":"ok"}
```

> The endpoint is registered as `GET /healthz`. There is no `/health` route.

### Dashboard

```bash
curl -o /dev/null -s -w "%{http_code}" http://localhost:3001/
# Expected: 200
```

### PM2

```bash
pm2 status
# All processes should show status: online
```

Sample healthy output:

```
┌──────────────────┬────┬────────┬─────┬────────┬─────────┐
│ name             │ id │ mode   │ pid │ status │ cpu     │
├──────────────────┼────┼────────┼─────┼────────┼─────────┤
│ forge-hub        │ 0  │ fork   │ ... │ online │ 0%      │
│ forge-dash       │ 1  │ fork   │ ... │ online │ 0%      │
│ forge-fm         │ 2  │ fork   │ ... │ online │ 0%      │
│ forge-architect  │ 3  │ fork   │ ... │ online │ 0%      │
│ forge-crucible   │ 4  │ fork   │ ... │ online │ 0%      │
│ forge-oracle     │ 5  │ fork   │ ... │ online │ 0%      │
│ forge-scribe     │ 6  │ fork   │ ... │ online │ 0%      │
│ forge-herald     │ 7  │ fork   │ ... │ online │ 0%      │
│ forge-temper     │ 8  │ fork   │ ... │ online │ 0%      │
│ forge-furnace    │ 9  │ fork   │ ... │ online │ 0%      │
│ forge-anvil      │ 10 │ fork   │ ... │ online │ 0%      │
└──────────────────┴────┴────────┴─────┴────────┴─────────┘
```

### Database

```bash
sqlite3 /home/forge/forge-lab/forge-hub.db ".tables"
# Expected tables include:
# _migrations agents device sessions tasks users workspaces workspace_docs ...
```

---

## 8. Backup Procedure

### Hot backup (safe while hub is running)

libsql/SQLite supports online backup without locking out writers:

```bash
DB_PATH="/home/forge/forge-lab/forge-hub.db"
BACKUP_DIR="/home/forge/forge-backups"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"
sqlite3 "$DB_PATH" ".backup ${BACKUP_DIR}/forge-hub-${TIMESTAMP}.db"
echo "Backup written to ${BACKUP_DIR}/forge-hub-${TIMESTAMP}.db"
```

### Daily cron

Add to the `forge` user's crontab (`crontab -e`):

```cron
# Daily at 02:00: backup forge-hub database
0 2 * * * /home/forge/scripts/backup-forge.sh >> /home/forge/forge-logs/backup.log 2>&1
```

`/home/forge/scripts/backup-forge.sh`:

```bash
#!/bin/bash
set -euo pipefail

DB_PATH="/home/forge/forge-lab/forge-hub.db"
BACKUP_DIR="/home/forge/forge-backups"
RETAIN_DAYS=30
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

sqlite3 "$DB_PATH" ".backup ${BACKUP_DIR}/forge-hub-${TIMESTAMP}.db"
echo "[$(date -Iseconds)] Backup created: forge-hub-${TIMESTAMP}.db"

# Prune backups older than RETAIN_DAYS
find "$BACKUP_DIR" -name "forge-hub-*.db" -mtime +${RETAIN_DAYS} -delete
echo "[$(date -Iseconds)] Pruned backups older than ${RETAIN_DAYS} days"
```

```bash
chmod +x /home/forge/scripts/backup-forge.sh
```

### Restore procedure

```bash
# 1. Stop the hub to prevent writes during restore
pm2 stop forge-hub

# 2. Replace the database file
cp /home/forge/forge-backups/forge-hub-<TIMESTAMP>.db /home/forge/forge-lab/forge-hub.db

# 3. Restart
pm2 start forge-hub

# 4. Verify
curl http://localhost:3000/healthz
sqlite3 /home/forge/forge-lab/forge-hub.db "SELECT COUNT(*) FROM tasks;"
```

---

## 9. Verification Procedure

Run this end-to-end after every fresh deployment or hub restart.

### Step 1 -- Hub health

```bash
curl http://localhost:3000/healthz
# Must return: {"status":"ok"}
```

### Step 2 -- Dashboard loads

Open `https://hub.local.cogg.haus` in a browser. The login page should render within 3 seconds.

### Step 3 -- Login works

Log in with the admin account created in Section 5.2. Confirm the dashboard renders without console errors.

### Step 4 -- Create a workspace

Navigate to Workspaces, create a new workspace. Confirm it appears in the list.

### Step 5 -- Create a test task

Via the dashboard or curl:

```bash
curl -s -b /tmp/forge-cookies.txt -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"Smoke test\",\"description\":\"Verify daemon pickup\",\"workspaceId\":\"$WORKSPACE_ID\",\"status\":\"pending_dispatcher_action\"}" \
  | jq .
```

Use `pending_dispatcher_action` to verify the FM dispatcher loop picks it up. Use `pending_agent` with a known `assignedAgentId` to bypass FM and test the worker loop directly: set `"assignedAgentId": "architect"` (or whichever worker you want) and `"status": "pending_agent"` in the request body. Choose based on which component you are verifying: `pending_dispatcher_action` tests the full FM triage path; `pending_agent` isolates the worker daemon claim path.

### Step 6 -- Verify daemon claims the task

```bash
# Watch FM logs
pm2 logs forge-fm --lines 30 --nostream

# For a worker test, watch the relevant daemon
pm2 logs forge-architect --lines 30 --nostream
```

Expected log lines:
```
[forge-daemon] claimed task <taskId>
[forge-daemon] spawning agent forge-master for task <taskId>
```

### Step 7 -- Verify Claude CLI spawns

```bash
ls /home/forge/forge-workdir/context/agent-logs/
# Should contain a log file named <taskId>.log
```

```bash
tail -f /home/forge/forge-workdir/context/agent-logs/<taskId>.log
```

### Step 8 -- Verify task completes or times out predictably

Watch the task status via the dashboard or:

```bash
curl -s -b /tmp/forge-cookies.txt \
  http://localhost:3000/tasks/<taskId> | jq '.status'
# Expected progression: pending_dispatcher_action -> in_progress -> completed (or failed)
```

The done marker file appears at:

```bash
ls /home/forge/forge-workdir/.forge/tasks/<taskId>.done
```

### Step 9 -- Verify SSE live updates fire

1. Open the dashboard in a browser.
2. Open browser DevTools > Network tab, filter by `events`.
3. Confirm there is an active SSE connection to `/api/hub/events`.
4. Create a new task. Confirm the task list in the dashboard updates without a page refresh.

---

## 10. Troubleshooting

### Hub won't start

**Symptom**: `pm2 logs forge-hub` shows startup error.

| Cause | Fix |
|---|---|
| `DATABASE_URL` path is not writable | `chmod 755` the parent directory; ensure the process user owns it |
| Port 3000 already in use | `lsof -i :3000` to find the conflicting process; adjust `FORGE_HUB_PORT` |
| `FORGE_HUB_SESSION_SECRET` too short | Minimum 32 characters |
| Missing `dist/` directory | Run `pnpm build` from repo root |

### Daemon won't start

**Symptom**: `pm2 logs forge-architect` shows `ZodError` at startup.

| Cause | Fix |
|---|---|
| `FORGE_DAEMON_DEVICE_TOKEN` empty | Complete device registration (Section 5) |
| `FORGE_DAEMON_HUB_URL` missing or wrong scheme | Must include `http://` or `https://` |
| `FORGE_DAEMON_WORKDIR` does not exist | `mkdir -p /home/forge/forge-workdir` |

### Daemon won't claim tasks

**Symptom**: Tasks sit in `pending_agent` or `pending_dispatcher_action` indefinitely.

| Cause | Fix |
|---|---|
| `FORGE_DAEMON_WORKSPACE_ID` mismatch | Must match the workspace where tasks were created |
| Device token invalid (was revoked or not saved correctly) | Re-register device (Section 5.4) |
| `FORGE_DAEMON_AGENT_ID` mismatch | FM routes tasks by `assignedAgentId`; daemon's `FORGE_DAEMON_AGENT_ID` must match |
| Hub is down | Daemon polls hub; check hub status first |

### Claude CLI won't spawn

**Symptom**: Daemon claims task but no agent log file appears in `FORGE_WORKDIR/context/agent-logs/`.

| Cause | Fix |
|---|---|
| `claude` not on PM2's PATH | Use the absolute path to the `claude` binary in `ecosystem.config.cjs`. Add `PATH` to `env_production`: `PATH: '/home/forge/.npm-global/bin:/usr/local/bin:/usr/bin'` |
| `claude` not authenticated | Run `claude --version` as the same user PM2 runs under; re-auth if needed |
| `FORGE_DAEMON_SKIP_PERMISSIONS=false` | Background daemons require `true` for unattended operation |

```bash
# Quick test: can PM2's user run claude?
sudo -u forge claude --version
```

### SSE drops after ~60 seconds

**Symptom**: Dashboard stops receiving live updates; browser DevTools shows the SSE connection closing.

Cause: nginx `proxy_read_timeout` is at the default 60s.

Fix: Confirm the nginx SSE location block (Section 6) has `proxy_read_timeout 3600s`. Reload nginx:

```bash
nginx -t && systemctl reload nginx
```

### Task stuck in `in_progress`

**Symptom**: Task never transitions to `completed` or `failed`.

| Cause | Fix |
|---|---|
| Done marker never written | Check `FORGE_DAEMON_WORKDIR` is the same path the daemon and dash are both reading. Confirm the process user can write to it. |
| Claude process crashed | Check `pm2 logs forge-architect` for spawn errors. Check `FORGE_WORKDIR/context/agent-logs/<taskId>.log` for Claude output. |
| FM stale TTL requeue loop | If FM is requeuing a task it cannot triage, inspect task description and FM logs. |

```bash
# List done markers
ls /home/forge/forge-workdir/.forge/tasks/

# Inspect a specific task log
cat /home/forge/forge-workdir/context/agent-logs/<taskId>.log

# Force-fail a stuck task (last resort, via curl)
curl -s -b /tmp/forge-cookies.txt -X PATCH http://localhost:3000/tasks/<taskId> \
  -H "Content-Type: application/json" \
  -d '{"status":"failed"}' | jq .
```

### Checking which PM2 process owns a log

```bash
pm2 logs --list
# Shows each process with its out/error log paths

pm2 logs forge-scribe --lines 50 --nostream
```
