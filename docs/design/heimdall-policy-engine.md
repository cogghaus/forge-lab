# Heimdall Policy Engine

**Date**: 2026-05-27
**Status**: Draft
**Authors**: Aegis, Architect
**Reviewed-by**: TBD
**Supersedes**: ADR-001 (Heimdall placeholder — unscoped)

---

## 1. Problem Statement

forge-lab's current authorization model is coarse-grained and hardcoded. The hub authenticates principals correctly (cookie sessions for users, bcrypt-hashed Bearer tokens for devices) but authorization after that point relies on two blunt checks:

- `device.deviceType === 'orchestrator'` — gates task assignment and doc writes to the FM orchestrator device type
- `workspaceMembers` row existence — gates user access to workspace resources by membership

This is sufficient for a single-agent deployment. It fails under several threat models that emerge as the fleet grows.

### Threat Model

**T1 — Rogue agent task theft**
A compromised Furnace daemon registers as `agentId: 'oracle'` or omits `agentId` entirely and claims tasks assigned to Oracle. The current claim check (`assignedAgentId IS NULL OR assignedAgentId = device.agentId`) has no policy backing it — it is an inline condition with no audit trail, no deny override, and no way to revoke without code changes.

**T2 — Unauthorized knowledge base writes**
Any device with `deviceType: 'orchestrator'` can write or supersede workspace docs. The intent is that only Scribe performs knowledge base writes. An FM bug or a future orchestrator-type agent (e.g., a monitoring agent) could corrupt the doc store without any policy violation being recorded.

**T3 — Over-privileged user actions**
Workspace `collaborator` and `viewer` roles exist in the schema but are not consistently enforced across all mutation endpoints. A user with `viewer` role can cancel tasks via `PATCH /workspaces/:id/tasks/:taskId` because `requireWorkspaceMember` checks for `collaborator` there, but the pattern is manually applied per-route with no central enforcement or audit.

**T4 — Task injection**
A malicious or corrupted task description could include hub API calls in its prompt payload. If the agent runtime executes these via tool calls or shell commands, the agent acts as an amplifier. Heimdall does not sandbox the agent runtime, but its audit log creates a forensic record: any hub call that succeeds from an unexpected principal produces a logged `policy_decisions` row, enabling detection.

**T5 — Token-based lateral movement**
Device tokens are long-lived bearer tokens. If a token is exfiltrated, the attacker can impersonate the device indefinitely. Heimdall's `device:rotate-token` and `device:deregister` actions can be gated to specific principals, and all exercises of those actions are logged.

---

## 2. Policy Model (PARC)

Heimdall uses a **PARC** model: Principal, Action, Resource, Condition.

### 2.1 Principals

| Principal form | Resolved from | Example |
|---|---|---|
| `user:<userId>` | `req.authUser.id` | `user:abc123` |
| `device:<deviceId>` | `req.authDevice.id` | `device:xyz789` |
| `agent:<agentId>` | `req.authDevice.agentId` | `agent:scribe` |
| `role:orchestrator` | `req.authDevice.deviceType === 'orchestrator'` | `role:orchestrator` |
| `role:worker` | `req.authDevice.deviceType === 'worker'` | `role:worker` |
| `workspace-role:<r>` | `req.authWorkspace.role` | `workspace-role:viewer` |

A single request may match multiple principal forms simultaneously. A device with `agentId: 'scribe'` and `deviceType: 'worker'` matches `device:<id>`, `agent:scribe`, and `role:worker`. The policy engine evaluates all matching rules and applies the highest-priority decision.

Rules are sorted by priority descending (highest priority number evaluated first). When two rules have the same priority number and one is `allow` and the other is `deny`, the `deny` rule is evaluated first. In practice, assign distinct priority values to avoid ties.

### 2.2 Actions (Verbs)

| Action | HTTP mapping | Notes |
|---|---|---|
| `task:claim` | `POST /tasks/:id/claim` | Device claims an assigned or unrouted task |
| `task:assign` | `PATCH /workspaces/:id/tasks/:taskId/assign` | FM routes a task to a specific agent |
| `task:cancel` | `PATCH /workspaces/:id/tasks/:taskId` body `{status: 'cancelled'}` | User cancels a task |
| `task:retry` | `PATCH /workspaces/:id/tasks/:taskId` body `{status: 'pending_agent'}` | User requeues a failed or cancelled task |
| `task:complete` | `POST /tasks/:id/complete` | Device marks its claimed task done |
| `task:fail` | `POST /tasks/:id/fail` | Device marks its claimed task failed |
| `doc:write` | `POST /workspaces/:id/docs` | Create a new workspace doc |
| `doc:update` | `PATCH /workspaces/:id/docs/:key` content/title changes | Update an active doc's body |
| `doc:supersede` | `PATCH /workspaces/:id/docs/:key` body `{status: 'superseded'}` | Mark a doc superseded |
| `doc:archive` | `PATCH /workspaces/:id/docs/:key` body `{status: 'archived'}` | Mark a doc archived |
| `device:rotate-token` | `POST /devices/:id/rotate-token` (Phase 2 endpoint) | Regenerate bearer token |
| `device:deregister` | `DELETE /devices/:id` (Phase 2 endpoint) | Remove device registration |
| `context:read` | `GET /workspaces/:id/context` | FM reads full workspace context bundle |

### 2.3 Resources

| Resource type | Key attributes available for conditions |
|---|---|
| `task` | `id`, `workspaceId`, `status`, `assignedAgentId`, `assignedDeviceId`, `createdBy` |
| `doc` | `id`, `workspaceId`, `key`, `status`, `updatedBy` |
| `device` | `id`, `workspaceId` (via owning user's workspaces), `agentId`, `deviceType` |
| `workspace` | `id`, `status` |

### 2.4 Conditions

Conditions are JSON predicates evaluated against resource attributes and the principal's context. Phase 1 supports a small set of primitives:

| Condition key | Meaning |
|---|---|
| `resource.workspaceId = principal.memberWorkspaces` | Resource's workspace is in the user's workspace memberships |
| `resource.assignedAgentId = principal.agentId` | Task is assigned to the calling agent |
| `resource.assignedDeviceId = principal.deviceId` | Task is claimed by the calling device |
| `principal.workspaceRole >= <role>` | User's workspace membership role ranks at or above the given level |

Phase 2 extends conditions to the full JSON expression set defined in the `resource_condition` column.

### 2.5 Effects

`allow` or `deny`. The evaluation order is:

1. Collect all rules matching the (principal, action, resource-type) triple.
2. Sort by `priority DESC`.
3. The first matching rule's effect wins.
4. If no rule matches: **default deny** (fail closed).

---

## 3. Default Policy Set

These rules ship as code in Phase 1 (`src/policy/defaults.ts`). They are not stored in the DB and are not configurable by workspace admins. They represent the intended security posture of a correctly operating forge-lab deployment.

| Principal | Action | Resource condition | Effect | Rationale |
|---|---|---|---|---|
| `agent:forge-master` | `task:assign` | any task in workspace | allow | FM is the sole routing authority |
| `agent:forge-master` | `context:read` | any workspace | allow | FM needs full context to triage |
| `agent:scribe` | `doc:write` | any doc in workspace | allow | Scribe is the knowledge base author |
| `role:orchestrator` | `doc:write` | any doc in workspace | allow | Preserves backward compatibility. Current code allows any orchestrator device to write docs, not just Scribe. This rule must remain in Phase 1 to avoid a behavior regression. After Heimdall is stable, tighten to `agent:scribe → doc:write → allow` only. Priority 150. |
| `agent:scribe` | `doc:update` | any active doc in workspace | allow | Scribe keeps docs current |
| `agent:scribe` | `doc:supersede` | any active doc in workspace | allow | Scribe manages doc lifecycle |
| `role:worker` | `task:assign` | any | deny | Workers claim; FM assigns |
| `role:worker` | `doc:supersede` | any | deny | Supersede is Scribe's privilege |
| `role:worker` | `doc:write` | any | deny | Only Scribe and users write docs |
| `role:orchestrator` | `task:claim` | any | deny | Orchestrators assign; daemons claim |
| `user:*` | `task:claim` | any | deny | Users do not claim tasks |
| `user:*` | `task:assign` | any | deny | Task routing is FM-only |
| `user:*` | `task:cancel` | `resource.workspaceId in principal.memberWorkspaces` | allow | Members can cancel their workspace tasks |
| `user:*` | `task:retry` | `resource.workspaceId in principal.memberWorkspaces` | allow | Members can requeue failed tasks |
| `user:*` | `doc:write` | `principal.workspaceRole >= collaborator` | allow | Collaborators can write docs |
| `user:*` | `doc:update` | `principal.workspaceRole >= collaborator` | allow | Collaborators can update docs |

> **Phase 1 note**: Phase 1 does not include device management endpoints. `device:*` policy rules are added to the default set in Phase 2 after those endpoints ship. The `device:deregister` and `device:rotate-token` rules listed above in the Actions table are Phase 2 items only.

**Priority note**: The `role:worker` deny rules must carry higher priority than any default allow for those actions. In the default rule set, denies for `role:worker` on `doc:write` and `doc:supersede` sit at priority 100; the `agent:scribe` allows sit at priority 50. A Scribe device is `role:worker` and `agent:scribe` simultaneously. The higher-priority deny would block Scribe, which is wrong. The resolution: agent-specific allows at priority 200 override role-level denies at priority 100. The evaluation order guarantees that `agent:scribe → doc:write → allow @ 200` fires before `role:worker → doc:write → deny @ 100`.

Full priority table for Phase 1 built-in rules:

| Priority | Rule class |
|---|---|
| 200 | Named agent allows (`agent:forge-master`, `agent:scribe`) |
| 150 | Role-level backward-compat allows (`role:orchestrator → doc:write`), to be tightened in Phase 2 |
| 100 | Role-level denies (`role:worker → doc:supersede`, etc.) |
| 50 | User allows scoped by workspace membership |
| 10 | Broad user denies (`user:* → task:claim`) |
| 0 | Default deny (implicit, no rule needed) |

---

## 4. Schema Design

Phase 2 adds these two tables. Phase 1 does not require them — rules live in code and the audit log writes to `policy_decisions` only.

```sql
-- Policy rules: workspace-specific overrides or global defaults.
-- workspace_id IS NULL = global (applies to all workspaces).
-- Operators insert rows here to extend or restrict behavior beyond the built-in defaults.
CREATE TABLE policy_rules (
  id           TEXT    PRIMARY KEY,
  workspace_id TEXT,                           -- NULL = global
  principal    TEXT    NOT NULL,               -- "agent:scribe", "role:worker", "user:*"
  action       TEXT    NOT NULL,               -- "doc:write", "task:assign"
  resource_type TEXT,                          -- "doc", "task", NULL = any
  resource_condition TEXT,                     -- JSON: {"assignedAgentId": "$principal.agentId"}
  effect       TEXT    NOT NULL CHECK (effect IN ('allow', 'deny')),
  priority     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX policy_rules_workspace_idx ON policy_rules (workspace_id);
CREATE INDEX policy_rules_action_idx    ON policy_rules (action);

-- Policy audit log: every policy decision is written here asynchronously.
-- rule_id is NULL when the decision was default-deny (no rule matched).
-- Retained indefinitely — docs are never deleted and neither are audit decisions.
CREATE TABLE policy_decisions (
  id           TEXT    PRIMARY KEY,
  workspace_id TEXT,
  principal    TEXT    NOT NULL,               -- resolved principal string, e.g. "agent:scribe"
  action       TEXT    NOT NULL,
  resource_id  TEXT,                           -- task id, doc id, device id, or NULL
  effect       TEXT    NOT NULL CHECK (effect IN ('allow', 'deny')),
  rule_id      TEXT,                           -- FK to policy_rules.id, NULL = default-deny
  decided_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX policy_decisions_workspace_idx  ON policy_decisions (workspace_id, decided_at DESC);
CREATE INDEX policy_decisions_principal_idx  ON policy_decisions (principal, decided_at DESC);
CREATE INDEX policy_decisions_action_idx     ON policy_decisions (action, decided_at DESC);
```

> **Audit integrity note**: `policyDecisions.ruleId` is nullable intentionally (default-deny has no matching rule). Policy rule rows must not be hard-deleted; soft-archive (set `archived_at`) only to preserve audit log integrity. The `policy_rules` management endpoint must reject DELETE requests and expose archive/disable instead.

> **workspaceId nullability note**: `policyDecisions.workspaceId` is nullable to support platform-level policy checks (e.g., user registration, cross-workspace operations) that have no workspace context. For workspace-scoped actions, `workspaceId` is always populated.

### Drizzle schema additions (Phase 2)

```typescript
// packages/forge-core/src/schema/db.ts additions

export const policyRules = sqliteTable(
  'policy_rules',
  {
    id:                text('id').primaryKey(),
    workspaceId:       text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    principal:         text('principal').notNull(),
    action:            text('action').notNull(),
    resourceType:      text('resource_type'),
    resourceCondition: text('resource_condition', { mode: 'json' }),
    effect:            text('effect', { enum: ['allow', 'deny'] }).notNull(),
    priority:          integer('priority').notNull().default(0),
    createdAt:         timestampMs('created_at').notNull().default(nowDefault),
  },
  (t) => ({
    workspaceIdx: index('policy_rules_workspace_idx').on(t.workspaceId),
    actionIdx:    index('policy_rules_action_idx').on(t.action),
  }),
);

export const policyDecisions = sqliteTable(
  'policy_decisions',
  {
    id:          text('id').primaryKey(),
    workspaceId: text('workspace_id'),
    principal:   text('principal').notNull(),
    action:      text('action').notNull(),
    resourceId:  text('resource_id'),
    effect:      text('effect', { enum: ['allow', 'deny'] }).notNull(),
    ruleId:      text('rule_id'),
    decidedAt:   timestampMs('decided_at').notNull().default(nowDefault),
  },
  (t) => ({
    workspaceIdx: index('policy_decisions_workspace_idx').on(t.workspaceId, t.decidedAt),
    principalIdx: index('policy_decisions_principal_idx').on(t.principal, t.decidedAt),
  }),
);
```

> **Uniqueness recommendation**: Add a partial UNIQUE index `(workspace_id, principal, action, resource_type)` on `policy_rules` to prevent shadowing rules with identical scope. The management UI must surface a warning when two rules have the same scope at different priorities.

---

## 5. Enforcement Layer

### 5.1 checkPolicy signature

```typescript
// packages/forge-hub/src/policy/engine.ts

export interface PolicyPrincipal {
  type: 'user' | 'device';
  id: string;
  agentId?: string | null;
  deviceType?: 'worker' | 'orchestrator';
  userId?: string;
  memberWorkspaces?: string[];       // populated for user principals
  workspaceRole?: WorkspaceRole;     // populated for user principals in workspace context
}

export interface PolicyResource {
  type: 'task' | 'doc' | 'device' | 'workspace';
  id?: string;
  workspaceId?: string | null;
  assignedAgentId?: string | null;
  assignedDeviceId?: string | null;
  status?: string;
  userId?: string;                   // for device resources: owning user
}

export interface PolicyDecision {
  allowed: boolean;
  effect: 'allow' | 'deny';
  rule: BuiltInRule | PolicyRule | null;  // null = default-deny
  principal: string;                       // resolved string, e.g. "agent:scribe"
}

export async function checkPolicy(
  principal: PolicyPrincipal,
  action: string,
  resource: PolicyResource,
  ctx: { db: Db; workspaceId?: string },
): Promise<PolicyDecision>
```

### 5.2 Evaluation algorithm

```
function checkPolicy(principal, action, resource, ctx):
  candidates = []

  // Resolve all principal strings this request matches
  principalStrings = resolvePrincipals(principal)
  // e.g. ["device:xyz", "agent:scribe", "role:worker"]

  // Phase 1: load built-in rules
  rules = BUILT_IN_RULES.filter(r =>
    principalStrings.some(p => matchesPrincipal(r.principal, p))
    && r.action === action
    && (r.resourceType == null || r.resourceType === resource.type)
  )

  // Phase 2: also load DB rules (workspace-scoped + global)
  // dbRules = await loadDbRules(ctx.db, principalStrings, action, resource.type, ctx.workspaceId)
  // rules = [...rules, ...dbRules]

  // Sort by priority DESC, then effect: deny > allow on tie
  rules.sort((a, b) => b.priority - a.priority || (a.effect === 'deny' ? -1 : 1))

  for rule in rules:
    if evaluateCondition(rule.resourceCondition, principal, resource):
      decision = { allowed: rule.effect === 'allow', effect: rule.effect, rule }
      logDecision(decision, ctx)  // async, non-blocking
      return decision

  // Default deny — no rule matched
  decision = { allowed: false, effect: 'deny', rule: null }
  logDecision(decision, ctx)
  return decision
```

### 5.3 Route integration

On deny, routes return:

```json
HTTP 403
{
  "error": "policy_denied",
  "action": "doc:write",
  "principal": "role:worker"
}
```

The audit log write is fire-and-forget (`void logDecision(...)`) so it never blocks request latency. If `logDecision` throws, the error must be logged to the structured logger (`fastify.log.warn`) but must NOT fail the request. Audit write failures are non-blocking. A future metric counter (`heimdall_audit_failures_total`) should be incremented on failure to surface this in operations monitoring.

### 5.4 Phase 1 enforcement points (minimum viable)

These three call sites are the Phase 1 target. They cover the highest-risk actions: FM assignment authority, Scribe doc authority, and task claim routing.

**task:assign** — `PATCH /workspaces/:workspaceId/tasks/:taskId/assign`

Current code:
```typescript
if (device.deviceType !== 'orchestrator') {
  await reply.code(403).send({ error: 'orchestrator_required' });
  return;
}
```

Migrated:
```typescript
const principal = buildPrincipal(device);
const resource = { type: 'task' as const, id: taskId, workspaceId };
const decision = await checkPolicy(principal, 'task:assign', resource, { db, workspaceId });
if (!decision.allowed) {
  await reply.code(403).send({ error: 'policy_denied', action: 'task:assign', principal: decision.principal });
  return;
}
```

**doc:write** — `POST /workspaces/:workspaceId/docs`

Current code checks `device.deviceType !== 'orchestrator'` for device requests. Migrated to `checkPolicy(principal, 'doc:write', ...)`. The built-in policy allows `agent:scribe` (priority 200) and `user:* with collaborator role` (priority 50), and denies `role:worker` (priority 100). A non-Scribe worker is caught by the role deny before the worker-doc-write path is reached.

**task:claim** — `POST /tasks/:id/claim`

The existing agentId filter in the SQL WHERE clause is correct but silent. Phase 1 adds a pre-flight `checkPolicy` call that produces an audit record. The SQL filter remains as a defense-in-depth layer.

The policy check is authoritative for access control. The existing SQL `WHERE assignedAgentId IS NULL OR assignedAgentId = :agentId` filter remains as defense-in-depth and prevents double-claim at the DB layer regardless of policy evaluation. Both layers are intentional. If they conflict (policy allows but SQL rejects), the SQL rejection takes precedence for the atomic claim guarantee.

### 5.5 Phase 2 enforcement points (complete coverage)

- `task:cancel` and `task:retry` — currently in `PATCH /workspaces/:id/tasks/:taskId`, gated by `requireWorkspaceMember(db, 'collaborator')`. Migrate to policy check so the workspace role requirement becomes a policy condition, not a hardcoded preHandler argument.
- `doc:supersede` and `doc:archive` — `PATCH /workspaces/:id/docs/:key` with status change. Add action differentiation: the route currently treats all PATCH operations identically; split into `doc:update` (content changes) vs `doc:supersede`/`doc:archive` (status transitions).
- `device:deregister` and `device:rotate-token` — pending Phase 2 route additions. When those endpoints ship, add the corresponding default rules: `user:* → device:deregister → allow` (condition: `resource.userId = principal.userId`) and `user:* → device:rotate-token → allow` (condition: `resource.userId = principal.userId`).
- `context:read` — FM's workspace context bundle endpoint, if added.

---

## 6. Management UI (Phase 2 / Stretch Goal)

A workspace settings page in forge-dash-community will expose:

- **Policy rules table** — list all workspace-scoped rules + global built-ins (built-ins shown as read-only)
- **Add/edit rule** — admin-only; principal, action, resource type, condition JSON, effect, priority
- **Delete rule** — admin-only; cannot delete built-in rules
- **Audit log viewer** — paginated `policy_decisions` table, filterable by principal, action, effect, time range
- **Decision detail** — click a decision row to see which rule triggered it and the full resource context

The management UI is gated on the workspace `admin` or `owner` role. Viewers and collaborators can see the audit log but cannot modify rules.

This is Phase 2 scope. No current sprint work required.

---

## 7. Implementation Approach

### Phase 1: Policy as code

**Goal**: Security coverage at the three highest-risk endpoints without DB schema changes or a management UI.

**Location**: `packages/forge-hub/src/policy/`

```
src/policy/
  defaults.ts        -- BuiltInRule[] array, the default policy set
  engine.ts          -- checkPolicy(), resolvePrincipals(), evaluateCondition()
  audit.ts           -- logDecision() — async write to policy_decisions table
  principals.ts      -- buildPrincipal() helper that maps AuthDevice/AuthUser → PolicyPrincipal
```

`defaults.ts` is pure data — an array of `BuiltInRule` objects with no database dependency. `engine.ts` imports it and evaluates in memory. This means:

- Zero DB queries for rule lookup in Phase 1 (rules are in-process constants)
- The evaluation logic is identical to Phase 2; only the rule source changes
- Adding a DB-backed rule layer in Phase 2 means inserting one `loadDbRules()` call into the engine without touching the evaluation loop

**Phase 1 condition evaluation**: Phase 1 conditions are simple key-value equality checks only. The condition JSON `{"assignedAgentId": "$principal.agentId"}` is evaluated as: `resource[key] === resolvePrincipalField(principal, value)`. No nested logic, no operators beyond equality. Full JSON Logic evaluation is Phase 2.

**buildPrincipal caching**: `buildPrincipal` performs one DB query (workspace membership lookup) per request for user principals. Cache membership per `(userId, workspaceId)` pair with a 30-second TTL using an in-process LRU cache (max 500 entries). Device principals require no DB lookup beyond the token verification already performed in `populateAuth`.

**Migration path for existing hardcoded checks**:

Before (docs.ts):
```typescript
if (req.authDevice) {
  const device = getDevice(req);
  if (device.deviceType !== 'orchestrator') {
    await reply.code(403).send({ error: 'orchestrator_required' });
    return;
  }
  updatedBy = device.agentId ?? `device:${device.id}`;
}
```

After:
```typescript
if (req.authDevice) {
  const device = getDevice(req);
  const principal = buildPrincipal(device);
  const decision = await checkPolicy(
    principal,
    'doc:write',
    { type: 'doc', workspaceId },
    { db, workspaceId },
  );
  if (!decision.allowed) {
    await reply.code(403).send({
      error: 'policy_denied',
      action: 'doc:write',
      principal: decision.principal,
    });
    return;
  }
  updatedBy = device.agentId ?? `device:${device.id}`;
}
```

The existing behavior is preserved because the built-in rules reproduce the same allow/deny outcome. The difference: the decision is now logged, the error response carries actionable detail, and the rule can be overridden in Phase 2 without code changes.

**Existing behavior continuity**: every currently-allowed request will continue to be allowed. The built-in rules are designed to mirror existing `deviceType` and membership checks exactly. No behavior change on allow paths. On deny paths, the error body changes from `{ error: 'orchestrator_required' }` to `{ error: 'policy_denied', action: '...', principal: '...' }`. Callers that check only the HTTP status code are unaffected.

### Phase 2: DB-backed rules

1. Run migration to add `policy_rules` and `policy_decisions` tables.
2. Seed the built-in rules into `policy_rules` with `workspace_id = NULL` and appropriate priorities.
3. In `engine.ts`, add `loadDbRules()` after the built-in rule load; merge and re-sort.
4. Ship the management UI routes in forge-hub and the settings page in forge-dash-community.

---

## 8. Required Tests

All tests live in `packages/forge-hub/src/policy/engine.test.ts`.

| Test case | Assertion |
|---|---|
| Allow rule matches | `checkPolicy` returns `{ allowed: true }` when a matching allow rule exists |
| Deny rule matches | `checkPolicy` returns `{ allowed: false }` and route returns 403 |
| Default deny | No matching rule exists; `checkPolicy` returns `{ allowed: false, rule: null }` |
| Priority: deny overrides allow at higher priority | Two rules match; deny at priority 100 beats allow at priority 50 |
| Priority: named agent allow overrides role deny | `agent:scribe` allow at 200 beats `role:worker` deny at 100 |
| Audit log written on allow | `policy_decisions` row inserted with `effect: 'allow'` |
| Audit log written on deny | `policy_decisions` row inserted with `effect: 'deny'` |
| Audit log written on default deny | `policy_decisions` row inserted with `effect: 'deny'` and `rule_id: null` |
| Audit log is non-blocking | Removing the DB from context does not cause `checkPolicy` to throw |
| task:assign denied for role:worker | Worker device calling assign endpoint receives 403 policy_denied |
| doc:write allowed for agent:scribe | Scribe device can create a doc despite being role:worker |
| doc:write denied for non-Scribe worker | A worker with `agentId: 'furnace'` receives 403 on doc:write |
| task:claim denied for orchestrator | Orchestrator-type device cannot claim a task |
| task:cancel allowed for workspace member | User who is workspace collaborator can cancel a task in that workspace |
| task:cancel denied for non-member | User with no membership in the task's workspace receives 403 |

Integration tests (route-level) extend the existing test suite in `tasks.test.ts` and `docs.test.ts` to assert that the 403 response body now contains `error: 'policy_denied'` after migration.

---

## 9. Migration Path from Current Auth

The migration is incremental. Each enforcement point moves independently with no flag day.

### Step 1: Add the policy package (no behavior change)

Create `src/policy/` with `defaults.ts`, `engine.ts`, `audit.ts`, `principals.ts`. Add the `policy_decisions` table to `migrate.ts`. No routes call `checkPolicy` yet. Tests for the engine logic pass.

### Step 2: Migrate task:assign (one route change)

Replace the `device.deviceType !== 'orchestrator'` check in the assign handler with `checkPolicy`. The built-in rule `agent:forge-master → task:assign → allow @ 200` and `role:worker → task:assign → deny @ 100` reproduce the previous allow/deny split exactly. Existing tests pass. Audit log starts populating.

### Step 3: Migrate doc:write (one route change, two handlers)

`POST /workspaces/:id/docs` and `PATCH /workspaces/:id/docs/:key` both have inline `deviceType` checks. Replace both with `checkPolicy`. Scribe keeps working (priority 200 allow). Non-Scribe orchestrators would previously succeed (device.deviceType === 'orchestrator' was the only gate); after migration they are denied by `role:worker → doc:write → deny @ 100` if they are workers, but orchestrator-type non-Scribe devices still match no allow rule and fall through to default-deny. This is a tightening of existing behavior, intentional.

### Step 4: Migrate task:claim (audit only in Phase 1)

Add a `checkPolicy` pre-flight before the SQL claim. The SQL WHERE clause stays. The policy check adds an audit record but does not change the outcome in the common case because the SQL condition and the built-in claim rules are aligned.

### Step 5: Phase 2 — remaining actions

Each remaining action follows the same pattern: identify the hardcoded check, write the equivalent built-in rule, replace the check with `checkPolicy`, update tests.

---

## 10. Security Properties

| Property | Achieved in Phase 1 | Achieved in Phase 2 |
|---|---|---|
| Fail closed (default deny) | Yes | Yes |
| Audit trail on every policy decision | Yes (policy_decisions table) | Yes + UI |
| Agent capability isolation (Scribe docs, FM assign) | Yes | Yes |
| Workspace-scoped rule overrides | No | Yes |
| Custom operator-defined rules | No | Yes |
| Token expiry / rotation gating | No (endpoint not built) | Yes |
| Task injection forensics | Partial (audit log) | Full (rule coverage + UI) |

Heimdall is not an intrusion detection system. It does not rate-limit, does not block based on behavioral anomalies, and does not scan task content. Those concerns belong to a separate layer. Heimdall's scope is: for each hub API call, given the authenticated principal and the target resource, determine and record whether the operation is permitted.
