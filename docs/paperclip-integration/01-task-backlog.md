# forge-lab Task Backlog: Paperclip Integration (v2)

Validated against forge-lab @ master 2026-05-13. Phases renumbered to match Phase 2 reality (forge-lab is in Phase 2 transition, not greenfield).

---

## Phase 2.0: Multi-Tenancy Foundation (BLOCKING for Pam)

- [ ] **P2.0.1** Workspaces + workspace_members tables (M, 8/10)
  - Migration `0001_workspaces.sql`
  - Drizzle schemas in `@forge-lab/core`
  - Zod types in `packages/forge-core/src/types/workspace.ts`
  - Roles: owner, admin, collaborator, viewer
- [ ] **P2.0.2** Scope existing tables to workspace (M, 7/10)
  - Add `workspace_id` to tasks, agents, agent_instances, task_comments, task_history, task_instructions
  - Backfill via "Default Workspace" owned by first admin
  - NOT NULL constraint via table-swap migration (SQLite limitation)
- [ ] **P2.0.3** Workspace-aware auth middleware (M, 8/10)
  - `requireWorkspaceMember(role?)` preHandler
  - Routes accept `:workspaceId` path param
  - 401 unauth, 403 not-a-member, 403 insufficient-role
- [ ] **P2.0.4** Admin-initiated invites (S, 8/10)
  - `invites` table with token_hash, expires_at, optional workspace_id and role
  - `POST /admin/invites`, `GET /invites/:token`, `POST /invites/:token/accept`
  - Returns invite link in API response (no SMTP for v1)

## Phase 2.1: Foundation Primitives

- [ ] **P2.1.1** Atomic task claim - fix TOCTOU (S, 9/10)
  - Single `UPDATE ... WHERE ... RETURNING` statement
  - Accept `X-Forge-Run-Id` header
  - Body adds `expectedStatuses` array
  - Tests: concurrent claims, exactly-one-wins
- [ ] **P2.1.2** Generalize task_history to entity_history (M, 7/10)
  - Add `entity_type`, `entity_id` columns
  - Backfill existing rows as entity_type='task'
  - Update all logging sites
- [ ] **P2.1.3** Goals table + task ancestry (S, 9/10)
  - `goals` table workspace-scoped
  - Add `parent_id`, `goal_id` to tasks
  - Cycle prevention check
  - Recursive CTE for ancestors
- [ ] **P2.1.4** X-Forge-Run-Id header middleware (XS, 9/10)
  - Fastify hook attaches runId to request
  - Mutating routes log runId to entity_history

## Phase 2.2: Heartbeat Execution Model

- [ ] **P2.2.1** Heartbeat protocol spec doc (M, 7/10)
  - Adapt Paperclip's protocol to daemon-orchestrated model
  - Wake reasons: timer, assignment, mention, manual, approval_resolution
  - Daemon IS the agent from hub's POV
- [ ] **P2.2.2** Wakeup queue table + EventBus integration (M, 8/10)
  - Coalescing on enqueue
  - `wakeup.created` events via existing EventBus
  - Daemon subscribes via WebSocket
- [ ] **P2.2.3** Runs table (S, 9/10)
  - Distinct from agent_instances
  - FK to wakeup_id, agent_instance_id
  - stdout/stderr paths to disk logs
- [ ] **P2.2.4** Cost events + vibe-pulse integration (M, 8/10)
  - `cost_events` table workspace-scoped
  - `POST /workspaces/:id/cost-events` endpoint
  - vibe-pulse posts directly (Option B from plan)
- [ ] **P2.2.5** Extend AgentRuntime interface (M, 7/10)
  - Optional `resumeSession()`, `reportCosts()`, `testEnvironment()`
  - MockRuntime doesn't need them
  - ClaudeCodeRuntime implements all three

## Phase 2.3: Governance and Budget

- [ ] **P2.3.1** Budgets + auto-pause (M, 9/10)
  - Per-agent and per-workspace `budget_monthly_cents`
  - Background timer aggregates cost_events
  - 80% soft warning via prompt injection
  - 100% auto-pause with `pause_reason = 'budget_exhausted'`
- [ ] **P2.3.2** Approvals (M, 8/10)
  - `approvals` table workspace-scoped
  - Types to start: `hire_agent`, `execute_strategy`
  - Approve/reject/request-revision endpoints
  - Resolution fires wakeup for requesting agent
- [ ] **P2.3.3** Agent lifecycle endpoints (S, 9/10)
  - Add `paused`, `terminated` to agents (not agent_instances)
  - `POST /agents/:id/pause`, `/resume`, `/terminate`
  - Lifecycle vs runtime status separation

## Phase 2.4: Polish

- [ ] **P2.4.1** Org chart - agents.reports_to (XS, 9/10)
- [ ] **P2.4.2** Routines + triggers (M, 8/10)
- [ ] **P2.4.3** Skill discovery via hub (S, 8/10)
- [ ] **P2.4.4** Forge template export/import (L, 7/10) - DEFER

---

## Open Questions (resolve as work proceeds)

- [ ] **Q1** Fresh start or backfill existing dev data into "Default Workspace"?
- [ ] **Q2** Pam needs device tokens or just user sessions?
- [ ] **Q3** `runtime_configs` stays user-scoped or moves to workspace-scoped?
- [ ] **Q4** New lifecycle fields (`budget_monthly_cents`, `reports_to`) as columns or in `agents.config` JSON? (Recommend columns)
- [ ] **Q5** Docker compose stack as part of P2.0 or later?

---

## Suggested Order

P2.0.1 → P2.0.2 → P2.0.3 → P2.1.1 → P2.0.4 → P2.1.4 → P2.1.3 → P2.1.2

That sequence gets you tenancy + the atomic claim fix + invites + goals working without needing the heartbeat model. Stop there. Use it for two weeks. Then decide if P2.2 is worth the time, or if forge-lab + tenancy + Paperclip-style atomic claim is enough for a long while.
