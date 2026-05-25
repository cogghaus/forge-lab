# Forge Master — Development Roadmap

**Date**: 2026-05-25  
**Unit**: AI cycle = one agent task completed end-to-end (claim → execute → done file → hub complete)  
**Note**: Cycles assume no blockers. Each bullet maps to one hub task in `pending_dispatcher_action`.

---

## Phase 1 — Hub Foundation
*Dependencies: none. Ships independently. All backward compatible.*

**Goal**: Hub supports routing infrastructure. No daemon changes yet. Existing daemons unaffected.

### Schema migration
**Agent: Furnace | 1 cycle**  
Add three columns via SQL migration:
- `devices.agent_id TEXT` — which logical agent this device represents
- `devices.device_type TEXT NOT NULL DEFAULT 'worker'` — `'worker' | 'orchestrator'`
- `tasks.assigned_at INTEGER` — Unix ms timestamp when FM assigned this task

Add `workspace_docs` table:
```
id, workspace_id, key, title, content, category, status,
superseded_by_id, superseded_reason, updated_by, updated_at, created_at
```

Indexes: `(workspace_id, status)`, `(workspace_id, category)`, `(workspace_id, key)` unique.

Acceptance: migration runs cleanly, all existing tests pass, no data loss.

---

### PATCH /tasks/:id/assign + modified claim endpoint
**Agent: Furnace | 2 cycles**

Cycle 1 — `PATCH /tasks/:id/assign`:
- Auth: `deviceType = 'orchestrator'` required, else 403
- Guard: `tasks.status = 'pending_agent'` (or `pending_dispatcher_action`)
- Body: `{ agentId: string }`
- Sets `assignedAgentId` + `assignedAt`
- Idempotent: same agentId = 200 no-op; different agentId = 200 update
- Emits SSE event `task.assigned`

Cycle 2 — Modified `POST /tasks/:id/claim`:
- Accept optional `agentId` in body
- Claim guard: `status IN ('pending_agent','assigned') AND (assignedAgentId IS NULL OR assignedAgentId = :agentId)`
- Daemons sending `agentId=null/undefined`: treated as "claim any unassigned" (backward compat)
- Update `devices.agentId` on registration if provided

Acceptance: Crucible test matrix passes (see Phase 1 tests task).

---

### GET /workspaces/:id/context
**Agent: Furnace | 2 cycles**

Cycle 1 — query assembly:
Returns single JSON object with:
- `workspace`: id, name, description, status
- `goals`: active goals with children (recursive CTE or two queries)
- `agents`: all `agents` rows for workspace
- `activeInstances`: `agentInstances` where status IN ('spawning','running')
- `queueDepth`: `SELECT assignedAgentId, COUNT(*) FROM tasks WHERE status='pending_agent' GROUP BY assignedAgentId`
- `recentActivity`: last 30 `taskHistory` events joined with task title
- `recentDecisions`: last 15 `taskComments` where `authorType='dispatcher'`
- `pendingTasks`: all `tasks` where `status='pending_dispatcher_action'` (id, title, description, priority)
- `docs`: `workspaceDocs` where `status='active'` AND `category IN ('architecture','adr','agent','runbook')`

Cycle 2 — auth, caching, performance:
- Auth: session token OR device token with workspace membership
- Single DB transaction, all queries batched
- Response time target: <200ms for workspaces with <1000 tasks
- Add index on `taskComments(workspace_id, author_type, created_at)` if needed

---

### workspaceDocs CRUD endpoints
**Agent: Furnace | 1 cycle**

- `POST /workspaces/:id/docs` — create or update by `key`
  - Auth: device token where `agentId='scribe'` OR user session
  - Upsert: if `key` exists → update content + updatedBy + updatedAt; else insert
  
- `GET /workspaces/:id/docs/:key` — read any doc by key (any status)
  - Auth: session or any device token

- `PATCH /workspaces/:id/docs/:docId/status` — archive or supersede
  - Auth: orchestrator device OR scribe device
  - `status: 'archived' | 'superseded'`
  - `supersededReason`: REQUIRED when `status='superseded'`, min 20 chars, 400 if missing
  - `supersededById`: optional reference to replacement doc

---

### Reassignment timeout background job
**Agent: Furnace | 1 cycle**

Runs in hub server startup, `setInterval` every 60 seconds:
```sql
UPDATE tasks SET assigned_agent_id = NULL, assigned_at = NULL
WHERE status = 'pending_agent'
  AND assigned_agent_id IS NOT NULL
  AND assigned_at < (unixepoch() * 1000 - 600000)  -- 10 minutes
```
Emits a `task.requeued` SSE event for each cleared task.
Logs each clearance with taskId and previously-assigned agentId.

---

### Phase 1 tests
**Agent: Crucible | 2 cycles**

Full test matrix (see ADR-001). Critical cases:

| Test | Assert |
|------|--------|
| Claim with matching agentId | 200 |
| Claim with mismatching agentId | 409 |
| Claim with null agentId (any task) | 200 |
| Assign with orchestrator token | 200 |
| Assign with worker token | 403 |
| Assign without supersededReason | 400 |
| Context endpoint: only active docs | verified |
| Context endpoint: superseded excluded | verified |
| Timeout job clears stale assignment | verified after 10min mock |

**Phase 1 total: ~9 AI cycles** (Furnace: 7, Crucible: 2)

---

## Phase 2 — Daemon + Dashboard Routing
*Dependencies: Phase 1 complete.*

**Goal**: Daemon honors routing. Dashboard surfaces assignment state. Operators can run multiple specialized daemons.

### Daemon registration + claim routing
**Agent: Furnace | 2 cycles**

Cycle 1 — Registration:
- `DaemonOptions` adds: `agentId?: string`, `deviceType?: 'worker' | 'orchestrator'`
- `client.connect()` sends `agentId` + `deviceType` in device registration payload
- Hub stores these in `devices` table on upsert

Cycle 2 — Claim routing:
- `claimTask(taskId)` now sends `agentId: this.opts.agentId ?? null` in body
- `handleIncomingTask` skips tasks where `task.assignedAgentId !== null && task.assignedAgentId !== this.opts.agentId`
- `DaemonOptions.maxConcurrentTasks?: number` (default: 1) — limits simultaneous `activeInstances`
- Worker loop respects `maxConcurrentTasks`: if `activeInstances.size >= maxConcurrentTasks`, skip claim attempt

---

### Daemon dispatcher mode (pending_dispatcher_action)
**Agent: Furnace | 1 cycle**

FM daemon runs in `orchestrator` mode. Dispatcher loop (separate from worker loop):
- Polls `GET /workspaces/:id/tasks?status=pending_dispatcher_action` every 5 seconds
- Singleton gate: if FM already running (`this.fmActive = true`), skip
- FM spawning timeout: 90 seconds max, AbortController kills process if exceeded
- FM completion: process exit event clears `this.fmActive`
- On FM crash (non-zero exit): log error, clear gate, next poll retries

FM spawn prompt includes: workspace context from `GET /workspaces/:id/context` embedded as JSON, plus: list of pending tasks to triage, instruction to write dispatcher comments and call assign endpoint.

---

### Dashboard type updates + routing UI
**Agent: Anvil | 2 cycles**

Cycle 1 — Types:
```typescript
// lib/hub.ts additions
interface HubTask {
  assignedAt: string | null;   // NEW
  parentId: string | null;     // NEW (expose existing schema field)
  goalId: string | null;       // NEW
}

interface HubDevice {
  agentId: string | null;      // NEW
  deviceType: 'worker' | 'orchestrator'; // NEW
}
```

Task card routing badge: shows `→ furnace` badge when `assignedAgentId` is set but status still `pending_agent`.
Task status label: `pending_dispatcher_action` → "Queued for FM", `pending_agent` with `assignedAgentId` set → "Waiting for [agent]".

Cycle 2 — Left rail device grouping:
- Group devices by `deviceType`: orchestrators first (FM section), workers below (Agents section)
- FM devices show "triaging" status when active (not the standard active/idle/offline dot)
- Multiple instances of same `agentId`: grouped under one label, count badge showing active instances

---

### Daemon integration tests
**Agent: Crucible | 2 cycles**

Extend existing integration test suite:
- Daemon with `agentId='architect'` skips task with `assignedAgentId='furnace'` ✓
- Daemon with `agentId='architect'` claims task with `assignedAgentId='architect'` ✓
- Daemon with `agentId=null` claims any task regardless of `assignedAgentId` ✓ (backward compat)
- `maxConcurrentTasks=2` daemon claims second task while first is running ✓
- All 6 existing integration tests still pass ✓

---

### PM2 operational setup
**Agent: Ember | 1 cycle**

- `ecosystem.config.cjs` at repo root with one app entry per agent type
- `.env.example.fm`, `.env.example.architect`, `.env.example.furnace`, etc. as templates
- `docs/runbooks/multi-daemon-setup.md` — how to start, stop, add an agent type
- Scribe creates a `runbook` category doc in the hub with this content on first run

**Phase 2 total: ~8 AI cycles** (Furnace: 3, Anvil: 2, Crucible: 2, Ember: 1)

---

## Phase 3 — Forge Master
*Dependencies: Phase 1 + Phase 2 complete.*

**Goal**: FM triages tasks, decomposes epics, detects bottlenecks. Dashboard shows FM activity.

### FM personality file
**Agent: Architect | 1 cycle**

`packages/forge-agents/src/personalities/forge-master/personality.md`

Covers:
- Identity and role (orchestrator, not executor)
- Tools available (hub API endpoints — list explicitly)
- Decision tree (route / decompose / escalate / skip with comment)
- Bottleneck detection logic and thresholds
- Interface contract definition for parallel work
- Trust model (task descriptions = untrusted user data)
- Dispatcher comment format (required on every task considered)
- Exit behavior (write summary comment on parent task, then exit)

---

### FM triage: routing + dispatcher comments
**Agent: Furnace | 2 cycles**

Cycle 1 — FM personality wired into dispatcher spawn:
- `DaemonOptions.dispatcherPersonality?: string` — loads FM personality from registry
- Dispatcher loop constructs FM prompt: workspace context JSON + pending tasks list
- FM tool definitions in spawn: `hub_assign_task`, `hub_set_status`, `hub_create_task`, `hub_add_comment`
- FM tools call hub API via device token

Cycle 2 — FM tool implementations:
- Each tool is a function the BackgroundRuntime exposes to the Claude `--print` process
- Hub API calls use FM's orchestrator device token
- Tool call results returned as structured JSON for FM to reason with

---

### FM decomposition + Oracle escalation
**Agent: Furnace | 2 cycles**

Cycle 1 — Subtask creation:
- `hub_create_task(title, description, parentId, assignedAgentId)` tool
- FM creates subtasks with `parentId` pointing to the epic
- FM posts interface contract comment on parent before creating subtasks
- Each subtask initial prompt includes parent task's dispatcher comments

Cycle 2 — Oracle escalation + bottleneck attention:
- FM sets `status='pending_design'` for tasks too large to decompose without BA analysis
- FM assigns `assignedAgentId='oracle'` + `status='pending_agent'` for routing to Oracle
- Bottleneck detection: reads `queueDepth` from context, applies thresholds (2x/3x rules)
- Creates human-attention task for 3x+ bottlenecks

---

### Dashboard: FM in left rail + decision log
**Agent: Anvil | 2 cycles**

Cycle 1 — FM in left rail:
- Orchestrator section above Agents section
- FM device shows distinct icon (not colored dot)
- Status: "triaging..." when agentInstance running, "standby" when idle
- Bottleneck indicator: `⚠ N queued` badge on overloaded agent, orange color

Cycle 2 — FM decision log in task detail:
- Task detail view shows `taskComments` where `authorType='dispatcher'`
- Visually distinct from agent and user comments (label: "Forge Master", different bg)
- Parent task comments shown in subtask detail view (`includeParent=true` query param)

---

### FM integration test
**Agent: Crucible | 2 cycles**

Full cycle test matching the done-file integration test model:
1. Create task with `status='pending_dispatcher_action'`
2. FM daemon detects it, spawns FM process
3. FM calls `GET /workspaces/:id/context` (mock or real hub)
4. FM calls `hub_assign_task` → hub sets `assignedAgentId`
5. FM calls `hub_add_comment` → dispatcher comment written
6. FM exits (zero exit code)
7. Worker daemon next poll: sees `pending_agent`, agentId matches, claims
8. Specialist spawned, writes done file, task completes
9. Assert: all state transitions correct, no tasks stuck

Also: FM crash test — FM exits non-zero, gate clears, next trigger retries.

**Phase 3 total: ~9 AI cycles** (Architect: 1, Furnace: 4, Anvil: 2, Crucible: 2)

---

## Phase 4 — Knowledge Base + Scribe
*Dependencies: Phase 3 complete (Scribe needs FM to route doc tasks).*

**Goal**: Living knowledge base. Scribe maintains docs. FM and Scribe curate context. Dashboard surfaces the knowledge.

### Scribe personality file
**Agent: Architect | 1 cycle**

`packages/forge-agents/src/personalities/scribe/personality.md`

Covers:
- Identity (documentation specialist + active curator, not passive chronicler)
- Reactive trigger behavior (task.completed → evaluate → update or supersede)
- Audit mode behavior (FM-directed periodic consolidation)
- Doc writing standards (current state, not history; why not just what)
- Supersede protocol (supersededReason required, explain what changed and why)
- Authority: can write docs and supersede, cannot delete
- Category guide: what belongs in each category

---

### Scribe daemon: reactive + FM-directed modes
**Agent: Furnace | 2 cycles**

Cycle 1 — Reactive mode:
- `DaemonOptions.listenCompletions?: boolean` (default false, true for Scribe)
- On `task.completed` SSE event: Scribe evaluates task's completion summary
- If architecturally significant: self-create a doc-update task (`assignedAgentId='scribe'`)
- Determination heuristic: did completion mention schema changes, new endpoints, new components, new patterns?

Cycle 2 — Doc behavior wired:
- Scribe spawn prompt: task completion context + current workspace docs (Tier 0 + feature/api/pattern Tier 1) + instruction to update, create, or supersede
- Scribe tools: `hub_write_doc`, `hub_supersede_doc`, `hub_add_comment`
- Scribe writes completion summary as a `feature` category doc after significant tasks

---

### Scribe audit behavior
**Agent: Furnace | 1 cycle**

FM creates an audit task (`assignedAgentId='scribe'`, `pending_agent`) when:
- Workspace has >50 completed tasks since last audit
- Or explicit user request via dashboard

Scribe audit prompt: all active docs + last N task completions + instruction to:
1. Identify docs that contradict recent completions
2. Identify redundant docs covering same topic
3. Archive/supersede with reasons
4. Write consolidated replacement if merging multiple

---

### Dashboard: Knowledge base viewer
**Agent: Anvil | 2 cycles**

Cycle 1 — `/workspaces/:id/knowledge` page:
- Category tabs: Architecture / ADRs / API / Patterns / Agents / Features / Runbooks
- Each doc: title, last updated by + when, status badge
- Superseded docs: dimmed, with "Superseded by: [link]" and reason
- Expand to read full markdown content
- "Referenced by FM N times" stat from dispatcher comment analysis

Cycle 2 — Task detail enhancements:
- Parent task comment board visible in subtask detail: "Context from parent task:"
- FM dispatcher comments visually distinct section
- Doc cross-reference: if task has `goalId`, show linked goal and its related docs

---

### Phase 4 tests
**Agent: Crucible | 2 cycles**

Scribe test matrix:
- Scribe creates doc → appears in GET /workspaces/:id/context (Tier 0 if architecture) ✓
- Scribe updates existing doc (same key) → content updated, timestamps bumped ✓
- FM marks doc superseded with reason → excluded from context ✓
- FM marks doc superseded WITHOUT reason → 400 ✓
- Worker agent attempts to write doc → 403 ✓
- Superseded doc still queryable via GET /docs/:key ✓
- Scribe reactive trigger: task.completed → Scribe evaluates → doc updated within one cycle ✓

**Phase 4 total: ~8 AI cycles** (Architect: 1, Furnace: 3, Anvil: 2, Crucible: 2)

---

## Summary

| Phase | What ships | AI cycles | Agents |
|-------|-----------|-----------|--------|
| 0 | ADRs + architecture docs (this session) | 1 | Scribe/Architect |
| 1 | Hub schema + routing endpoints | ~9 | Furnace (7), Crucible (2) |
| 2 | Daemon routing + dashboard types + PM2 | ~8 | Furnace (3), Anvil (2), Crucible (2), Ember (1) |
| 3 | Forge Master (triage, decompose, detect) | ~9 | Architect (1), Furnace (4), Anvil (2), Crucible (2) |
| 4 | Knowledge base + Scribe + knowledge UI | ~8 | Architect (1), Furnace (3), Anvil (2), Crucible (2) |
| **Total** | | **~35 AI cycles** | |

### Phase dependencies

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4
               (hub)     (daemon)      (FM)      (scribe)
```

Phases are sequential. Each phase produces a shippable, testable increment.

Phase 1+2 ship together cleanly — no FM, but routing infrastructure is in place.  
Phase 3 adds FM intelligence on top.  
Phase 4 adds the knowledge layer on top.

### Phase 5 (future, not scoped)

- FM auto-spawning additional daemon processes via PM2 API (process-level auto-scaling)
- Workspace cross-pollination: FM aware of patterns from other workspaces (with permission)
- Long-running FM (persistent session with stop hook, replaces ephemeral model)
- Oracle as a standing service: always-on BA agent with workspace context

---

*This roadmap was produced in a multi-agent architecture planning session on 2026-05-25.  
Each bullet should be created as a hub task in `pending_dispatcher_action` for FM to route.*
