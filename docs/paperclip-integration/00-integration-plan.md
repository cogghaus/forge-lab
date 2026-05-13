# Paperclip Integration Plan for forge-lab (v2)

**Author:** Adam (with Claude)
**Date:** 2026-05-13
**Status:** Draft v2, validated against forge-lab @ master 2026-05-13
**Supersedes:** v1 (which was written from memory; this version reads the actual repo)

---

## What Changed From v1

v1 was built from memory context and made several wrong assumptions. v2 reads the actual code at `sugar-crash-studios/forge-lab` and corrects them. Major corrections:

| v1 assumption | v2 reality |
|---|---|
| forge-lab is greenfield | Phase 1 complete, 28 tests green, Phase 2 starting |
| Need to add an "Adapter" interface | `AgentRuntime` interface in `@forge-lab/core` already does this |
| Need a new "activity log" table | `task_history` is the activity log; generalize it |
| Add `executionPolicy`, simple task status | Task status enum is dispatcher-workflow-specific; preserve it, layer Paperclip concepts on top |
| Add Better Auth | bcryptjs + cookie sessions + admin/user roles are in place |
| Multi-user is a future need | Multi-user works; **multi-tenancy** (workspace scoping) is the actual gap |
| Need new claim endpoint | Existing `/tasks/:id/claim` has a TOCTOU race to fix |
| forge-dash is the dashboard | `forge-dash-pro` is a separate private repo with Magic UI Pro; `forge-dash-community` will live inside this monorepo. Public packages cannot include Magic UI Pro. |
| Anvil, Furnace, Forge Master | Real personas: Planning Hub, Architect, Aegis, Ember, Pixel, Oracle, Crucible, Loki |
| Use drizzle-kit for migrations | Hand-written SQL migrations in `db/migrate.ts`; drizzle-kit comes Phase 2 |

---

## 1. Hard Constraints (from `context/architecture.md`)

These are not negotiable. Every proposal must respect them.

- No emdashes in any output
- No `any` types (use `unknown` and narrow)
- No `better-sqlite3` (project standard is `@libsql/client` + `drizzle-orm/libsql`)
- No `console.log` in production code paths (use injected loggers)
- No `Content-Type: application/json` on bodyless requests (Fastify 5 rejects)
- No Magic UI Pro in public packages
- No tsconfig relaxation (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` stay on)
- No secrets in env vars (use Docker secrets and `_FILE` env pattern)
- No PID-based liveness polling (use file-based markers)
- Every bug fix ships with a failing-first test
- Zod schemas at every external boundary, types inferred via `z.infer`
- Dependency injection via constructor options
- Hub is source of truth; daemon talks to hub via HTTP and WebSocket only
- File-based coordination between daemon and agents (`.forge/tasks/<id>.md` + `.forge/tasks/<id>.done`)
- AgentRuntime interface is the runtime abstraction; runtimes are injected, not imported globally

---

## 2. The Multi-Tenancy Problem (NEW P0)

This wasn't in v1 because v1 didn't know forge-lab already had multi-user auth. The real gap is multi-tenancy.

**Current state:**
- `users` exists, with `role` enum `['admin', 'user']`
- `sessions` exists, cookie-based
- `devices` is scoped to `userId`
- `runtime_configs` is scoped to `userId`
- `tasks`, `agents`, `agent_instances` are **globally scoped**

**Pam's requirement:** Pam has her own "companies" and projects; some she shares with Adam, some she doesn't.

**Proposed model:** Introduce `workspaces` as the tenancy unit. A workspace has an owner (`userId`) and zero or more members. Tasks, agents, goals, approvals, runs, cost_events, and approvals all FK to a workspace. Authorization checks gate access by workspace membership.

```
users  (1) --< (N)  workspace_members  (N) >-- (1)  workspaces
                                                       |
                                                       +-- tasks
                                                       +-- agents
                                                       +-- goals
                                                       +-- approvals
                                                       +-- runs
                                                       +-- cost_events
                                                       +-- routines
```

`workspace_members.role` enum: `['owner', 'admin', 'collaborator', 'viewer']`. Admin board users in the system-wide sense (`users.role = 'admin'`) can see all workspaces; that's a separate axis.

**Registration:** The "first account is admin, subsequent registrations disabled" rule stays. For Pam onboarding, add an admin-initiated invite mechanism:

```
POST /admin/invites  { email, asWorkspaceId?, asRole? }
```

Invites generate a one-time signup token. Pam uses it once to create her user. From there she creates her own workspaces.

**Migration risk:** Existing tasks and agents would need a default workspace assigned. For a clean slate (Phase 2 transition), this is easy. If real data exists, write a backfill migration that creates a "Default" workspace owned by the admin and assigns everything to it.

---

## 3. Concept Mapping (Corrected)

| Paperclip | forge-lab (existing or proposed) | Notes |
|---|---|---|
| Company | Workspace (NEW, see §2) | Not "company"; the name matters. |
| Agent | `agents` table (NEEDS workspace scoping) | Already exists with personality + runtime. |
| Adapter | `AgentRuntime` (EXISTS in `@forge-lab/core/runtime/agent-runtime.ts`) | Lift Paperclip's `execute()` lifecycle and cost reporting into this interface. |
| Issue | `tasks` table | Already exists with rich status enum. Don't replace. |
| Heartbeat | NEW (see §5) | The daemon's worker loop is the natural home for this. |
| Skill | NEW (formalize SKILL.md discovery) | Adam already uses SKILL.md (`surgical-edits`, `goal-driven-execution`). |
| AGENTS.md | Personality strings in `agents.personality` today | Could formalize to repo-native YAML+markdown later. |
| Approval | NEW | High value for `hire_agent`, `execute_strategy`. |
| Goal | NEW | Top-level objective tasks trace back to. |
| Execution policy | NEW (defer) | Review/approval stages on tasks. |
| Activity log | `task_history` table (generalize) | Add `entity_type`, `entity_id` columns so it can log non-task events. |
| Cost tracking | NEW (`cost_events`) + integration with vibe-pulse | OTLP collector emits to hub. |
| Routine | NEW | Scheduled task fires. Cron + webhook + API triggers. |
| Run record | NEW (`runs` table) | Distinct from `agent_instances`; ties costs and outputs to a single heartbeat. |
| Companies spec (markdown package) | NEW (defer) | Forge templates for Pam to clone. |
| Org chart | `agents.reportsTo` (NEW column) | Not in current schema. |

---

## 4. Phased Plan (Corrected)

### Phase 2.0: Multi-Tenancy Foundation

This blocks everything else once Pam is involved. Estimate: 2 weeks evenings.

#### P2.0.1: Workspaces table + membership
**Confidence: 8/10. Effort: M.**

Hand-written migration `0001_workspaces.sql` appended to `MIGRATIONS` in `packages/forge-hub/src/db/migrate.ts`:

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'active',
  budget_monthly_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX workspaces_owner_idx ON workspaces(owner_user_id);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  joined_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);
```

Add corresponding Drizzle schemas in `packages/forge-core/src/schema/db.ts`. Zod schemas in `packages/forge-core/src/types/workspace.ts`.

**Needs to be true:** The migration runs cleanly against existing dev databases (empty tasks/agents tables in fresh checkouts), and the backfill story is documented.

#### P2.0.2: Scope existing tables to workspace
**Confidence: 7/10. Effort: M.**

Add `workspace_id` column to `tasks`, `agents`, `agent_instances`, `task_comments`, `task_history`, `task_instructions`. Migration includes:

1. Add column `workspace_id TEXT REFERENCES workspaces(id)`
2. Backfill: for existing data, create a "Default Workspace" owned by the first admin, set everyone's workspace_id to it
3. Add `NOT NULL` constraint via a recreate-table migration (SQLite limitation)
4. Add indexes: `tasks_workspace_idx`, `agents_workspace_idx`, `agent_instances_workspace_idx`

**Risk:** Schema migrations on existing data. SQLite's `ALTER TABLE ADD COLUMN` doesn't enforce NOT NULL with a default until you do a table swap. The pattern: add nullable, backfill, then table-swap to add NOT NULL. Test the backfill against a snapshot of the dev DB before running on Adam's machine.

#### P2.0.3: Workspace-aware auth middleware
**Confidence: 8/10. Effort: M.**

Extend `populateAuth` and add a `requireWorkspace(workspaceId)` preHandler. Every workspace-scoped route accepts `:workspaceId` in the path and verifies the authenticated user is a member.

```typescript
// packages/forge-hub/src/auth/middleware.ts
export function requireWorkspaceMember(role?: WorkspaceRole) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const { workspaceId } = req.params as { workspaceId?: string };
    if (!workspaceId) return reply.code(400).send({ error: 'workspace_required' });
    if (!req.authUser) return reply.code(401).send({ error: 'unauthorized' });

    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, req.authUser.id),
      ),
    });
    if (!membership) return reply.code(403).send({ error: 'not_a_member' });
    if (role && !rankAtLeast(membership.role, role)) {
      return reply.code(403).send({ error: 'insufficient_role' });
    }
    (req as any).workspace = { id: workspaceId, role: membership.role };
  };
}
```

#### P2.0.4: Admin-initiated user invites
**Confidence: 8/10. Effort: S.**

```sql
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  invited_by_user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT REFERENCES workspaces(id),
  workspace_role TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  consumed_by_user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
```

Routes: `POST /admin/invites` (admin only), `GET /invites/:token` (public, view-only), `POST /invites/:token/accept` (creates user + adds to workspace if specified).

Email delivery is out of scope for v1; print the invite link to logs (or return it from the API for admin to copy). Pam gets a link, clicks, signs up. No SMTP needed.

---

### Phase 2.1: Foundation Primitives

After tenancy is solid. Estimate: 1-2 weeks.

#### P2.1.1: Atomic task claim (fix the TOCTOU)
**Confidence: 9/10. Effort: S.**

The current `/tasks/:id/claim` does:
```typescript
const task = await db.select()...where(eq(schema.tasks.id, id)).get();  // READ
if (task.status !== 'pending_agent' && task.status !== 'assigned') { 409 }
await db.update(schema.tasks).set({ status: 'in_progress', ... })...    // WRITE
```

Two devices can read the same task as `pending_agent`, both pass the check, both update. Make it one statement:

```typescript
const result = await db
  .update(schema.tasks)
  .set({
    status: 'in_progress',
    assignedDeviceId: device.id,
    updatedAt: new Date(),
  })
  .where(
    and(
      eq(schema.tasks.id, id),
      eq(schema.tasks.workspaceId, workspaceId),
      inArray(schema.tasks.status, ['pending_agent', 'assigned']),
      or(
        isNull(schema.tasks.assignedDeviceId),
        eq(schema.tasks.assignedDeviceId, device.id),
      ),
    ),
  )
  .returning();

if (result.length === 0) {
  // Diagnose: not found, wrong status, or owned by another?
  return reply.code(409).send({ error: 'not_claimable_or_already_claimed' });
}
```

Add a `X-Forge-Run-Id` header and an `expectedStatuses` body field to match the Paperclip pattern, but accept the existing forge-lab status names. **Don't rename the statuses.**

Tests: the failing-first test should spawn two concurrent claim requests against the same task and assert exactly one succeeds with `200` and the other returns `409`.

#### P2.1.2: Generalize task_history to entity_history
**Confidence: 7/10. Effort: M.**

Add `entity_type` and `entity_id` columns to `task_history`. Rename the table to `entity_history` via a migration (table swap because SQLite doesn't support `ALTER TABLE RENAME` in older versions and we want to preserve indices). Backfill existing rows with `entity_type = 'task'`, `entity_id = task_id`.

For non-task entities (approvals, workspaces, agents), entity_id holds the relevant id and task_id is null.

**Risk:** Touches all existing history logging sites. Run typecheck after.

#### P2.1.3: Goals table
**Confidence: 9/10. Effort: S.**

```sql
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by_user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX goals_workspace_idx ON goals(workspace_id);
```

Add `parent_id` and `goal_id` columns to `tasks`. Recursive CTE for ancestor lookup. Cycle prevention check on insert/update.

#### P2.1.4: Run-id header convention
**Confidence: 9/10. Effort: XS.**

Add a Fastify hook that reads `X-Forge-Run-Id` and attaches it to the request. Every mutating route logs it into `entity_history` automatically.

---

### Phase 2.2: Heartbeat Execution Model

The biggest design lift. The daemon already runs a worker loop for picking up tasks; this formalizes it to match Paperclip's bounded-execution model. Estimate: 3-4 weeks.

#### P2.2.1: Heartbeat protocol spec
**Confidence: 7/10. Effort: M.**

Adapt Paperclip's protocol to forge-lab's daemon-orchestrated, file-based model. Key adaptation: in forge-lab, the agent process itself is "dumb" (writes files only). The daemon's worker loop is what implements the heartbeat contract by interacting with the hub on the agent's behalf.

Wake reasons:
- `timer`: daemon-side cron schedule per agent
- `assignment`: task assigned to an agent on this device
- `mention`: comment with @-mention
- `manual`: hub API call (`POST /agents/:id/heartbeat/invoke`)
- `approval_resolution`: approval the daemon's agent is waiting on resolves

The wakeup queue table lives in the hub. The daemon WebSocket connection delivers wakeup events. Coalescing happens hub-side on enqueue.

**Risk:** Reconciling Paperclip's "agent does its own work" model with forge-lab's "daemon brokers everything" model. The cleanest framing: the daemon IS the agent (from Paperclip's perspective). The actual LLM runtime is just an opinionated way the daemon executes work.

#### P2.2.2: Wakeup queue
**Confidence: 8/10. Effort: M.**

```sql
CREATE TABLE wakeups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  trigger_entity_type TEXT,
  trigger_entity_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  coalesced_into_id TEXT,
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  run_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX wakeups_agent_state_idx ON wakeups(agent_id, state);
CREATE INDEX wakeups_state_scheduled_idx ON wakeups(state, scheduled_at);
```

On enqueue: if a pending or running wakeup exists for the same agent, mark new one `coalesced` and link it. The hub's `EventBus` emits `wakeup.created` events; the daemon subscribes via WebSocket and reacts.

#### P2.2.3: Runs table
**Confidence: 9/10. Effort: S.**

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  agent_instance_id TEXT REFERENCES agent_instances(id),
  task_id TEXT REFERENCES tasks(id),
  wakeup_id TEXT REFERENCES wakeups(id),
  status TEXT NOT NULL DEFAULT 'queued',
  trigger_reason TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  session_id TEXT,
  exit_code INTEGER,
  error_text TEXT,
  stdout_path TEXT,
  stderr_path TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
```

`agent_instance_id` ties this to the existing model. A single agent_instance can have many runs over its lifetime (matching the heartbeat-vs-instance distinction).

#### P2.2.4: Cost events + vibe-pulse integration
**Confidence: 8/10. Effort: M.**

```sql
CREATE TABLE cost_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  run_id TEXT REFERENCES runs(id),
  task_id TEXT REFERENCES tasks(id),
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX cost_events_workspace_created_idx ON cost_events(workspace_id, created_at);
CREATE INDEX cost_events_agent_created_idx ON cost_events(agent_id, created_at);
```

Integration: vibe-pulse already collects OTLP usage data from Claude Code sessions. Either:
- Option A: vibe-pulse becomes a daemon component that posts cost events to the hub (cleanest, requires refactor)
- Option B: hub exposes `POST /workspaces/:id/cost-events` and vibe-pulse posts directly (faster to ship)

Recommend Option B for first cut.

#### P2.2.5: Extend AgentRuntime for cost + session resume
**Confidence: 7/10. Effort: M.**

Update the `AgentRuntime` interface to surface what Paperclip's adapters provide:

```typescript
export interface AgentRuntime {
  readonly id: RuntimeId;
  readonly displayName: string;
  readonly capabilities: AgentRuntimeCapabilities;

  spawn(config: AgentRuntimeSpawnConfig, initialPrompt: string): Promise<RuntimeInstance>;
  sendInstruction(instance: RuntimeInstance, text: string): Promise<void>;
  stop(instance: RuntimeInstance): Promise<void>;
  isAlive(instance: RuntimeInstance): Promise<boolean>;

  // NEW (Phase 2.2)
  resumeSession?(instance: RuntimeInstance, sessionId: string): Promise<void>;
  reportCosts?(instance: RuntimeInstance): Promise<CostEvent[]>;
  testEnvironment?(config: AgentRuntimeSpawnConfig): Promise<EnvironmentTestResult>;
}
```

All new methods are optional. `MockRuntime` doesn't implement them. `ClaudeCodeRuntime` does. Future runtimes can opt in.

---

### Phase 2.3: Governance and Budget

#### P2.3.1: Budgets + auto-pause
**Confidence: 9/10. Effort: M.**

Per-agent and per-workspace monthly budgets stored as `budget_monthly_cents`. Background job (interval timer in the hub) aggregates `cost_events` by agent and month, compares to budget, transitions agents to `paused` status at 100% with `pause_reason = 'budget_exhausted'`.

Soft warning at 80% injects a note into the prompt template via a `composeSystemPrompt()` hook.

#### P2.3.2: Approvals
**Confidence: 8/10. Effort: M.**

```sql
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by_agent_id TEXT REFERENCES agents(id),
  payload TEXT NOT NULL,
  decision_note TEXT,
  decided_by_user_id TEXT REFERENCES users(id),
  decided_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX approvals_workspace_status_idx ON approvals(workspace_id, status);
```

Start with two approval types: `hire_agent`, `execute_strategy`. Approve/reject/request-revision endpoints. Approval resolution emits a wakeup for the requesting agent.

#### P2.3.3: Agent state machine extensions
**Confidence: 9/10. Effort: S.**

Current statuses: `spawning`, `running`, `idle`, `stopping`, `stopped`, `crashed`. Add to `agents` table (not `agent_instances`): `paused`, `terminated`. Per-agent endpoints: `POST /agents/:id/pause`, `/resume`, `/terminate`.

`agent_instances` keeps its own runtime statuses. `agents` gets the new lifecycle ones. The two state machines are at different layers: instance status is "what is this process doing right now?", agent status is "is this employee active?"

---

### Phase 2.4: Polish

#### P2.4.1: Org chart (`agents.reports_to`)
**Confidence: 9/10. Effort: XS.** Add column, cycle check, `/workspaces/:id/org` endpoint.

#### P2.4.2: Routines
**Confidence: 8/10. Effort: M.** Recurring task creation. Cron + webhook + API triggers.

#### P2.4.3: Skill discovery
**Confidence: 8/10. Effort: S.** Surface SKILL.md files (already used by Adam) to agents. Hub serves them via `/workspaces/:id/skills`.

#### P2.4.4: Forge template export/import (defer)
**Confidence: 7/10. Effort: L.** Companies-spec equivalent. Pam can clone Adam's workspace as a starting point.

---

## 5. The Pam Onboarding Story

Concrete path for what Pam needs:

1. Adam runs forge-lab; first signup makes him admin.
2. Adam adds workspace registration: creates "Adam's Workspace" and assigns existing data to it.
3. After P2.0.4 lands, Adam invites Pam: `POST /admin/invites { email: 'pam@...' }`.
4. Adam shares the invite link with Pam.
5. Pam clicks, signs up, becomes a regular user.
6. Pam creates her own workspaces: "Pam's Pottery Studio", "Pam's Wedding Planning", etc.
7. For shared work, Adam invites Pam to "Adam's Workspace" as a `collaborator`; Pam invites Adam to one of hers.
8. Each workspace has its own agents, budgets, goals, tasks.

**What this gives Pam beyond a generic agent UI:**
- Her own private space for non-dev workflows
- Per-workspace agents tuned to her use cases (writing, scheduling, research, customer outreach)
- Cost visibility (her workspaces don't burn Adam's budget; his don't burn hers)
- A way to share specific workspaces without sharing everything

---

## 6. What Stays in `forge-dash-pro` vs Community

Constraint: Magic UI Pro cannot be in the public repo. The community dashboard (`packages/forge-dash-community`) uses HeroUI v3 (free, redistributable). The pro dashboard (`forge-dash-pro`, separate private repo) layers Magic UI Pro components on top.

**Recommendation:** Build the Paperclip-derived dashboard surfaces (approvals page, budget views, org chart, goal tree, run history) in `forge-dash-community` first. Add the pro flourishes (animations, marketing-grade pages) in `forge-dash-pro` later. This is consistent with Adam's existing plan.

---

## 7. Risk Summary (Updated)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Multi-tenancy migration breaks existing dev data | Medium | High | Backfill migration. Test against snapshot before applying to Adam's machine. |
| Reconciling Paperclip's heartbeat model with daemon-orchestrated model | High | High | Frame the daemon as "the agent" from Paperclip's POV. The runtime is internal detail. |
| Wakeup table grows fast | Medium | Medium | Archive completed wakeups older than 30 days to a cold table. |
| Costs lag real spend | Medium | Low | Hard cap at 110% as a backstop; manual recovery if hit. |
| Approval fatigue | Medium | Medium | Default off. Opt-in per workspace. |
| Pam shares Adam's GitHub credentials by mistake | Low | High | Workspace-scoped GitHub tokens stored as Docker secrets per workspace, not user-global. |
| Phase 2 scope creep into Phase 3 territory | High | High | Ship P2.0 (tenancy) standalone. Use it for 2 weeks before P2.1. |

---

## 8. Open Questions

1. Should existing tasks/agents in Adam's dev DB be assigned to a "Default Workspace" automatically, or does Adam want to start fresh? (Likely fresh; Phase 1 dev data is throwaway.)
2. Will Pam need device tokens, or only user sessions? (Probably only user sessions until she runs her own daemon.)
3. Is the existing `runtime_configs` user-scoping the right level, or should it be workspace-scoped? (Likely workspace, but only if Pam wants per-workspace API keys.)
4. Should `agents.config` (already JSON) absorb the new `budget_monthly_cents` and `reports_to` fields, or do they get their own columns? (Recommend own columns. JSON is for runtime-specific config; lifecycle fields should be queryable.)
5. Does forge-lab want a Docker compose stack for the integration spike, or is it expected to run via `pnpm dev` only? (Compose stack is the deployment story per the architecture doc, so plan for it eventually.)

---

## 9. Recommended Next Actions

1. **You read this plan and push back on anything that doesn't match your intent.**
2. **You spin up a feature branch on forge-lab: `feature/paperclip-integration`.**
3. **Commit these docs to `docs/paperclip-integration/` on the feature branch.**
4. **Use the Claude Code prompt in `04-claude-code-prompt.md` for the first P2.0.1 work session.**

---

## 10. Source Material Read (this session)

forge-lab @ master, 2026-05-13:
- `package.json`, `pnpm-workspace.yaml`, `README.md`, `tsconfig.base.json`, `turbo.json`
- `context/architecture.md`, `context/project-context.md`
- `packages/forge-core/src/schema/db.ts`
- `packages/forge-core/src/types/{task,agent,user,events}.ts`
- `packages/forge-core/src/runtime/agent-runtime.ts`
- `packages/forge-hub/src/app.ts`
- `packages/forge-hub/src/db/{index,migrate}.ts`
- `packages/forge-hub/src/routes/tasks.ts`
- `.claude/commands/forge.md`

paperclipai/paperclip @ master, 2026-05-13: 25+ doc files (see v1 plan §10).
