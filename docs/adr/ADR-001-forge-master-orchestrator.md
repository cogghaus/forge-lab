# ADR-001: Forge Master Orchestrator Pattern

**Status**: Accepted  
**Date**: 2026-05-25  
**Authors**: Architecture planning session — Architect, Aegis, Crucible, Ember, Herald, Oracle, Temper, Loki, Pixel, Anvil, Furnace, Scribe

---

## Context

forge-lab's daemon currently acts as a dumb dispatcher: it sees a `pending_agent` task, claims it, spawns the default agent. Zero routing intelligence. Works for one agent type on one machine. Breaks the moment you want different tasks routed to different specialists.

The existing hub schema already anticipated an orchestration layer: `tasks.status` includes `pending_dispatcher_action`, `tasks.assignedAgentId` exists as a free-text column, `tasks.parentId` supports subtask decomposition, `taskComments.authorType` includes `'dispatcher'`, and a formal `agents` table exists per workspace.

---

## Decision

Introduce the **Forge Master (FM)** as an orchestrator agent with the following design:

### Lifecycle

FM is **ephemeral per triage cycle**, not persistent. It spawns when the daemon detects `pending_dispatcher_action` tasks, triages the batch, and exits. Hub state is FM's memory — not conversation context.

FM does NOT replace the daemon. FM enriches routing, then exits. The daemon continues to own the worker loop.

### Status pipeline

```
Task created
  └─ status: 'pending_dispatcher_action'  ← FM's inbox (needs routing/decomposition)
  └─ status: 'pending_agent'              ← Fast track (already routed, daemon claims)

FM triages 'pending_dispatcher_action':
  ├─ Simple task → set assignedAgentId, status → 'pending_agent'
  ├─ Complex task → create subtasks (parentId), assign each, status → 'pending_agent'
  └─ Epic → status → 'pending_design' (Oracle/BA agents handle breakdown)

Daemon claims 'pending_agent' where:
  assignedAgentId IS NULL              (any daemon can claim — backward compat)
  OR assignedAgentId = daemon.agentId  (routed task — scoped claim)

Specialist runs → writes done file → hub marks 'completed'
```

### FM's authority

FM can:
- Read all workspace context (tasks, goals, agents, docs, history)
- Set `tasks.assignedAgentId` via `PATCH /tasks/:id/assign`
- Change task status (`pending_dispatcher_action` → `pending_agent` or `pending_design`)
- Create subtasks (`POST /workspaces/:id/tasks` with `parentId`)
- Write dispatcher comments (`POST /tasks/:id/comments`, `authorType: 'dispatcher'`)

FM cannot:
- Claim tasks
- Complete tasks
- Delete tasks
- Write `taskInstructions` (redirect/stop) — human-only

### FM context

FM reads a single bundled endpoint `GET /workspaces/:id/context` before triaging. This returns active workspace state only (Tier 0). FM reasons from current state, not cached memory.

FM writes a dispatcher comment on **every task it considers**, including ones it passes over, explaining its reasoning.

### Backward compatibility

Daemons without `defaultAgentId` configured send `agentId=null` on claim requests. The claim guard `assignedAgentId IS NULL OR assignedAgentId = :agentId` correctly allows null-agentId daemons to claim any unassigned task. Existing setups require zero changes.

---

## Consequences

**What becomes easier:**
- Tasks described in plain language route to the right specialist automatically
- Epic-level tasks decompose into parallel subtasks with interface contracts defined upfront
- FM's reasoning is auditable (dispatcher comments)
- System handles multi-agent setups without manual `assignedAgentId` tagging

**What becomes harder:**
- FM adds latency between task creation and specialist start (one triage cycle)
- FM is in a soft critical path — if FM fails, `pending_dispatcher_action` tasks stall (mitigated: reassignment timeout background job clears stale assignments after 10 minutes)
- FM spawning requires a second daemon mode (`orchestrator` vs `worker`)

**Alternatives rejected:**
- Persistent FM (vibe-forge stop-hook model) — forge-lab uses `--print` mode; hub state replaces session memory adequately
- Keyword-based routing config — insufficient for ambiguous tasks and decomposition
- Distributed self-selection (agents bid on tasks) — coordination overhead, replaces elegant atomic SQL claim with consensus protocol

---

## Related decisions

- ADR-002: Workspace Knowledge Base (Scribe + workspaceDocs)
- ADR-003: Inter-agent coordination via task comments
- ADR-004: Context tiering model for FM
