# Task Sequencing + Dependency Graph Design v2

## 1. Overview

This document describes the design for two related features that extend forge-lab's task model: (1) **task sequencing**, which lets a single task be decomposed into an ordered series of phases, each executed by a specific agent role; and (2) a **dependency graph**, which lets tasks declare cross-task dependencies so that a task is automatically held until all of its prerequisites reach a terminal-success state. Both features are implemented server-side in the hub with no orchestration logic in the daemon.

---

## 2. Goals

- **Phase sequences (intra-task):** A task may carry a `sequenceSpec` that describes an ordered list of phases. Each phase has a title, a target agent role, and a prompt. The hub creates and advances phase tasks one at a time, storing inter-phase output and injecting a capped, sandboxed version of it into the next phase prompt.
- **Dependency graph (cross-task):** A task may declare a `dependsOn` array of task IDs in the same workspace. If any listed task is not yet in a terminal-success state at creation time, the task starts with status `waiting_on_deps` and is advanced to `pending_agent` automatically when all deps are satisfied.
- All orchestration logic lives in the hub, not the daemon (ADR-001 compliance).
- All phase transitions are atomic via libsql `batch()`.

---

## 3. Non-Goals v1

The following are explicitly out of scope for this release:

- **`requiresApproval` / `pending_approval` status** -- deferred. Human approval gates between phases will be designed separately.
- **Sequence builder UI in the dash modal** -- API-only for v1. The sequence spec is submitted as raw JSON from the API; no visual builder ships with this feature.
- **PR URL / CI visibility panel** -- not part of this feature.
- **Tag-based agent routing** -- phases route by exact `agentId` match against `devices.agent_id`.
- **Parallel phases** -- all phases are strictly sequential. Parallel fan-out is a future concern.
- **Cross-workspace dependencies** -- `dependsOn` is validated to reference tasks within the same workspace only.

---

## 4. Data Model Changes

### 4.1 New TaskStatus Values

Add to `TaskStatusSchema` in `packages/forge-core/src/types/task.ts`:

```typescript
'sequenced_running',   // root task with at least one phase active or pending
'sequenced_complete',  // root task with all phases done (terminal-success)
'waiting_on_deps',     // task blocked on one or more unmet dependencies
```

Full updated enum (replace existing):

```typescript
export const TaskStatusSchema = z.enum([
  'pending_design',
  'design_review',
  'pending_agent',
  'assigned',
  'in_progress',
  'pending_dispatcher_action',
  'sequenced_running',
  'sequenced_complete',
  'waiting_on_deps',
  'completed',
  'failed',
  'cancelled',
]);
```

Terminal-success statuses (for dependency resolution): `completed`, `sequenced_complete`.
Terminal statuses (no further transitions): `completed`, `sequenced_complete`, `failed`, `cancelled`.

**Status guard constants in tasks.ts must be updated as follows:**

```typescript
// Named constant shared between the cancel guard and the unblocking algorithm
const TERMINAL_SUCCESS_STATUSES = new Set(['completed', 'sequenced_complete']);

// All statuses from which no further transitions are possible
const TERMINAL_STATUSES = new Set(['completed', 'sequenced_complete', 'failed', 'cancelled']);

// Statuses a user can cancel from
const CANCELLABLE_STATUSES = new Set([
  'pending_design',        // retained from live codebase -- do NOT drop
  'design_review',         // retained from live codebase -- do NOT drop
  'pending_agent',
  'assigned',
  'in_progress',
  'pending_dispatcher_action',
  'sequenced_running',    // sequenced root can be cancelled
  'waiting_on_deps',      // dependency-blocked task can be cancelled
]);

// Permitted status transitions initiated by user action
const USER_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  // ... existing entries ...
  pending_design:   ['cancelled'],   // retained from live codebase -- do NOT drop
  design_review:    ['cancelled'],   // retained from live codebase -- do NOT drop
  sequenced_running: ['cancelled'],
  waiting_on_deps:  ['cancelled'],
};
```

These constants must be consistent across the cancel guard, the stale-assigned detection, and the unblocking algorithm. `TERMINAL_SUCCESS_STATUSES` is the single source of truth for "what counts as done" in both the dep unblocking pass and cancel eligibility checks.

### 4.2 TaskId Format: Compound Phase IDs

Phase task IDs use a compound format: `<parentId>-p<phaseIndex>`, e.g. `fl-042-p0`, `fl-042-p1`.

Update `TaskIdSchema` in `packages/forge-core/src/types/ids.ts` to allow this:

```typescript
export const TaskIdSchema = z
  .string()
  .regex(
    /^[a-z]{2,6}-\d{1,6}(-p\d{1,2})?$/,
    'Task ID must be prefix-digits (e.g. fl-001) or prefix-digits-pN (e.g. fl-001-p0)',
  );
```

`formatTaskId` is unchanged -- it only produces root task IDs. Add a new `formatPhaseTaskId`:

```typescript
export function formatPhaseTaskId(parentId: string, phaseIndex: number): string {
  return `${parentId}-p${phaseIndex}`;
}
```

**`parseTaskId` must explicitly reject compound IDs** (compound IDs have no meaningful sequence counter). Document `parseTaskId('fl-042-p0')` as unsupported/throws. Add the following tests to `ids.test.ts`:

```typescript
// ids.test.ts additions
it('formatPhaseTaskId produces correct compound ID', () => {
  expect(formatPhaseTaskId('fl-042', 0)).toBe('fl-042-p0');
});

it('TaskIdSchema accepts compound phase IDs', () => {
  expect(() => TaskIdSchema.parse('fl-042-p0')).not.toThrow();
});

it('parseTaskId on a compound phase ID throws', () => {
  expect(() => parseTaskId('fl-042-p0')).toThrow();
});
```

**`maxSeq` scan in the task creation path must filter `WHERE parent_id IS NULL`** (via `isNull(schema.tasks.parentId)` in Drizzle) to avoid phase IDs (which contain non-numeric suffixes) distorting the sequence counter. This filter must be applied in BOTH task creation paths:

- Flat `POST /tasks` (tasks.ts ~line 100)
- Workspace `POST /workspaces/:id/tasks` (tasks.ts ~line 750)

Extract a shared `getMaxRootSeq(db, prefix)` helper to prevent future drift between the two paths. This must land in the same PR as the `TaskIdSchema` regex update, before any phase tasks are inserted in production.

### 4.3 New Zod Schemas in forge-core

Add to `packages/forge-core/src/types/task.ts`:

```typescript
export const PhaseSpecSchema = z.object({
  title: z.string().min(1).max(200),
  role: z.string().min(1).max(100),
  prompt: z.string().min(1).max(8000),
});
export type PhaseSpec = z.infer<typeof PhaseSpecSchema>;

export const SequenceSpecSchema = z.object({
  // min(1): single-phase sequences are degenerate but not invalid.
  // If you need to enforce at least 2 phases, document that rationale explicitly here.
  phases: z.array(PhaseSpecSchema).min(1).max(10),
});
export type SequenceSpec = z.infer<typeof SequenceSpecSchema>;

export const PhaseStatusSchema = z.enum(['pending', 'active', 'complete', 'failed']);
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

export const PhaseResponseSchema = z.object({
  phaseIndex: z.number().int().min(0),
  taskId: z.string().optional(),       // undefined before phase task is created
  title: z.string(),
  role: z.string(),
  status: PhaseStatusSchema,
  result: z.string().optional(),       // populated once phase completes
});
export type PhaseResponse = z.infer<typeof PhaseResponseSchema>;
```

`PhaseStatus` is derived at response time, never stored as a column.

Note: `PhaseResponseSchema.taskId` is typed `optional()` which means `undefined` in TypeScript, not `null`. All response-shaping code must emit `undefined` (omit the field) rather than `null` when the phase task has not yet been created. Audit any response-shaping code that sets `taskId: null` -- this must be changed to omit the field or set `taskId: undefined`.

### 4.4 New Columns on Tasks Table

Exact SQL for migration `0016_task_sequencing` (see Section 11 for the full migration):

```sql
ALTER TABLE tasks ADD COLUMN sequence_spec      TEXT;
ALTER TABLE tasks ADD COLUMN sequence_spec_hash TEXT;
ALTER TABLE tasks ADD COLUMN phase_index        INTEGER;
ALTER TABLE tasks ADD COLUMN result             TEXT;
ALTER TABLE tasks ADD COLUMN depends_on         TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN blocked_reason     TEXT;

CREATE UNIQUE INDEX tasks_parent_phase_idx
  ON tasks(parent_id, phase_index)
  WHERE phase_index IS NOT NULL;

-- Check constraint to ensure depends_on always contains valid JSON
-- (SQLite enforces CHECK constraints only on INSERT/UPDATE)
-- Note: Add this as a separate statement in the migration; libsql runner splits on ';'
CREATE TABLE tasks_new AS SELECT * FROM tasks; -- not used; constraint added inline at table-create time in future migrations
```

The `depends_on` column must have a `CHECK (json_valid(depends_on))` constraint. Because SQLite does not support `ADD COLUMN ... CHECK (...)` via `ALTER TABLE`, this constraint is documented here for any future table-rebuild migration; for v1, enforce JSON validity at the application layer (see Section 6.2 unblocking pass).

Column semantics:

| Column | Type | Notes |
|---|---|---|
| `sequence_spec` | TEXT / JSON | `SequenceSpec` as JSON. Null on non-sequenced tasks and phase children. |
| `sequence_spec_hash` | TEXT | SHA-256 of the serialized `sequence_spec` JSON. See Section 4.6 for integrity verification contract. |
| `phase_index` | INTEGER | 0-based index of this phase within the parent's sequence. NULL for root tasks and plain FM subtasks. |
| `result` | TEXT | Freeform output text from the completing agent. Max 4000 chars enforced at the API layer. |
| `depends_on` | TEXT NOT NULL DEFAULT '[]' | JSON array of task ID strings. Empty array = no deps. Must contain valid JSON; validated at write time. |
| `blocked_reason` | TEXT | Human-readable block reason, e.g. `role_unavailable:Anvil`. Cleared when block resolves. |

The partial unique index `tasks_parent_phase_idx` prevents duplicate phase rows and serves as defense-in-depth against double-advance races.

### 4.5 Drizzle Schema Additions

Add to `packages/forge-hub` wherever the Drizzle `tasks` table is declared (likely inlined via `@forge-lab/core` schema re-export):

```typescript
sequenceSpec:     text('sequence_spec'),
sequenceSpecHash: text('sequence_spec_hash'),
phaseIndex:       integer('phase_index'),
result:           text('result'),
dependsOn:        text('depends_on').notNull().default('[]'),
blockedReason:    text('blocked_reason'),
```

No new tables are required. Phase tasks are regular rows in `tasks` distinguished by `phase_index IS NOT NULL`.

### 4.6 sequence_spec_hash Integrity Verification

Whenever the hub reads `sequence_spec` to execute phase transitions, it must re-compute SHA-256 of the retrieved JSON and compare to `sequence_spec_hash`:

```typescript
const retrieved = JSON.parse(task.sequenceSpec);
const computedHash = createHash('sha256').update(task.sequenceSpec).digest('hex');
if (computedHash !== task.sequenceSpecHash) {
  await insertHistoryEvent(db, task.id, 'task.sequence_integrity_failure', {
    computedHash,
    storedHash: task.sequenceSpecHash,
  });
  return reply.status(500).send({ error: 'sequence_integrity_failure' });
}
```

If this verification will not be implemented in v1, **drop `sequence_spec_hash` from v1 scope entirely** rather than storing the hash without verifying it. A stored-but-unverified hash provides false security confidence. Surface the decision here: either implement verification or remove the column.

The hash may optionally be surfaced in the `GET /workspaces/:id/tasks/:taskId` response for client-side verification by the dash.

---

## 5. Feature Flag

`FORGE_SEQUENCES_ENABLED=true` is read from the hub's environment at startup. This is a **hub-side flag only** -- it is not propagated to daemons.

Behavior when flag is absent or `false`:
- `POST /workspaces/:id/tasks` with a `sequenceSpec` body field returns `422 Unprocessable Entity` with `{ error: "sequences_disabled" }`.
- All other endpoints behave normally (phase tasks that exist from a prior enabled period continue to be served).

---

## 6. API Changes

### 6.1 POST /workspaces/:id/tasks

**Auth: `requireWorkspaceMember(db, 'admin')` when `body.sequenceSpec` is present. Collaborator-level access for plain task creation is unchanged.**

Rationale: phase prompt content is delivered as the primary agent directive to potentially privileged agent roles (forge-master, scribe, etc.). Collaborator-level access to arbitrary role routing with arbitrary prompt content is equivalent to arbitrary agent command injection. Either enforce `admin` role at the middleware level for this path when `sequenceSpec` is present, or register a Heimdall action `task:create_sequenced` defaulting to `role:admin allow only`.

**New optional request fields:**

```typescript
sequenceSpec?: SequenceSpec   // triggers sequenced-task creation
dependsOn?: string[]          // task IDs in the same workspace
```

**Validation rules:**

1. If `sequenceSpec` is present and `FORGE_SEQUENCES_ENABLED` is falsy, return `422 { error: "sequences_disabled" }`.
2. Each phase in `sequenceSpec.phases` must have non-empty `title`, `role`, and `prompt`. Validated via Zod (`SequenceSpecSchema.parse`).
3. If `dependsOn` is present and non-empty:
   a. All IDs must exist in the same workspace. Missing IDs return `422 { error: "unknown_dep_ids", ids: [...] }`.
   b. No entry in `dependsOn` may reference a task where `phase_index IS NOT NULL` (dependency on a phase sub-task is invalid). Return `422 { error: "invalid_dep_phase_task" }`.
   c. All dep IDs must belong to the same workspace. A dep referencing a task in another workspace is rejected at creation. Return `422 { error: "invalid_dep_workspace" }`.
   d. The new task must not form a cycle with any existing `dependsOn` edges. Run DAG cycle check (see Section 7). Cycle detected returns `422 { error: "dep_cycle", cycle: [...] }`.
4. A task cannot list itself in `dependsOn`.

**Creation logic when `sequenceSpec` is provided:**

1. Compute `maxSeq` via the shared `getMaxRootSeq(db, prefix)` helper, which queries `tasks WHERE project_prefix = ? AND parent_id IS NULL` (skip phase children via `isNull(schema.tasks.parentId)` in Drizzle).
2. Assign root task ID normally (e.g. `fl-043`).
3. Serialize `sequenceSpec` to JSON, compute SHA-256 hash, store in `sequence_spec` and `sequence_spec_hash`.
4. Determine initial status:
   - If `dependsOn` contains IDs not yet in `{ completed, sequenced_complete }`: status = `waiting_on_deps`, set `blocked_reason = "waiting_on_deps"`. Do NOT create the phase 0 task; it will be created by the dep-unblocking pass once deps are satisfied.
   - Otherwise: proceed to phase 0 creation (step 5).
5. Check device availability for `phases[0].role` (H1): query `devices WHERE agent_id = ? AND last_seen > (now - staleTTL) AND status = 'active'`.
   - **If no active device found (role_unavailable):**
     - Create the phase 0 task immediately with `status = pending_agent`. The task will be claimed when a matching device comes online.
     - Set root `status = sequenced_running`, `blocked_reason = "role_unavailable:<role>"`.
     - Emit `task.phase_blocked` history event.
     - Return root task with `status = sequenced_running` and `blocked_reason` populated.
   - **If active device found:**
     - Set root `status = sequenced_running`.
     - Create phase 0 task with `status = pending_agent` (or `assigned` if device handoff is immediate).
6. Create phase 0 task:
   - ID: `formatPhaseTaskId(rootId, 0)` (e.g. `fl-043-p0`)
   - `parent_id`: root task ID
   - `phase_index`: 0
   - `assigned_agent_id`: `phases[0].role`
   - `title`: `phases[0].title`
   - `description`: `phases[0].prompt`
   - `status`: `pending_agent`
   - `depends_on`: `'[]'`
   - No `sequence` counter increment for phase tasks.
7. All inserts (root + phase 0) are executed in a single `libsql batch()` call.

**Sequence number counter exclusion:** The `maxSeq` query must use `WHERE parent_id IS NULL` (Drizzle: `isNull(schema.tasks.parentId)`) so that compound phase IDs (`fl-042-p0`) are never counted. This is enforced via the shared `getMaxRootSeq` helper.

### 6.2 POST /workspaces/:id/tasks/:taskId/complete (Key Endpoint)

**Phase task guard (flat device endpoint):** This endpoint is for root task completions by the FM. If `task.phase_index IS NOT NULL`, return immediately:

```json
{ "error": "use_phase_complete", "message": "Phase tasks must be completed via the workspace-scoped endpoint POST /workspaces/:id/tasks/:taskId/complete" }
```

Status: `409 Conflict`. This prevents devices from bypassing phase sequencing by calling the flat complete endpoint on a phase task.

**Optimistic-lock guard:** Add `WHERE id = :id AND status = 'in_progress'` to the completion UPDATE. If the `returning` set is empty, the task was not in `in_progress` -- but do NOT blindly return `already_completed`. Instead, perform a follow-up SELECT on `tasks WHERE id = :id` to read the current status and return the appropriate error code:
- `status = 'completed'` or `status = 'sequenced_complete'` -> `409 { error: "already_completed" }`
- `status = 'cancelled'` -> `409 { error: "task_cancelled" }`
- `status = 'failed'` -> `409 { error: "task_failed" }`
- Any other status (e.g. `assigned`, `pending_agent`) -> `409 { error: "invalid_transition", currentStatus: <status> }`
- Row not found -> `404 { error: "task_not_found" }`

This prevents double-complete races from causing an unhandled 500 from the UNIQUE index on `(parent_id, phase_index)` and gives callers actionable error codes.

**Updated request body:**

```typescript
{
  result?: string   // max 4000 chars, truncated server-side at 4000
}
```

### 6.3 POST /workspaces/:id/tasks/:taskId/complete (Workspace-Scoped, Key Endpoint)

**Requires: authenticated device. The requesting device's `assignedDeviceId` must match the phase task's `assignedDeviceId`. Unauthorized devices (device present but not assigned to this phase task) must receive `403 Forbidden` with `{ error: "device_not_assigned" }`. Unauthenticated requests receive `401`.**

**Optimistic-lock guard:** Add `WHERE id = :id AND status = 'in_progress'` to the UPDATE. If the returning set is empty, do NOT blindly return `already_completed`. Perform a follow-up SELECT on `tasks WHERE id = :id` to read the current status and return the appropriate error code: `already_completed` if already completed/sequenced_complete, `task_cancelled` if cancelled, `task_failed` if failed, `invalid_transition` with current status otherwise, or `404` if the row does not exist. (Same discriminated-error pattern as Section 6.2.)

**Phase transition logic** (when `FORGE_SEQUENCES_ENABLED` AND `task.phase_index IS NOT NULL` AND parent has `sequence_spec`):

1. Truncate `result` to 4000 chars.
2. Verify `sequence_spec_hash` integrity (see Section 4.6). Abort if mismatch.
3. Store `result` on the completing phase task.
4. Parse parent `sequence_spec` JSON. Wrap in try/catch; on JSON parse error, return `500 { error: "corrupt_sequence_spec" }`.
5. Compute `nextPhaseIndex = task.phase_index + 1`.
6. **If `nextPhaseIndex < phases.length` (advance to next phase):**
   a. Query `devices WHERE agent_id = nextPhase.role AND last_seen > (now - staleTTL) AND status = 'active'`. Note: `last_seen` comparisons must use integer milliseconds (`Date.now() - staleTtlMs`), not Date objects, to avoid ORM coercion mismatch.
   b. If no active device found:
      - Create the next phase task immediately with `status = pending_agent` (same as creation-time role_unavailable handling).
      - ATOMIC BATCH: update completing phase task to `completed`, insert next phase task with `status = pending_agent`, update root `blocked_reason = "role_unavailable:<nextPhase.role>"`, insert `task.phase_blocked` history event.
      - Return `200 { status: "phase_blocked", reason: "role_unavailable" }`.
      - Stop.
   c. Build `nextPhaseId = formatPhaseTaskId(parent.id, nextPhaseIndex)`.
   d. Build next phase description by calling `buildNextPhaseDescription(nextPhase.prompt, completingPhaseResult, task.phase_index)` where `task.phase_index` is the index of the completing phase task (passed as the explicit `completingPhaseIndex` parameter -- see Section 6.4 for the required injection format).
   e. ATOMIC BATCH (single `libsql batch()` call):
      - UPDATE completing phase task: `status = completed`, `result = <truncated result>`, `completed_at = now`.
      - INSERT next phase task: `id = nextPhaseId`, `parent_id = parent.id`, `phase_index = nextPhaseIndex`, `assigned_agent_id = nextPhase.role`, `title = nextPhase.title`, `description = <built description>`, `status = pending_agent`, `depends_on = '[]'`.
      - UPDATE root task: `status = sequenced_running`, `updated_at = now`.
      - INSERT `task_history`: `event_name = task.phase_advanced`, payload includes `fromPhase`, `toPhase`, `nextPhaseId`.
7. **If `nextPhaseIndex >= phases.length` (all phases done):**
   - ATOMIC BATCH:
     - UPDATE completing phase task: `status = completed`, `result = <truncated result>`, `completed_at = now`.
     - UPDATE root task: `status = sequenced_complete`, `result = <truncated result>`, `completed_at = now`.
     - INSERT `task_history`: `event_name = task.sequence_complete`.
   - After the batch commits, run the dependency unblocking pass using the **root task ID** as the `completingTaskId`. The root task reaching `sequenced_complete` (a terminal-success status) must trigger the same dep-unblocking pass as any other terminal-success transition, so any tasks waiting on this root are unblocked. This is mandatory: `sequenced_complete` is in `TERMINAL_SUCCESS_STATUSES` and the unblocking pass must be invoked with `completingTaskId = rootTask.id` immediately after the batch.

**Dependency unblocking (runs after ANY task completion, sequenced or not):**

After the above phase/sequencing logic completes, run the unblocking pass (see Section 7 for the full algorithm). Direct dependents of the just-completed task must be included in the same `libsql batch()` as the completion for atomicity. The full workspace rescan is a best-effort pass that runs after the batch commits.

**Practical cap:** The synchronous unblocking pass is capped at 50 tasks. If more than 50 `waiting_on_deps` tasks exist in the workspace, schedule an async follow-up sweep for the remainder.

**Dep unblocking branch:** When a task is unblocked and its `sequence_spec IS NOT NULL`, the unblocking pass must NOT set it to `pending_agent`. Instead, run the phase-0 creation logic (device availability check, phase 0 insert, root to `sequenced_running`). Only tasks without `sequence_spec` are set to `pending_agent` by the unblocking pass. See Section 7 for the branched algorithm.

### 6.4 Prior-Phase Output Injection (Security-Hardened)

The prior-phase result is UNTRUSTED content produced by a previous agent. It must be injected in a format that prevents it from being interpreted as instructions by the receiving agent.

**Required injection format:**

```typescript
function buildNextPhaseDescription(nextPhasePrompt: string, priorResult: string, completingPhaseIndex: number): string {
  // 1. Cap the prior result
  const capped = priorResult.slice(0, 2000);

  // 2. Normalize CRLF to LF
  const normalized = capped.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 3. Strip or escape XML tags within the raw result to prevent early tag-close attacks
  const escaped = normalized.replace(/<\/?prior_phase_output[^>]*>/gi, '[xml-tag-removed]');

  // 4. Prefix every resulting line (including blank lines) with '> '
  const blockquoted = escaped.split('\n').map(line => `> ${line}`).join('\n');

  // 5. Wrap in XML-attributed tags with trust annotation
  // completingPhaseIndex is passed explicitly as a parameter; do NOT reference task.phase_index here.
  const sandboxed = `<prior_phase_output source="phase-${completingPhaseIndex}" trust="untrusted">
${blockquoted}
</prior_phase_output>`;

  return `${nextPhasePrompt}\n\n${sandboxed}`;
}
```

**CRITICAL:** The content inside `<prior_phase_output>` must NOT be treated as instructions by the receiving agent. The `trust="untrusted"` attribute and the `> ` blockquote prefix together make the untrusted boundary explicit. Any content that looks like instructions inside the block is prior agent output and must be treated as read-only context only.

**Why XML tags over plain blockquotes:** Plain blockquote framing (`> [UNTRUSTED...]`) is not a security boundary. A prior agent result containing strategic newlines can break out of blockquote context, since Claude reads the full prompt sequentially. XML-attributed tags with a `trust` annotation provide a structured, unambiguous boundary that survives multiline content.

### 6.5 POST /workspaces/:id/tasks/:taskId/cancel

**Status guard:** Only tasks in `CANCELLABLE_STATUSES` may be cancelled. This now includes `sequenced_running` and `waiting_on_deps` (see Section 4.1 for the full constant).

**Additional logic for sequenced root tasks:**

After cancelling the root task, atomically cancel all non-terminal phase children. For each phase child that is cancelled by the cascade, the batch must also insert a `task_history` row with `event_name = 'task.phase_cancelled'` and payload `{ phaseIndex, reason: "parent_cancelled" }`. This must be in the same `libsql batch()` call as the root cancellation.

Concretely, the batch must:
1. UPDATE root task to `cancelled`.
2. For each non-terminal phase child (queried before building the batch): UPDATE `status = 'cancelled'` and INSERT `task_history (task_id = <phaseChildId>, event_name = 'task.phase_cancelled', payload = { phaseIndex: <child.phase_index>, reason: 'parent_cancelled' })`.

```sql
-- Step 2 per-child (repeated for each non-terminal phase child):
UPDATE tasks
SET status = 'cancelled', updated_at = <now>
WHERE id = :phaseChildId
  AND status NOT IN ('completed', 'sequenced_complete', 'failed', 'cancelled');

INSERT INTO task_history (task_id, event_name, payload, created_at)
VALUES (:phaseChildId, 'task.phase_cancelled', '{"phaseIndex":<N>,"reason":"parent_cancelled"}', <now>);
```

Do NOT use a single bulk UPDATE across all children if you need per-child history rows -- query children first, build per-child UPDATE + INSERT pairs, and include all of them in the single `libsql batch()` call.

### 6.6 GET /workspaces/:id/tasks

**Default behavior:** Add `WHERE parent_id IS NULL` to exclude phase children. This ensures stats, kanban, and task lists show only root tasks and plain FM subtasks by default.

**Query parameter:** `?includePhaseTasks=true` removes the `parent_id IS NULL` filter and returns all tasks including phase children. Intended for debugging and detail views only.

**Device-side filtering (flat GET /tasks):** Add `AND (phase_index IS NULL OR assigned_agent_id = :deviceAgentId)` to the flat GET /tasks endpoint so devices only see phase tasks intended for their own role. This eliminates wasted poll/claim cycles for non-matching roles.

**Response shape:** When `includePhaseTasks` is false (default), each returned task with a `sequence_spec` includes a derived `phases` array:

```typescript
phases: Array<{
  phaseIndex: number;
  taskId?: string;       // present if phase task has been created; undefined otherwise (not null)
  title: string;
  role: string;
  status: PhaseStatus;   // derived: pending | active | complete | failed
  result?: string;       // present if phase is complete
}>
```

Phase status derivation:
- Phase task exists with `status = completed` -> `complete`
- Phase task exists with `status = failed` -> `failed`; **this phase is also auto-expanded in the task detail timeline** (see Section 9.7)
- Phase task exists with `status` in `{pending_agent, assigned, in_progress}` -> `active`
- Phase task does not exist yet -> `pending`

**Single-task GET response:** `GET /workspaces/:id/tasks/:taskId` must include:
- `phases?: HubPhaseResponse[]` -- derived phases array as above
- `dependsOn?: string[]` -- raw deps array from the DB column
- `blockedReason?: string | null` -- from the DB column
- `sequenceSpec?: unknown | null` -- from the DB column (parsed JSON or null)
- `dependents?: { id: string; title: string; status: string }[]` -- reverse deps, derived server-side:

```sql
SELECT id, title, status FROM tasks
WHERE workspace_id = :workspaceId
  AND depends_on LIKE '%' || :taskId || '%'
```

This query is an approximation; filter client-side to confirm the `taskId` actually appears in the parsed JSON array. If this derivation is deferred to v2, **remove the Blocking section from Section 9.8 explicitly** rather than leaving it as an unimplemented UI spec.

### 6.7 Stats Endpoint

All counters on the stats endpoint must exclude phase tasks. The correct filter is `WHERE parent_id IS NULL` (not `phase_index IS NULL`), because `parent_id IS NULL` excludes phase tasks while `phase_index IS NULL` would also include plain FM subtasks (which have no phase_index but do have a parent_id in some configurations). Choose `parent_id IS NULL` for root-task-only counts and document this choice explicitly.

The workspace context endpoint (`GET /workspaces/:id/context`) must also include a `waitingTasks` count field:

```sql
SELECT COUNT(*) as waitingTasks
FROM tasks
WHERE workspace_id = :id
  AND status = 'waiting_on_deps'
  AND phase_index IS NULL
```

This is cheap given the partial index `tasks_waiting_deps_idx` defined in migration 0016. FM can observe how many tasks are blocked and why without scanning the full task list.

The `queueDepth` pendingAgentTasks query in the context endpoint must add `AND phase_index IS NULL` to prevent phase tasks from double-counting alongside root tasks in FM's bottleneck detection.

### 6.8 Standard Retry

If `task.sequence_spec IS NOT NULL`: return `409 Conflict` with:

```json
{ "error": "use_phase_retry", "message": "Sequenced tasks must be retried via POST /workspaces/:id/tasks/:taskId/phases/:phaseIndex/retry" }
```

**Guard:** A sequenced root task (`sequence_spec IS NOT NULL`) must never be completable via `POST /tasks/:id/complete` (flat endpoint). Return `409` immediately if `task.sequence_spec IS NOT NULL` on the flat complete endpoint. This prevents FM from accidentally closing out a sequenced root without going through the phase mechanism.

### 6.9 NEW: POST /workspaces/:id/tasks/:taskId/phases/:phaseIndex/retry

**Auth: `requireWorkspaceMember(db, 'collaborator')` -- same as /cancel and /retry.**

Retries a specific failed phase without resetting the entire sequence.

**URL parameter validation:** `phaseIndex` must be parsed as a non-negative integer (i.e. `Number.isInteger(n) && n >= 0`). It must also be validated as `< phases.length` (read from the root task's `sequence_spec`). Return `400 { error: "invalid_phase_index" }` if the value is not a non-negative integer or if it is out of range.

**Preconditions:**
- Root task must have `sequence_spec IS NOT NULL`.
- Target phase task (`parent_id = taskId AND phase_index = phaseIndex`) must exist with `status = failed`.

**Logic (atomic batch):**
1. UPDATE phase task: `status = pending_agent`, `result = NULL`, `updated_at = now`.
2. UPDATE root task: `status = sequenced_running`, `blocked_reason = NULL`, `updated_at = now`.
3. INSERT `task_history`: `event_name = task.phase_retried`, payload includes `phaseIndex`.

**Errors:**
- `404` if root task or phase task not found.
- `409` if phase task is not in `failed` status.

### 6.10 Stale-Assigned Requeue

The stale-assigned detection query (`GET /stale-assigned`) and the requeue UPDATE (`POST /stale-assigned/requeue`) must both filter out phase tasks:

```sql
-- Detection: only flag stale root tasks (or plain FM subtasks), not phase tasks
SELECT id, status, assigned_device_id FROM tasks
WHERE status = 'assigned'
  AND phase_index IS NULL     -- exclude phase tasks
  AND last_seen < (now - staleTtlMs)

-- Requeue: only requeue non-phase tasks
UPDATE tasks
SET status = 'pending_dispatcher_action', assigned_device_id = NULL, updated_at = now
WHERE id IN (:staleIds)
  AND phase_index IS NULL     -- safety guard
```

**Stale phase task path:** When a phase task is detected as stale-assigned (separately from the root requeue path), reset the stale **phase task** (child) to `status = pending_agent` so it can be re-claimed by the correct role. The root task must remain in `sequenced_running` with `blocked_reason = "stale_phase:<phaseIndex>"`. Do NOT set the root task to `pending_agent` -- that would allow FM to re-assign the sequenced root as a non-sequenced task, bypassing the phase mechanism. Emit a `task.phase_blocked` history event on the root task. FM must never see phase tasks in its queue (see Section 6.11).

### 6.11 Workspace Context / FM Inbox

The FM inbox query (workspace context endpoint used by Forge Master) must exclude phase tasks:

```sql
WHERE phase_index IS NULL
```

Phase tasks are pre-assigned by `assigned_agent_id` to specific non-FM roles. FM must never see them in its inbox.

**FM re-triage guard for role_unavailable roots:** A sequenced root task in `sequenced_running` or `pending_agent` with `blocked_reason IS NOT NULL` and `sequence_spec IS NOT NULL` must be filtered from FM's inbox. FM must never assign a role_unavailable sequenced root to a generic worker.

The FM inbox query must include the following filter predicates (in addition to the existing `phase_index IS NULL` exclusion):

```sql
-- Exclude all phase tasks (pre-existing requirement)
AND phase_index IS NULL

-- Exclude sequenced root tasks that are in sequenced_running (not available for FM re-assignment)
AND NOT (sequence_spec IS NOT NULL AND status = 'sequenced_running')
```

In Drizzle notation:
```typescript
.where(
  and(
    isNull(tasks.phaseIndex),
    not(and(isNotNull(tasks.sequenceSpec), eq(tasks.status, 'sequenced_running'))),
    // ... other existing filters ...
  )
)
```

These predicates must be applied at the query level, not in application-layer triage logic, to prevent race conditions where a task is fetched and then skipped after the round-trip.

### 6.12 Cancelled/Failed Dependency Handling

When a dependency task transitions to `cancelled` or `failed`, its dependents must not be left permanently stuck. The unblocking pass runs after `task.failed` events in addition to `task.completed` events.

**Semantic for cancelled/failed deps (Option A -- chosen):**

A dep that transitions to `cancelled` or `failed` propagates to its dependents: update waiting task `blocked_reason = 'dep_cancelled:<depId>'` or `'dep_failed:<depId>'` and emit a `task.dep_failed` history event on the waiting task. The waiting task remains in `waiting_on_deps` with an updated `blocked_reason` so an operator can observe the blockage. In v1, an operator must cancel the waiting task or directly update its status via admin tools to resolve the blockage (see the note on `PATCH /workspaces/:id/tasks/:taskId/deps` below).

This semantic must be implemented consistently across the unblocking pass, the cancel endpoint cascade, and the fail endpoint cascade. Add test T15b (see Section 10).

**`PATCH /workspaces/:id/tasks/:taskId/deps` -- OUT OF SCOPE FOR v1.** This endpoint is deferred to v2. In v1, a task with `dep_failed` or `dep_cancelled` status requires manual intervention: an operator must cancel the waiting task or directly update its status via admin tools. Do not implement or reference this endpoint in v1 code.

---

## 7. Dependency Graph

### DAG Validation Algorithm (at task creation)

Runs when `dependsOn` is non-empty.

**Validation pre-checks (before DAG traversal):**
1. No entry in `dependsOn` may reference a phase task (`phase_index IS NOT NULL`). Return `422 { error: "invalid_dep_phase_task" }`.
2. All dep IDs must exist in the same workspace. Return `422 { error: "invalid_dep_workspace" }` for any cross-workspace reference.
3. `dependsOn` JSON must be parsed with try/catch; on parse error return `422 { error: "invalid_dep_format" }`.

```
Input: newTaskId, dependsOn[], all existing tasks in workspace (id + dependsOn)

1. Build adjacency map: taskId -> Set<taskId> from existing tasks' depends_on
2. Add entry: newTaskId -> Set(dependsOn)
3. DFS from newTaskId:
   - Track visited = Set<taskId>, recursionStack = Set<taskId>
   - For each neighbor in adjacency[current]:
       - If neighbor in recursionStack: CYCLE DETECTED, collect cycle path, return error
       - If neighbor not in visited: recurse
4. If any back-edge found: reject with 422
   - Response: { "error": "dep_cycle", "cycle": ["fl-043", "fl-041", "fl-043"] }
5. Also check: newTaskId must not appear in its own dependsOn (self-dependency)
```

**3-node cycle example (concrete):**
- Create A (no deps) -> `fl-001`
- Create B with `dependsOn: ["fl-001"]` -> `fl-002`
- Now attempt to create C with `dependsOn: ["fl-002"]` where we also want A to depend on C (which would form a cycle A->B->C->A).
- Since A is already created and its `dependsOn` is immutable post-creation, the cycle can only be introduced by the new task's own `dependsOn` entries.
- To trigger cycle detection: create A (`fl-001`, dependsOn:[]), create B (`fl-002`, dependsOn:[fl-001]), create C (`fl-003`, dependsOn:[fl-002]). Then attempt to create a new task D with `dependsOn: ["fl-003", "fl-001"]` -- this is valid (no cycle, just a diamond). A true cycle requires creating a task whose `dependsOn` references a task that already transitively depends on the new task's ID, which is not possible for a new task ID unless the caller submits a `dependsOn` array that already contains the new task's not-yet-assigned ID (a self-cycle) or references a pre-existing cycle in the graph.
- Practical cycle scenario: the hub must detect existing cycles introduced by concurrent creation races. The DFS traversal covers all existing edges, so if tasks A->B->A already exist (e.g. due to a race bypassing validation), creating any task with `dependsOn: [A]` or `dependsOn: [B]` will detect the cycle.

The DFS is constrained to the workspace's task graph. Worst case is O(V+E) where V = task count and E = total dependency edges. For typical workspaces (hundreds of tasks), this is fast enough to run synchronously.

### Unblocking Algorithm (branched, at any task completion OR failure)

Runs after every `POST /tasks/:id/complete` or `POST /tasks/:id/fail` (including sequenced-phase completions):

```
1. TERMINAL_SUCCESS = { 'completed', 'sequenced_complete' }
2. blocked_tasks = SELECT * FROM tasks
     WHERE workspace_id = :workspaceId
       AND status = 'waiting_on_deps'
     LIMIT 50    -- synchronous cap; schedule async sweep for remainder
3. For each blocked_task:
     deps_raw = blocked_task.depends_on
     try {
       deps = z.array(z.string()).parse(JSON.parse(deps_raw))
     } catch (e) {
       log.error('unblocking-pass: corrupt depends_on on task', blocked_task.id, e)
       continue   // skip this task; do not crash the pass
     }
     dep_statuses = SELECT id, status FROM tasks
       WHERE id IN (deps)
         AND workspace_id = :workspaceId    // workspace isolation guard
     // Any dep ID that does not match the workspace is treated as invalid
     invalid_deps = deps.filter(id => !dep_statuses.has(id))
     if invalid_deps.length > 0:
       UPDATE tasks SET blocked_reason = 'invalid_dep_workspace' WHERE id = blocked_task.id
       continue
     all_met = deps.every(depId => TERMINAL_SUCCESS.has(dep_statuses.get(depId)))
     if all_met:
       // BRANCH: does this task have a sequence_spec?
       if blocked_task.sequence_spec IS NOT NULL:
         // Run the phase-0 creation logic (same as Section 6.1 step 5-7)
         // 1. Check device availability for phases[0].role
         // 2. Create phase 0 task (even if role_unavailable -- create with pending_agent)
         // 3. UPDATE root: status = sequenced_running, blocked_reason = NULL
         // 4. Emit task.phase_started or task.deps_cleared history event
         // Include in the same libsql batch() as the completion of the triggering task
       else:
         // Plain task: just unblock it
         UPDATE tasks SET status = 'pending_agent', blocked_reason = NULL
           WHERE id = blocked_task.id
         INSERT task_history (event_name = 'task.deps_cleared')
```

**Direct-dependent inclusion:** The direct dependents of the completing task must be included in the same `libsql batch()` as the completion transaction. The full workspace rescan above is a best-effort pass that runs after the batch commits.

**Startup sweep:** On hub initialization, run the unblocking pass once for all `waiting_on_deps` tasks across all workspaces. This recovers any tasks that were stuck due to a crash between the completion batch and the unblocking pass.

**Invariants:**
- Cancelled or failed deps do NOT satisfy the `TERMINAL_SUCCESS` condition.
- When a dep transitions to `cancelled` or `failed`, update waiting task `blocked_reason` and emit `task.dep_failed` history event (see Section 6.12).
- JSON parse errors in `depends_on` are logged and skipped; they do not crash the pass.
- Cross-workspace dep references are treated as invalid and update `blocked_reason` accordingly.

---

## 8. Daemon Changes

### Scribe Listener Filter

In `packages/forge-daemon/src/scribe.ts` (or equivalent), the Scribe listener evaluates completed tasks to decide whether to generate documentation. Add a guard:

```typescript
if (task.phase_index !== null && task.phase_index !== undefined) {
  // Phase task completion -- not a standalone deliverable. Skip Scribe.
  return;
}
```

Only root task completions (with `phase_index IS NULL`) should trigger Scribe docs. Phase completions are intermediate steps and should not generate independent documentation artifacts.

---

## 9. Dash Changes

### 9.1 Status Display Config (task-list.tsx)

Add `STATUS_META` entries for the three new statuses:

```typescript
sequenced_running:  { label: 'sequenced running',  color: '#a78bfa' },  // purple-400
sequenced_complete: { label: 'sequenced complete',  color: '#22c55e' },  // green-500
waiting_on_deps:    { label: 'Waiting on Deps',     color: '#f59e0b' },  // amber-400
```

Note: labels must follow the existing underscore-to-space convention (title case). Do NOT use custom labels like `'Seq. Complete'` or abbreviated labels like `'waiting'` that diverge from the established pattern. The `waiting_on_deps` label is `'Waiting on Deps'` (title case, three words) -- NOT `'waiting'`, which would be inconsistent with the convention. The existing `statusLabel()` function produces labels by replacing `_` with space and title-casing; STATUS_META overrides must match this style.

### 9.2 HubTask Type (packages/forge-dash-community/src/lib/hub.ts)

Update the `HubTask` type and `TaskStatus` union to include all new fields. Without this the dash will not compile and `canCancel`/`canRetry` guards will silently misclassify sequenced tasks:

```typescript
// Add to TaskStatus union
export type TaskStatus =
  | 'pending_design'
  | 'design_review'
  | 'pending_agent'
  | 'assigned'
  | 'in_progress'
  | 'pending_dispatcher_action'
  | 'sequenced_running'    // NEW
  | 'sequenced_complete'   // NEW
  | 'waiting_on_deps'      // NEW
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface HubPhaseResponse {
  phaseIndex: number;
  taskId?: string;         // undefined before phase task is created
  title: string;
  role: string;
  status: 'pending' | 'active' | 'complete' | 'failed';
  result?: string;
}

// Add to HubTask interface
export interface HubTask {
  // ... existing fields ...
  phases?: HubPhaseResponse[];
  dependsOn?: string[];
  blockedReason?: string | null;
  sequenceSpec?: unknown | null;
  dependents?: { id: string; title: string; status: string }[];
}
```

**Update `canCancel`:**
```typescript
export function canCancel(task: HubTask): boolean {
  return ['pending_agent', 'assigned', 'in_progress', 'pending_dispatcher_action',
          'sequenced_running', 'waiting_on_deps'].includes(task.status);
}
```

**Update `canRetry`:**
```typescript
export function canRetry(task: HubTask): boolean {
  // sequenced_complete is terminal-success, not retryable
  return task.status === 'failed' && task.sequenceSpec == null;
}
```

### 9.3 KANBAN_COLS (goal-kanban.tsx)

Add a dedicated **Blocked** column between Pending and Active for `waiting_on_deps`:

```typescript
const KANBAN_COLS = [
  { key: 'pending',   label: 'Pending',  fill: 'rgba(...)',   edge: '#...',    statuses: ['pending_agent', 'pending_dispatcher_action'] },
  { key: 'blocked',   label: 'Blocked',  fill: 'rgba(245,158,11,0.15)', edge: '#f59e0b', statuses: ['waiting_on_deps'] },  // NEW
  { key: 'active',    label: 'Active',   fill: 'rgba(...)',   edge: '#...',    statuses: ['assigned', 'in_progress', 'sequenced_running'] },
  { key: 'done',      label: 'Done',     fill: 'rgba(...)',   edge: '#...',    statuses: ['completed', 'sequenced_complete'] },
  // ... other existing cols ...
];
```

Update the GRID CSS template from `repeat(4, ...)` to `repeat(5, ...)` to accommodate the new column.

Confirm `sequenced_complete` is included in the `completionPct` done count alongside `completed`.

Do NOT add `PhaseStepper` to kanban card spec. The `GoalKanban` in `goal-kanban.tsx` is a count-and-bar layout per goal row, not a card-per-task kanban. `PhaseStepper` applies only to task-list.tsx card rows.

### 9.4 New: PhaseStepper Component (src/components/phase-stepper.tsx)

```typescript
interface PhaseStepperProps {
  phases: HubPhaseResponse[];
  currentPhaseIndex: number;
}
```

Renders a compact row of pip dots (one per phase) with a label "Phase N of M". Styling:
- Complete phase: filled green dot
- Active phase: pulsing purple dot
- Failed phase: filled red dot
- Pending phase: hollow gray dot

Tailwind classes example: `w-2.5 h-2.5 rounded-full` with appropriate color classes. Label: `text-xs text-muted-foreground ml-2`.

### 9.5 Task List Cards: Add PhaseStepper

In the task list card renderer, when `task.phases && task.phases.length > 0`, render `<PhaseStepper>` below the task title/status row.

### 9.6 task-list-with-panel.tsx: Fix hasAgentLog

Current behavior: `hasAgentLog` returns true for tasks with a device, opening the side panel.

**Fix:** Use `task.sequenceSpec != null` as the primary gate (not `task.phases?.length > 0`). When `sequenceSpec` is non-null, the task is sequenced and must never open the agent-log side panel:

```typescript
function hasAgentLog(task: HubTask): boolean {
  // Sequenced tasks always use the full detail view (phase timeline).
  // task.phases may be empty during role_unavailable blocked state even
  // though sequenceSpec is non-null, so phases.length check is insufficient here.
  if (task.sequenceSpec != null) return false;
  // ... existing logic for non-sequenced tasks ...
}
```

Retain `phases.length` check only for `PhaseStepper` rendering (the stepper only renders when phases data is available).

Sequenced root tasks do not have an `assignedDeviceId` themselves (devices are on phase children), so the panel would show nothing useful.

### 9.6a Task Detail: Use Workspace-Scoped Endpoint

The task detail page **must** fetch task data from `GET /workspaces/:id/tasks/:taskId` (workspace-scoped), not from the flat `GET /tasks/:taskId` endpoint. The flat endpoint does not include `phases`, `dependsOn`, `dependents`, `blockedReason`, or `sequenceSpec`. All task detail views that need to render phase timelines, dependency sections, or blocked-reason banners must use the workspace-scoped endpoint exclusively.

The workspace-scoped `GET /workspaces/:id/tasks/:taskId` response must include all of the following new fields:
- `phases?: HubPhaseResponse[]` -- derived phases array
- `dependsOn?: string[]` -- raw dep IDs from the DB column
- `dependents?: { id: string; title: string; status: string }[]` -- reverse deps derived server-side
- `blockedReason?: string | null` -- from the DB column
- `sequenceSpec?: unknown | null` -- parsed JSON or null

The dash must never call the flat `GET /tasks/:taskId` endpoint for task detail rendering. Update any existing detail-fetch calls accordingly.

### 9.7 Task Detail: Phase Timeline Section

Render when `task.phases && task.phases.length > 0`. Display as a vertical timeline list:

Each phase card shows:
- Phase index + title (e.g. "Phase 0: Architecture Review")
- Agent role badge
- Status badge (derived `PhaseStatus`)
- Result output: rendered in a `<details>/<summary>` collapsed by default.
  - **Auto-expanded if the phase is active (status = 'active') OR failed (status = 'failed').**
  - All other phases default to collapsed.
- Link to phase child task detail (when `taskId` is present on the phase response).

### 9.8 Task Detail: Dependency Display

**Depends on:** When `task.dependsOn && task.dependsOn.length > 0`, render a "Depends on" section listing each dep as a linked task ID chip (clickable, navigates to that task's detail). Show the dep task's current status badge.

**Blocking:** When `task.dependents && task.dependents.length > 0`, render a "Blocking" section listing each dependent task. Data comes from the `dependents` field in the single-task GET response (see Section 6.6). If `dependents` is not yet implemented server-side, **do not render this section** -- remove it from the UI spec rather than leaving it as dead code.

**Blocked reason banner:** When `task.blockedReason` is set, render a top-of-detail amber warning banner using the `blockedReasonToMessage` helper:

```typescript
function blockedReasonToMessage(reason: string): string {
  if (reason === 'waiting_on_deps') {
    return 'Waiting for dependent tasks to complete.';
  }
  if (reason.startsWith('role_unavailable:')) {
    const role = reason.slice('role_unavailable:'.length);
    return `Waiting for an active ${role} agent to come online.`;
  }
  if (reason.startsWith('dep_cancelled:')) {
    const depId = reason.slice('dep_cancelled:'.length);
    return `A required dependency (${depId}) was cancelled. Contact an admin to resolve.`;
  }
  if (reason.startsWith('dep_failed:')) {
    const depId = reason.slice('dep_failed:'.length);
    return `A required dependency (${depId}) failed. Contact an admin to resolve.`;
  }
  if (reason === 'invalid_dep_workspace') {
    return 'A dependency references a task in another workspace. Contact an admin.';
  }
  // Unknown reason: surface raw string with a console warning
  console.warn('blockedReasonToMessage: unknown reason', reason);
  return reason;
}
```

---

## 10. Test Plan (Required Before Merge)

The following test cases must all pass before this feature may be merged. Tests should use the existing vitest + integration test harness with an in-memory libsql database.

### Phase Sequencing Tests

**T01 - Happy path, 2-phase sequence:**
Create a 2-phase task with `sequenceSpec`. Verify root status = `sequenced_running`, phase 0 task created with `status = pending_agent`, phase 1 task does not exist.

**T02 - Phase 0 complete, phase 1 created:**
Complete phase 0 with a `result`. Verify: phase 0 `status = completed`, phase 1 created with description containing sandboxed prior output wrapped in `<prior_phase_output trust="untrusted">` tags, root still `sequenced_running`.

**T03 - Phase 1 complete, sequence done:**
Complete phase 1. Verify: phase 1 `status = completed`, root `status = sequenced_complete`, root `result` = phase 1 result.

**T04 - Phase transition is atomic:**
Simulate a failure mid-batch (mock libsql client to throw after first statement). Verify: no partial state -- neither the completing phase update nor the next phase insert persists.

**T05 - Prior output injection is capped and sandboxed:**
Complete phase 0 with a result of 3000 chars. Verify the next phase description contains `<prior_phase_output trust="untrusted">` and the injected portion is <= 2000 chars.

**T05b - Prior output injection escapes XML tags:**
Complete phase 0 with a result containing `</prior_phase_output>` in the text. Verify the injected block replaces the tag with `[xml-tag-removed]` and does not close the wrapper tag early.

**T05c - Prior output injection normalizes CRLF:**
Complete phase 0 with a result containing CRLF line endings. Verify all line endings in the injected block are LF only and every line (including blank lines) is prefixed with `> `.

**T06 - role_unavailable creates phase task immediately:**
Create a 2-phase task. Mock `devices` query for phase 0 role to return empty. Verify: root `status = sequenced_running`, `blocked_reason = "role_unavailable:<role>"`, phase 0 task exists with `status = pending_agent`, `task.phase_blocked` event emitted.

**T07 - Phase retry resets failed phase:**
Fail a phase task. Call `POST .../phases/0/retry`. Verify: phase task `status = pending_agent`, `result = NULL`, root `status = sequenced_running`, `blocked_reason = null`.

**T08 - Cancel cascades to phase children:**
Create a 2-phase task (phase 0 active, phase 1 not yet created). Cancel root. Verify: root `status = cancelled`, phase 0 `status = cancelled`.

**T09 - Phase tasks excluded from FM inbox:**
Create a sequenced task (phase 0 active). Verify phase 0 does not appear in the FM inbox query (workspace context endpoint task list).

**T10 - Standard retry on sequenced root returns 409:**
Attempt `POST .../retry` on a sequenced root task (any `sequence_spec IS NOT NULL`). Verify `409` with `{ error: "use_phase_retry" }`.

**T11 - Flat complete on phase task returns 409:**
Claim a phase task via a device, then call the flat `POST /tasks/:id/complete` endpoint. Verify `409 { error: "use_phase_complete" }`.

**T12 - Double-complete returns 409 not 500:**
Complete a phase task successfully. Attempt to complete the same task again. Verify `409 { error: "already_completed" }` (not 500 from the UNIQUE index).

**T13 - sequenced_running and waiting_on_deps are cancellable:**
Create a sequenced task (`status = sequenced_running`). Cancel it. Verify `status = cancelled`. Create a dep-blocked task (`status = waiting_on_deps`). Cancel it. Verify `status = cancelled`.

**T14 - maxSeq scan excludes phase IDs:**
Create a sequenced task (root `fl-001`, phase `fl-001-p0`). Create another sequenced task. Verify its root ID is `fl-002` (not `fl-001-p0-something`).

**T15 - Stale-assigned requeue skips phase tasks:**
Create a sequenced task. Mark phase 0 as stale-assigned. Trigger the stale-assigned requeue. Verify root remains `sequenced_running`, phase task is not moved to `pending_dispatcher_action`.

**T16 - FM re-triage of role_unavailable root does not assign to generic worker:**
Create a sequenced task where the role is unavailable. Verify the root (with `blocked_reason = role_unavailable:*`) does NOT appear in FM's inbox or is skipped during FM triage.

### Dependency Graph Tests

**T17 - Task creation with dependsOn, unmet deps -> waiting_on_deps:**
Create task A and task B with `dependsOn: [A.id]`. Verify B `status = waiting_on_deps`.

**T18 - Task completion unblocks dependent:**
Complete task A. Verify task B `status = pending_agent`, `blocked_reason = null`.

**T19 - Unblocked sequenced task runs phase-0 creation logic:**
Create sequenced task B with `dependsOn: [A.id]`. Complete task A. Verify B transitions to `sequenced_running` (not `pending_agent`) and phase 0 is created.

**T20 - Cycle detection rejects creation (3-node transitive):**
Create A (`fl-001`, no deps). Create B (`fl-002`, dependsOn:[fl-001]). Attempt to create C with `dependsOn: ["fl-002"]`. Then attempt to create a task that would introduce a cycle (e.g. attempt to create a task D with `dependsOn: ["fl-003"]` where fl-003 already has fl-004 as a dep and fl-004 points back). Verify `422 { error: "dep_cycle" }` is returned. Concrete minimal case: create a task where `dependsOn` contains the new task's own (not-yet-assigned) ID -- this is a self-cycle; verify `422 { error: "dep_cycle" }`.

**T21 - Unknown dep ID returns 422:**
Create task with `dependsOn: ["fl-999"]` in a workspace that has no such task. Verify `422 { error: "unknown_dep_ids" }`.

**T22 - Cancelled dep does not unblock waiting task; updates blocked_reason:**
Create A, B where B depends on A. Cancel A. Verify B remains `waiting_on_deps` with `blocked_reason = 'dep_cancelled:<A.id>'`. Verify `task.dep_failed` history event emitted on B.

**T23 - Failed dep does not unblock waiting task; updates blocked_reason:**
Create A, B where B depends on A. Fail A. Verify B remains `waiting_on_deps` with `blocked_reason = 'dep_failed:<A.id>'`. Verify `task.dep_failed` history event emitted on B.

**T24 - Stats exclude phase tasks:**
Create a 2-phase sequenced task. Verify the stats endpoint counts show 1 task (the root), not 2 (not counting phase child).

**T25 - dependsOn phase task ID returns 422:**
Attempt to create task C with `dependsOn: ["fl-001-p0"]`. Verify `422 { error: "invalid_dep_phase_task" }`.

**T26 - dep referencing another workspace task returns 422:**
Attempt to create task with `dependsOn` containing a valid task ID from a different workspace. Verify `422 { error: "invalid_dep_workspace" }` at creation time. Verify the dep does not unblock the task at completion.

**T27 - Direct deps included in same batch as completion:**
Mock the libsql client to capture batch statements. Complete task A where task B depends on A. Verify B's status update is included in the same batch call as A's completion.

---

## 11. Migration 0016 SQL

This is the next migration after `0015_review_tasks`. It runs as part of the existing `runMigrations` function in `packages/forge-hub/src/db/migrate.ts`.

Add the following entry to the `MIGRATIONS` array:

```typescript
{
  name: '0016_task_sequencing',
  sql: `
-- Task Sequencing + Dependency Graph (v2)
-- Adds phase sequencing columns, dependency graph, blocked_reason, and result.
-- Phase tasks share the tasks table; distinguished by phase_index IS NOT NULL.
-- No new tables required.

-- sequence_spec: JSON-encoded SequenceSpec for sequenced root tasks.
ALTER TABLE tasks ADD COLUMN sequence_spec TEXT;

-- sequence_spec_hash: SHA-256 of sequence_spec JSON for integrity auditing.
-- See design doc Section 4.6 for verification contract.
ALTER TABLE tasks ADD COLUMN sequence_spec_hash TEXT;

-- phase_index: 0-based index in the parent's phase array. NULL = not a phase task.
ALTER TABLE tasks ADD COLUMN phase_index INTEGER;

-- result: Freeform completion output from the agent. Capped at 4000 chars by API.
ALTER TABLE tasks ADD COLUMN result TEXT;

-- depends_on: JSON array of task ID strings this task is waiting on.
-- json_valid() CHECK constraint cannot be added via ALTER TABLE in SQLite;
-- enforced at the application layer (see design doc Section 4.4).
ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';

-- blocked_reason: Human-readable reason why this task is blocked.
-- Examples: "role_unavailable:Anvil", "waiting_on_deps", "dep_failed:fl-001"
ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;

-- Prevent duplicate phase rows for the same parent+index combination.
-- Also serves as defense-in-depth against double-complete races.
CREATE UNIQUE INDEX tasks_parent_phase_idx
  ON tasks(parent_id, phase_index)
  WHERE phase_index IS NOT NULL;

-- Fast lookup: find all waiting tasks in a workspace (unblocking pass).
CREATE INDEX tasks_waiting_deps_idx
  ON tasks(workspace_id, status)
  WHERE status = 'waiting_on_deps';

-- Fast device availability lookup for role routing.
-- last_seen comparisons must use integer milliseconds (Date.now() - staleTtlMs),
-- not Date objects, to avoid ORM coercion mismatch.
CREATE INDEX devices_agent_status_idx
  ON devices(agent_id, status, last_seen)
  WHERE agent_id IS NOT NULL;
`,
},
```

**Important:** The libsql migration runner executes each statement individually (split on `;`), so `ALTER TABLE` and `CREATE INDEX` statements in the same migration are safe. The runner already handles this correctly in the `splitStatements` function.

**Rollback:** There is no automated rollback. If the migration must be reversed, the following manual SQL drops the added columns and index (requires SQLite 3.35.0+):

```sql
-- Manual rollback only -- not run automatically
ALTER TABLE tasks DROP COLUMN sequence_spec;
ALTER TABLE tasks DROP COLUMN sequence_spec_hash;
ALTER TABLE tasks DROP COLUMN phase_index;
ALTER TABLE tasks DROP COLUMN result;
ALTER TABLE tasks DROP COLUMN depends_on;
ALTER TABLE tasks DROP COLUMN blocked_reason;
DROP INDEX IF EXISTS tasks_parent_phase_idx;
DROP INDEX IF EXISTS tasks_waiting_deps_idx;
DROP INDEX IF EXISTS devices_agent_status_idx;
```
