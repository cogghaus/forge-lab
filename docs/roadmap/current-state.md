---
date: 2026-05-27
status: Active
maintained-by: Scribe
---

# forge-lab: Current State and Gap Analysis

## 1. What This Document Covers

This document captures the implementation state of forge-lab as of session 6 (2026-05-27), enumerates all known gaps, and defines a phased implementation plan for closing them. It is the authoritative reference for what exists, what is missing, and in what order the missing pieces should be built.

---

## 2. Current Implementation Status

### 2.1 forge-hub

**Technology**: Fastify 5, SQLite via libsql + drizzle-orm  
**Test coverage**: 325 tests passing

forge-hub is the central API server. Every other package communicates through it.

#### Auth
- Cookie session auth for dashboard users (login, logout, session validation)
- Device token auth for daemon and agent processes
- Workspace membership enforcement on all workspace-scoped endpoints

#### Workspaces
- Full CRUD: create, read, update, delete
- Workspace member management: add/remove members, membership queries

#### Tasks
- Full lifecycle management across statuses: `pending_dispatcher_action`, `pending_agent`, `in_progress`, `completed`, `failed`
- Subtask support via `parentId` foreign key
- Goal linkage via `goalId`
- Agent assignment via `assignedAgentId`
- Priority field
- Comments with `authorType` discrimination: `user`, `agent`, `dispatcher`
- `PATCH /tasks/:id/assign` for FM-directed routing (orchestrator device token required)
- `POST /tasks/:id/claim` with optional `agentId` routing guard
- Reassignment timeout background job: clears stale `pending_agent` assignments older than 10 minutes, emits `task.requeued` SSE

#### Goals
- Full CRUD
- Status pipeline for goal progression

#### Agents
- Agent registration per workspace
- Performance metrics endpoint with workspace membership enforcement

#### Devices
- Device registration with `agentId` and `deviceType` (`worker` / `orchestrator`)
- Token-based auth tied to device registration

#### Workspace Docs (Knowledge Base)
- `POST /workspaces/:id/docs` — create or upsert by key
- `GET /workspaces/:id/docs/:key` — read any doc by key
- `PATCH /workspaces/:id/docs/:docId/status` — archive or supersede with required reason
- Auth guards: Scribe device or orchestrator device for writes; any authenticated device for reads

#### Context Endpoint
- `GET /workspaces/:id/context` — bundled FM context payload including workspace metadata, active goals, agent roster, queue depths, recent activity, recent dispatcher decisions, pending tasks, and active docs

#### Dispatcher Log
- `GET /workspaces/:id/dispatcher-log` — returns FM dispatcher comments across workspace tasks

#### SSE
- `GET /events` — workspace-scoped server-sent events stream
- Membership filtering: clients only receive events for workspaces they belong to
- Heartbeat to keep connections alive
- Events emitted: `task.assigned`, `task.requeued`, `task.completed`, `task.cancelled`, and task lifecycle transitions
- **Bug (immediate fix, pre-Phase A)**: `task.cancelled` is emitted by the hub SSE but is absent from `TASK_EVENTS` in `packages/forge-dash-community/src/lib/use-hub-events.ts`. The dashboard silently drops cancelled-task events. This is a code bug, not a feature gap.

---

### 2.2 forge-daemon

**Technology**: TypeScript, Node.js  
**Test coverage**: 117 tests passing

#### Worker Loop
- Polls for `pending_agent` tasks matching the daemon's configured `agentId`
- Claims tasks with atomic SQL guard (prevents double-claim)
- Spawns `ClaudeCodeRuntime` per claimed task
- Monitors done-file protocol: polls for agent output file, marks task completed on success, failed on error

#### Dispatcher Loop
- Polls for `pending_dispatcher_action` tasks every 5 seconds
- Singleton gate prevents concurrent FM spawns
- FM spawning timeout: 90-second AbortController kill
- FM process crashes clear the gate for retry on next poll

#### Scribe Reactive Mode
- Listens for `task.completed` SSE events
- Evaluates whether completion is architecturally significant
- Self-creates a doc-update task assigned to Scribe when triggered

#### Scribe Audit Mode
- `auditThreshold` counter increments on each task completion
- Creates an audit task after N completions (threshold configurable)
- Audit task routed to Scribe for knowledge base consolidation

#### ClaudeCodeRuntime
- Spawns the `claude` CLI with `--dangerously-skip-permissions` flag
- Injects workspace context and task instructions into the prompt
- Done-file protocol: agent writes output to a known path, daemon polls for it

---

### 2.3 forge-agents

**Technology**: Personality files (Markdown)  
**Test coverage**: 27 tests passing

Defined agent personalities:

| Agent | Role |
|---|---|
| forge-master | Orchestrator: triage, route, decompose |
| scribe | Knowledge keeper: doc writes, supersedes, audits |
| architect | System design and ADR authorship |
| oracle | Business analysis and requirement decomposition |
| furnace | Backend implementation (hub, daemon) |
| anvil | Frontend implementation (dash) |
| crucible | Testing and test matrix authorship |
| ember | Operational tooling (PM2, runbooks, deployment) |
| herald | Communication and summaries |
| temper | Quality review and hardening |

---

### 2.4 forge-dash-community

**Technology**: Next.js 15.5 App Router  
**Test coverage**: covered by hub integration tests; no dedicated dash unit tests

#### Auth
- Login page with credential validation against hub
- Session management: cookie propagation, logout

#### Workspaces
- Workspace list with create modal
- Workspace home: goal kanban board + task list side-by-side

#### Tasks
- Task list with status filters
- Task create modal
- Task detail view: dispatcher comments section (visually distinct), parent task link, agent output panel

#### Goals
- Goal list with create modal
- Goal detail: filtered task list showing only tasks linked to that goal

#### Knowledge Base
- `/workspaces/:id/knowledge` page
- Category tabs: Architecture, ADRs, API, Patterns, Agents, Features, Runbooks
- Doc viewer with full markdown rendering
- Status badges: active, archived, superseded
- Superseded docs show reason and link to replacement

#### Analytics
- `/workspaces/:id/analytics` — two tabs: Overview and Agent Performance
- Overview tab: aggregate workspace task counts and status breakdown (all-time)
- Agent Performance tab: per-agent metrics from hub performance endpoint
- Agent breakdown detail page at `/analytics/agents/:agentId`

#### Triage
- `/workspaces/:id/triage` — FM dispatcher log view, showing all dispatcher comments across workspace tasks

#### Live Updates
- `useHubEvents` hook wrapping the SSE connection
- All polling replaced by SSE-driven updates across task list, goal kanban, and triage views

---

### 2.5 Architecture Docs

- `docs/adr/ADR-001-forge-master-orchestrator.md` — FM design, status pipeline, authority model, backward compatibility
- `docs/adr/ADR-002-workspace-knowledge-base.md` — Scribe role, doc categories, supersede protocol
- `docs/adr/ADR-003-inter-agent-coordination.md` — inter-agent coordination via task comments
- `docs/architecture/forge-master-system.md` — FM system design detail
- `docs/roadmap/forge-master-roadmap.md` — FM development phases (Phases 1-4 complete, Phase 5 deferred)

---

## 3. Gap Analysis

The table below lists every known gap, ordered by implementation priority. Priority is driven by: immediate operational impact (daily operation gaps first), followed by visibility improvements, then security and infrastructure.

| # | Feature | Impact | Complexity | Dependencies | Design Doc |
|---|---|---|---|---|---|
| G1 | Task retry-to-FM endpoint | `PATCH /tasks/:id` supports retry to `pending_agent` directly, but there is no endpoint to reset a failed task back to `pending_dispatcher_action` to re-route via FM | S | None | [see docs/design/task-lifecycle-management.md] |
| G2 | Task cancel + retry UI controls | Cancel UI requires `pending_dispatcher_action→cancelled` added to `USER_ALLOWED_TRANSITIONS` plus `task.cancelled` in `TASK_EVENTS` (code bug, pre-Phase A). Retry-to-FM UI depends on G1 (new endpoint). | S | G1 (for retry-to-FM UI); code fixes for cancel UI | [see docs/design/task-lifecycle-management.md] |
| G3 | Task reassign (user session) | `PATCH /tasks/:id/assign` exists for orchestrator devices (FM); no user-session-accessible endpoint to change `assignedAgentId` after initial assignment | S | None | [see docs/design/task-lifecycle-management.md] |
| G4 | Task reassign UI control | No UI surface to change agent assignment on a live task | S | G3 | [see docs/design/task-lifecycle-management.md] |
| G5 | Device deregister endpoint | Decommissioned machines leave ghost device records; no cleanup path | S | None | [see docs/design/device-management.md] |
| G6 | Device deregister UI | No UI control to remove a device; G5 is a prerequisite | S | G5 | [see docs/design/device-management.md] |
| G7 | Device rename endpoint | Device display names cannot be updated after registration | S | None | [see docs/design/device-management.md] |
| G8 | Device token revoke endpoint | Compromised device tokens cannot be invalidated without dropping the device record | S | None | [see docs/design/device-management.md] |
| G9 | Device management UI | No UI surface for rename or token revoke; G7 and G8 are prerequisites | S | G7, G8 | [see docs/design/device-management.md] |
| G10 | Analytics date range filter | Overview tab is all-time only; no way to inspect a time window (e.g., last 7 days) | M | None | [see docs/design/analytics-enhancements.md] |
| G11 | Analytics status breakdown drill-through | Overview pie chart is not clickable; no filtered task list for a selected status | M | None | [see docs/design/analytics-enhancements.md] |
| G12 | Org profile editing | Workspace name and description are read-only; no hub endpoint or UI for updates | S | None | None |
| G13 | Heimdall policy engine | No authorization layer gating agent actions; FM can assign any agent, Scribe can write any doc, workers can claim any task | XL | None | [see docs/design/heimdall-policy-engine.md] |
| G14 | Production deployment validation | ClaudeCodeRuntime spawns the `claude` CLI but no integration test runs it against a real binary; done-file protocol is untested outside mocked environments | M | None | [see docs/design/production-deployment-runbook.md] |
| G15 | PM2 `ecosystem.config.cjs` in repo | File is referenced in the runbook and exists at repo root but is not tracked or standardized; per-agent env templates are missing | S | None | [see docs/runbooks/multi-daemon-setup.md] |

---

### 3.1 Gap Detail

#### G1: Task Retry-to-FM Endpoint

`PATCH /workspaces/:workspaceId/tasks/:taskId` with `status: 'pending_agent'` already exists and is permitted in `USER_ALLOWED_TRANSITIONS`, so direct retry to an agent is not a gap. What is missing is a way to reset a `failed` task back to `pending_dispatcher_action` so FM can re-evaluate routing. There is no transition from `failed` to `pending_dispatcher_action` in `USER_ALLOWED_TRANSITIONS`, and no dedicated endpoint for this reset.

User impact: failed tasks that need FM re-routing require direct database edits. Retry to a specific agent works today; retry via FM does not.

#### G2: Task Cancel + Retry UI Controls

**Cancel UI**: The cancel action uses the existing `PATCH /tasks/:id` endpoint with `status: 'cancelled'`. Two code-level fixes must land first: `pending_dispatcher_action→cancelled` must be added to `USER_ALLOWED_TRANSITIONS` (FM-queued tasks currently cannot be cancelled), and `task.cancelled` must be added to `TASK_EVENTS` in `packages/forge-dash-community/src/lib/use-hub-events.ts` (otherwise the UI does not react to the SSE event). Once those fixes are in, the cancel button can ship with no new endpoint.

**Retry-to-FM UI**: Depends on G1. Once the new endpoint exists, a retry button in task detail can call it.

Cancel should require a confirmation modal. The retry action should indicate whether the task will go to `pending_agent` (direct) or `pending_dispatcher_action` (FM re-route).

#### G3 + G4: Task Reassign (User Session)

`PATCH /tasks/:id/assign` exists and is used by FM (orchestrator device token). There is no equivalent endpoint accessible via user session auth. If FM routes incorrectly or an agent goes offline, operators have no recovery path short of cancelling and recreating the task.

A user-session-accessible reassign endpoint with a corresponding UI dropdown in task detail would close this gap. The endpoint should require workspace membership and (optionally) a workspace-admin role check, distinct from the orchestrator-device authority model in ADR-001.

#### G5 + G6: Device Deregister

Devices accumulate in the hub as machines are decommissioned. There is no `DELETE /devices/:id` or equivalent endpoint. The devices table grows unbounded, and the left rail in the dashboard shows ghost entries for offline machines that will never reconnect.

#### G7 + G8 + G9: Device Rename and Token Revoke

Device display names are set at registration and cannot be updated. Device tokens, once issued, remain valid indefinitely. A compromised token can only be neutralized by dropping the device record entirely (destroying its history). Both operations need hub endpoints and a device management panel in the dashboard settings area.

#### G10: Analytics Date Range Filter

The Overview analytics tab queries aggregate task counts with no time bounds. For active workspaces, the all-time view obscures recent trends. A date range picker (preset options: last 7 days, last 30 days, last 90 days, custom range) with hub-side filtering would make this tab operationally useful.

#### G11: Analytics Status Breakdown Drill-Through

The pie chart on the Overview tab shows status distribution but is not interactive. Clicking a slice should navigate to a filtered task list showing only tasks in that status. This requires a hub query parameter for status filtering on the task list endpoint and a client-side navigation handler.

#### G12: Org Profile Editing

Workspace name and description are read-only after creation. This is low-urgency but creates friction when a workspace needs to be renamed (e.g., a project pivots). A `PATCH /workspaces/:id` endpoint and a settings form in the dashboard closes this gap. The hub schema already supports the update; only the endpoint and UI are missing.

#### G13: Heimdall Policy Engine

ADR-001 describes a security layer (Heimdall) intended to gate agent actions based on policy rules: what FM can assign, what Scribe can write, what workers can claim. The current implementation relies entirely on device type checks (`orchestrator` vs `worker`) and hardcoded agent ID guards (`agentId='scribe'`). There is no policy language, no policy store, and no enforcement layer.

This is the largest single gap. The scope includes: a policy rule schema, a policy store in the hub DB, a policy evaluation function called on every agent-initiated write, and a management surface to view and edit policies.

Without Heimdall, a misconfigured or compromised agent device token can perform any action permitted to its device type.

#### G14: Production Deployment Validation

The `ClaudeCodeRuntime` class constructs the correct `claude` CLI invocation with `--dangerously-skip-permissions` and done-file path injection. However, every test in the daemon suite mocks the subprocess. No test has run against an actual Claude binary installation to verify that the done-file protocol (agent writes output to a known path, daemon reads it, hub is marked complete) works end-to-end.

The production deployment runbook should include a validation checklist and a scripted smoke test that can be run against a real deployment environment.

#### G15: PM2 `ecosystem.config.cjs`

The multi-daemon setup runbook references PM2 as the process manager, but the `ecosystem.config.cjs` at repo root is not standardized (per-agent configuration, watch paths, restart policies, log paths). Per-agent `.env` templates (`.env.example.fm`, `.env.example.furnace`, etc.) are also absent, requiring operators to derive the required variables from source code inspection.

---

## 4. Phased Implementation Plan

Phases are strictly sequential. Phase N+1 does not start until Phase N is complete, tested, and merged.

---

### Phase A: Task Lifecycle Management

**Goal**: Operators can cancel, retry-to-FM, and reassign tasks through the dashboard and hub API.

**Shippable increment**: All actions are available in the task detail view and are backed by tested hub endpoints. Immediate code fixes (pre-Phase A) unblock cancel UI without a new endpoint.

**Pre-Phase A code fixes (no new endpoints, immediate)**:
- Add `pending_dispatcher_action→cancelled` to `USER_ALLOWED_TRANSITIONS` in hub so FM-queued tasks can be cancelled via the existing `PATCH /tasks/:id`.
- Add `task.cancelled` to `TASK_EVENTS` in `packages/forge-dash-community/src/lib/use-hub-events.ts` so the dashboard reacts to cancelled-task SSE events.

| Item | Description | Agent | Complexity |
|---|---|---|---|
| Hub: retry-to-FM endpoint | New endpoint (or transition) to reset a `failed` task to `pending_dispatcher_action`; emits SSE `task.retried` | Furnace | S |
| Hub: user-session reassign endpoint | New endpoint to update `assignedAgentId` via user session auth; emits SSE `task.assigned` | Furnace | S |
| Tests: cancel/retry/reassign matrix | Auth guards, status transition guards (including the new `pending_dispatcher_action→cancelled`), SSE emission | Crucible | S |
| Dash: task detail action buttons | Cancel (with confirmation modal) and retry buttons in task header; cancel ships once pre-Phase A fixes land | Anvil | S |
| Dash: task reassign control | Agent selector dropdown in task detail; calls user-session reassign endpoint | Anvil | S |

**Dependencies**: Pre-Phase A code fixes must land before cancel UI ships.  
**Estimated cycles**: 4 (Furnace: 2, Crucible: 1, Anvil: 1)

---

### Phase B: Device Management

**Goal**: Operators can deregister ghost devices, rename devices, and revoke device tokens through the dashboard.

**Shippable increment**: All three device management operations are available through a device management panel in workspace settings.

| Item | Description | Agent | Complexity |
|---|---|---|---|
| Hub: `DELETE /devices/:id` | Hard-deletes device record; invalidates all tokens for that device; emits SSE `device.deregistered` | Furnace | S |
| Hub: `PATCH /devices/:id/name` | Updates device display name | Furnace | S |
| Hub: `POST /devices/:id/token/revoke` | Generates a new token for the device, invalidating the old one; returns the new token once | Furnace | S |
| Tests: device management matrix | Auth guards (device owner or workspace admin), deregister cascade, token revoke + old token rejection | Crucible | S |
| Dash: device management panel | List view with deregister and rename actions per device | Anvil | S |
| Dash: token revoke flow | Revoke button with confirmation; displays new token in a one-time modal | Anvil | S |

**Dependencies**: Phase A complete.  
**Estimated cycles**: 6 (Furnace: 3, Crucible: 2, Anvil: 1)

---

### Phase C: Analytics Enhancements

**Goal**: Analytics tab provides time-bounded views and interactive drill-through from the status chart.

**Shippable increment**: Date range filter applies to all Overview metrics; clicking a status slice navigates to a filtered task list.

| Item | Description | Agent | Complexity |
|---|---|---|---|
| Hub: date range query params | `GET /workspaces/:id/analytics?from=&to=` applied to all aggregate queries | Furnace | M |
| Hub: task list status filter | `GET /workspaces/:id/tasks?status=` already exists; verify it supports all status values cleanly | Furnace | S |
| Tests: analytics filter matrix | Date-bounded counts correct; status filter returns correct subset | Crucible | S |
| Dash: date range picker | Preset options (7d, 30d, 90d) + custom range; propagates to all Overview queries | Anvil | M |
| Dash: pie chart drill-through | Click on a status slice navigates to task list pre-filtered to that status | Anvil | S |

**Dependencies**: Phase B complete.  
**Estimated cycles**: 5 (Furnace: 2, Crucible: 1, Anvil: 2)

---

### Phase D: Org Profile Editing

**Goal**: Workspace name and description can be updated from the dashboard.

**Shippable increment**: A settings form in the workspace settings page allows name and description updates.

| Item | Description | Agent | Complexity |
|---|---|---|---|
| Hub: `PATCH /workspaces/:id` | Updates name and description; session auth required; workspace owner or admin only | Furnace | S |
| Tests: workspace update auth | Only authorized users can update; invalid inputs rejected | Crucible | S |
| Dash: workspace settings form | Name and description fields with save button in workspace settings | Anvil | S |

**Dependencies**: Phase C complete.  
**Estimated cycles**: 3 (Furnace: 1, Crucible: 1, Anvil: 1)

---

### Phase E: Production Deployment Validation

**Goal**: The done-file protocol is verified against a real Claude binary installation. Operators have a scripted smoke test they can run after deployment.

**Shippable increment**: A runbook with a validated smoke test script, and a CI job (or manual test procedure) that confirms the end-to-end done-file cycle completes successfully.

| Item | Description | Agent | Complexity |
|---|---|---|---|
| Smoke test script | Shell script that creates a task, starts a daemon, confirms task completes via hub API | Ember | M |
| Done-file protocol verification | Run against a staging environment with a real Claude binary; document any deviations found | Ember | M |
| Runbook update | Add validation checklist to `docs/runbooks/multi-daemon-setup.md` | Scribe | S |

**Dependencies**: Phase D complete.  
**Estimated cycles**: 3 (Ember: 2, Scribe: 1)

---

### Phase F: PM2 Ecosystem Config

**Goal**: The repository contains a complete, runnable PM2 configuration and per-agent environment templates.

**Shippable increment**: `ecosystem.config.cjs` is committed with one app entry per agent type, and per-agent `.env.example.*` files cover all required variables.

| Item | Description | Agent | Complexity |
|---|---|---|---|
| `ecosystem.config.cjs` | One PM2 app entry per agent: forge-master (orchestrator), furnace, anvil, crucible, ember, scribe | Ember | S |
| Per-agent env templates | `.env.example.fm`, `.env.example.furnace`, `.env.example.anvil`, etc., listing all required variables with descriptions | Ember | S |
| Runbook link | `docs/runbooks/multi-daemon-setup.md` updated to reference these files | Scribe | S |

**Dependencies**: Phase E complete (smoke test confirms the deployment shape before codifying the config).  
**Estimated cycles**: 2 (Ember: 2)

---

### Phase G: Heimdall Policy Engine

**Goal**: Agent actions are gated by a policy layer. Misconfigured or compromised agent tokens cannot exceed their authorized scope.

**Shippable increment**: A policy store in the hub, a policy evaluation function applied on all agent-initiated writes, and a management surface in the dashboard. Default policies mirror current hardcoded behavior.

This phase is large and will be broken into sub-tasks by FM at scheduling time. High-level scope:

| Item | Description | Agent | Complexity |
|---|---|---|---|
| Policy schema | `workspace_policies` table: rule type, subject (agent ID or device type), resource type, action, effect (allow/deny) | Furnace | M |
| Policy CRUD endpoints | `GET/POST/PATCH/DELETE /workspaces/:id/policies` | Furnace | M |
| Policy evaluation function | Called before every agent-initiated write; returns allow/deny with matched rule | Furnace | L |
| Policy enforcement integration | Hook evaluation into task assign, doc write, task claim, task status change | Furnace | M |
| Default policy seeding | On workspace create, seed default policies matching current device-type guards | Furnace | S |
| Tests: policy matrix | Allow/deny combinations across agent types and resource types | Crucible | L |
| Dash: policy management panel | List and edit policies in workspace settings | Anvil | M |

**Dependencies**: Phase F complete. Heimdall should be the last addition: all other gaps must be resolved first so policy rules can be authored against a stable surface area.  
**Estimated cycles**: 14 (Furnace: 7, Crucible: 4, Anvil: 3)

---

### Phase Summary

| Phase | What Ships | Cycles | Gate |
|---|---|---|---|
| A | Task cancel (code fixes), retry-to-FM endpoint, user-session reassign | ~4 | Must complete before Phase B |
| B | Device deregister, rename, token revoke | ~6 | Must complete before Phase C |
| C | Analytics date range + drill-through | ~5 | Must complete before Phase D |
| D | Org profile editing | ~3 | Must complete before Phase E |
| E | Production deployment validation | ~3 | Must complete before Phase F |
| F | PM2 ecosystem config | ~2 | Must complete before Phase G |
| G | Heimdall policy engine | ~14 | Terminal phase |
| **Total** | | **~37 cycles** | |

---

## 5. Intentionally Out of Scope

The following items are excluded from this roadmap and should not be scheduled until explicitly re-opened.

### forge-dash-pro (Retired)

The private skin (forge-dash-pro) was retired in favor of forge-dash-community as the single dashboard implementation. No further work is planned for forge-dash-pro. The community skin is the dashboard.

### forge-lab.app Public Site

The public-facing site for forge-lab.app is deferred until the private-use period is complete. No design, scaffold, or content work is scheduled.

### Phase 5 Features (Future)

From the original FM roadmap, these features are out of scope until Phases A through G are complete and the system has been running in production:

- FM auto-spawning additional daemon processes via PM2 API (process-level auto-scaling)
- Workspace cross-pollination: FM aware of patterns from other workspaces with explicit permission grants
- Long-running FM: persistent session replacing the ephemeral triage-and-exit model
- Oracle as a standing service: always-on BA agent with loaded workspace context

These features introduce significant architectural complexity (distributed coordination, session persistence, cross-workspace data access controls) that is premature until the core system is stable.

---

## 6. Reference: Test Coverage by Package

| Package | Tests Passing | Coverage Scope |
|---|---|---|
| forge-hub | 325 | Auth, workspaces, tasks, goals, agents, devices, docs, context, dispatcher log, SSE |
| forge-daemon | 117 | Worker loop, dispatcher loop, Scribe reactive, Scribe audit, ClaudeCodeRuntime (mocked) |
| forge-agents | 27 | Personality file structure and content validation |
| forge-dash-community | — | No dedicated unit tests; covered by hub integration |

---

## 7. Related Documents

- `docs/adr/ADR-001-forge-master-orchestrator.md` — FM authority model and status pipeline
- `docs/adr/ADR-002-workspace-knowledge-base.md` — Scribe role and doc lifecycle
- `docs/adr/ADR-003-inter-agent-coordination.md` — inter-agent coordination via task comments
- `docs/architecture/forge-master-system.md` — FM system design
- `docs/roadmap/forge-master-roadmap.md` — FM development phases (historical; Phases 1-4 complete)
- `docs/runbooks/multi-daemon-setup.md` — operational setup guide
