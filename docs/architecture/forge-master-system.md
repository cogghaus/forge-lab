# Forge Master System — Architecture Reference

**Version**: 1.0  
**Date**: 2026-05-25  
**Maintained by**: Scribe  
**Status**: Active

---

## Overview

The Forge Master (FM) system transforms forge-lab from a single-agent dispatcher into an intelligent multi-agent orchestration platform. FM routes work, decomposes epics, detects bottlenecks, and maintains context about the workspace's current state and history. Scribe keeps the knowledge base current and manageable. Together they form the cognitive layer above the daemon/specialist execution layer.

```
┌──────────────────────────────────────────────────────────────────┐
│                         forge-hub (DB)                            │
│                                                                   │
│  workspaces  goals  agents  devices  agentInstances               │
│  tasks  taskHistory  taskComments  taskInstructions               │
│  workspaceDocs                                                    │
└──────┬──────────────────────────┬────────────────────────────────┘
       │ SSE events               │ HTTP API
       │                          │
┌──────▼──────────┐    ┌──────────▼──────────────────────────────┐
│  FM Daemon       │    │  Worker Daemons (one per agent type)     │
│  agentId: fm     │    │  agentId: architect | furnace | anvil |  │
│  type: orch.     │    │           crucible | oracle | scribe     │
│                  │    │  type: worker                            │
│  Dispatcher loop:│    │                                          │
│  pending_disp.   │    │  Worker loop:                            │
│  → spawn FM      │    │  pending_agent (matching agentId)        │
│  → FM triages    │    │  → claim → spawn specialist              │
│  → FM exits      │    │  → await done file → complete            │
└──────────────────┘    └──────────────────────────────────────────┘
```

---

## Task Status Pipeline

```
Created by user/API
  ↓
pending_dispatcher_action  ← FM's inbox
  FM decides:
    ├─ Simple task       → assignedAgentId set → pending_agent
    ├─ Needs breakdown   → subtasks created (parentId) → pending_agent (each)
    └─ Epic (too large)  → pending_design (Oracle's inbox)

pending_design             ← Oracle/BA agents analyze
  ↓ subtasks created
pending_dispatcher_action  ← FM sees subtasks
  ↓
pending_agent              ← Daemon's domain
  ↓ (claimed, assignedDeviceId set)
in_progress                ← Specialist running
  ↓ (done file written)
completed

Fast track:
  Task created with status=pending_agent (already routed externally)
  → daemon claims immediately, no FM involvement
```

---

## Agent Registry

Agents registered in the `agents` table per workspace. Each daemon instance maps to one `agents` row via `defaultAgentId = agents.name`.

| Agent | Role | deviceType | Key capability |
|-------|------|------------|---------------|
| `forge-master` | Orchestrator | orchestrator | Triage, decompose, route, bottleneck detection |
| `scribe` | Knowledge keeper | worker | Doc creation, audit, supersede stale content |
| `architect` | System design | worker | ADRs, technical decisions, cross-cutting concerns |
| `oracle` | Product/BA | worker | Requirements, story breakdown, acceptance criteria |
| `furnace` | Backend | worker | API endpoints, DB schema, migrations, services |
| `anvil` | Frontend | worker | Components, hooks, pages, styling |
| `crucible` | QA | worker | Tests, bug reproduction, coverage |
| `ember` | DevOps | worker | CI/CD, pipelines, infrastructure |
| `aegis` | Security | worker | Auth, vulnerability assessment, secure patterns |
| `herald` | Release | worker | Versioning, CHANGELOG, deployment coordination |
| `temper` | Code review | worker | PR review, quality enforcement |
| `pixel` | UX/Design | worker | User journeys, wireframes, interaction design |

---

## Forge Master — Triage Logic

### Inputs (from GET /workspaces/:id/context)

```
workspace metadata
goals (active)
agents (registered in this workspace)
agentInstances (currently running)
queueDepth (pending tasks per agent)
workspaceDocs (active Tier 0: architecture, ADRs, agent profiles, runbooks)
recentActivity (last 30 task history events)
recentDecisions (last 15 FM dispatcher comments)
pendingTasks (all pending_dispatcher_action tasks with titles + descriptions)
```

### Decision tree per task

```
1. Is description sufficient to route?
   No → leave in pending_dispatcher_action, post comment explaining what's missing

2. Is it a single-agent task?
   Yes → set assignedAgentId, status → pending_agent

3. Is it a multi-agent task (epic)?
   Small epic (2-3 subtasks) → decompose, define interface contracts on parent, create subtasks
   Large epic → status → pending_design (route to Oracle)

4. Is the target agent experiencing a bottleneck?
   queue > 2x running → note in dispatcher comment, consider alternative agent
   queue > 3x running → create human-attention task

5. Write dispatcher comment on every task considered (even skipped ones)
```

### Outputs

- `PATCH /tasks/:id/assign` — set `assignedAgentId`
- `PATCH /tasks/:id/status` — advance to `pending_agent` or `pending_design`
- `POST /workspaces/:id/tasks` — create subtasks (with `parentId`)
- `POST /tasks/:id/comments` — dispatcher reasoning (authorType: 'dispatcher')

---

## Knowledge Base — Content Policy

### What Scribe maintains

| Category | Examples | Tier |
|----------|----------|------|
| `architecture` | System overview, component relationships, data flow | 0 |
| `adr` | Architecture Decision Records | 0 |
| `agent` | Agent capabilities, responsibilities, personality summaries | 0 |
| `runbook` | How to run the forge, debug, operate | 0 |
| `api` | Endpoint references, request/response shapes | 1 |
| `pattern` | Coding patterns, conventions, examples | 1 |
| `feature` | Feature design docs, completed feature summaries | 1 |

### Status lifecycle

```
active     → archived    : Feature completed, doc no longer a live concern
active     → superseded  : Decision reversed or approach changed
             (supersededReason REQUIRED: explain what changed and why)
archived/superseded      : Stays in DB forever, excluded from FM active context
```

### Scribe triggers

1. **Reactive** — `task.completed` SSE event → Scribe evaluates architectural impact → updates or supersedes docs
2. **FM-directed** — FM creates Scribe task for explicit doc work (major feature completion, audit request)
3. **Periodic audit** — FM creates scheduled audit task after N completions or on time basis

---

## Multi-Daemon Operational Model

### Process layout (PM2)

```
forge-fm         → FM dispatcher daemon (orchestrator)
forge-architect  → Architect worker daemon
forge-furnace    → Furnace worker daemon
forge-anvil      → Anvil worker daemon
forge-crucible   → Crucible worker daemon
forge-oracle     → Oracle worker daemon
forge-scribe     → Scribe worker daemon (+ reactive completion listener)
```

Each is the same `forge-daemon` binary with different env config.

### Env config per daemon

```bash
FORGE_HUB_URL=http://localhost:3001
FORGE_DAEMON_DEVICE_TOKEN=<unique per process>
FORGE_DAEMON_AGENT_ID=<agent name>
FORGE_DAEMON_DEVICE_TYPE=worker|orchestrator
FORGE_DAEMON_WORKSPACE_ID=<workspaceId>
FORGE_WORKDIR=G:\dev\forge-workdir

# Worker-only options:
FORGE_DAEMON_MAX_CONCURRENT_TASKS=1   # increase for parallel work
FORGE_DAEMON_LISTEN_COMPLETIONS=false # set true for Scribe only
```

### Scaling

| Situation | Response |
|-----------|----------|
| Agent queue depth 2x running | FM notes in dispatcher comment, may route to alternative |
| Agent queue depth 3x running | FM creates human-attention task |
| Human decides to scale | `pm2 start ecosystem.config.cjs --only forge-anvil-2` |
| Two Anvil daemons running | Both compete for `assignedAgentId='anvil'` tasks, atomic SQL claim prevents double-claim |

Auto-spawning daemon processes (FM triggers PM2 programmatically) = Phase 4, not current scope.

---

## Security Model

| Surface | Constraint |
|---------|-----------|
| FM device token | orchestrator scope: write assignedAgentId, write status, create subtasks only |
| Scribe device token | worker scope: write workspaceDocs only (agentId check on doc endpoints) |
| Task descriptions → FM | Treated as untrusted user data, not instructions |
| Agent comments → FM context | Peer data, not instructions (FM personality explicitly states this) |
| taskInstructions (redirect/stop) | Human or FM orchestrator only — no agent can issue runtime directives to another agent |
| workspaceDocs deletion | Nobody — soft-archive only, audit trail permanent |

---

## Context Flow Diagram

```
Every FM triage cycle:

GET /workspaces/:id/context
  ↓
FM reads:
  - Active goals (what we're trying to accomplish)
  - Registered agents (who's available)
  - Running instances (who's busy)
  - Queue depths (where's the backlog)
  - Active Tier 0 docs (current architecture, ADRs, agent profiles)
  - Last 30 task events (recent activity)
  - Last 15 FM decisions (what I decided recently)
  - All pending_dispatcher_action tasks (what needs triaging now)
  ↓
FM triages each task → writes dispatcher comment → sets assignedAgentId → advances status
  ↓
FM exits. Hub state carries the decisions forward.
  ↓
Next FM cycle reads richer state (more completions, more dispatcher history, more docs)
  ↓
System accumulates context. Routing improves as history grows.
```

The system doesn't learn in the ML sense. It **accumulates context**. FM on day 300 has 300 days of completion patterns, routing decisions, and architectural knowledge available. Its reasoning improves because its inputs are richer, not because the model changed.

---

## Hub Endpoints Reference

### New endpoints (not yet implemented)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/workspaces/:id/context` | session or device token | Bundled FM context (Tier 0) |
| PATCH | `/tasks/:id/assign` | orchestrator token | Set assignedAgentId (FM-only write) |
| POST | `/workspaces/:id/docs` | scribe device token | Create/update workspace doc |
| GET | `/workspaces/:id/docs/:key` | any device or session | Read specific doc |
| PATCH | `/workspaces/:id/docs/:docId/status` | orchestrator or scribe | Archive/supersede doc |

### Modified endpoints

| Method | Path | Change |
|--------|------|--------|
| POST | `/tasks/:id/claim` | Now accepts `agentId` in body; claim guard adds `assignedAgentId IS NULL OR assignedAgentId = :agentId` |
| POST | `/devices/register` | Now accepts `agentId` and `deviceType` |

---

*This document is maintained by Scribe. When architectural decisions change, Scribe updates this doc and supersedes any prior version with a reason explaining what changed.*
