# Task Lifecycle Management Enhancements

**Date**: 2026-05-27  
**Status**: Draft  
**Author**: Architect  
**Reviewed by**: TBD

---

## Overview

This document covers three gaps in the forge-hub task lifecycle:

1. **Cancel**: dedicated endpoint replacing the current general PATCH path, with proper in-progress signal propagation to running daemons
2. **Retry**: dedicated endpoint that resets failed tasks to `pending_dispatcher_action` (FM triage) instead of `pending_agent` (raw queue)
3. **Reassign**: new user-session path on the existing assign endpoint, allowing dashboard operators to reroute tasks stuck in `pending_agent`

It also covers one missing wire-up: `task.cancelled` is absent from the `TASK_EVENTS` constant in the dash SSE hook.

### What already exists vs what is new

**Already exists (PATCH /workspaces/:workspaceId/tasks/:taskId)**

The general PATCH endpoint already handles:
- Cancel via `{ status: 'cancelled' }` (works from `pending_agent`, `pending_design`, `design_review`, `assigned`, `in_progress`)
- Retry to `pending_agent` via `{ status: 'pending_agent' }` (works from `failed` or `cancelled`)

**Genuinely new in this design**

- Cancel from `pending_dispatcher_action` (currently missing from `USER_ALLOWED_TRANSITIONS` in `tasks.ts`; see section 1.2)
- Retry to `pending_dispatcher_action` (FM re-route): new endpoint `POST /workspaces/:workspaceId/tasks/:taskId/retry`
- `task.cancelled` added to `TASK_EVENTS` constant (confirmed bug: hub emits the event but the dashboard ignores it)
- User-session path on the existing assign endpoint: extend `PATCH /workspaces/:workspaceId/tasks/:taskId/assign`
- Cancel confirmation UI with reason input and in-progress warning text
- Retry-to-FM UI button on the task detail page
- Reassign dropdown UI for workspace members

### Current state summary

| Feature | Hub endpoint | Dash UI | SSE event |
|---|---|---|---|
| Cancel | `PATCH /workspaces/:workspaceId/tasks/:taskId` (general) | TaskActionButton (cancel) | `task.cancelled` emitted but not in TASK_EVENTS |
| Retry (->pending_agent) | `PATCH /workspaces/:workspaceId/tasks/:taskId` (general) | TaskActionButton (retry) | `task.requeued` (wired correctly) |
| Retry (->pending_dispatcher_action) | Not implemented | Not implemented | n/a |
| Reassign | Orchestrator device only | Not implemented | `task.assigned` emitted but no user path |
| In-progress cancellation signal | `POST /tasks/:taskId/instructions` (priority: stop) | Not wired to cancel flow | n/a |

The general PATCH handles cancel and retry-to-pending_agent today. This design adds:

- Dedicated POST endpoints for cancel and retry (cleaner semantics, purpose-specific bodies, correct retry destination)
- A user-session gate on the existing assign endpoint
- Automatic `stop` instruction insertion on cancel of in-progress tasks
- `task.cancelled` added to `TASK_EVENTS`

---

## Step 0: Immediate bug fix: task.cancelled SSE (no endpoint needed)

**File**: `packages/forge-dash-community/src/lib/use-hub-events.ts`

**This is a one-line fix and a confirmed bug.** The hub emits `task.cancelled` via EventBus. The `TASK_EVENTS` constant in the SSE hook does not include it, so the dashboard never triggers `router.refresh()` when a task is cancelled. The fix:

```typescript
const TASK_EVENTS = [
  'task.created',
  'task.assigned',
  'task.claimed',
  'task.completed',
  'task.failed',
  'task.requeued',
  'task.cancelled', // ADD THIS (confirmed bug fix)
] as const;
```

Ship this as a standalone commit before any of the endpoint work below. No new tests are required for this change; the existing SSE subscription logic already handles any event name in the array.

---

## 1. Cancel

### 1.1 Current behavior

`PATCH /workspaces/:workspaceId/tasks/:taskId` with body `{ status: 'cancelled' }` transitions tasks via `USER_ALLOWED_TRANSITIONS`. The current transition map is:

```
pending_agent       -> cancelled
pending_design      -> cancelled
design_review       -> cancelled
assigned            -> cancelled
in_progress         -> cancelled
```

It emits `task.cancelled` via EventBus. It does NOT insert a `taskInstructions` stop signal, so in-progress tasks receive no abort signal to the running daemon. The cancel button in the dashboard uses this path.

### 1.2 Gap

- **Missing transition**: `pending_dispatcher_action -> cancelled` is absent from `USER_ALLOWED_TRANSITIONS` in `packages/forge-hub/src/routes/tasks.ts`. FM-queued tasks (status = `pending_dispatcher_action`) cannot be cancelled through the existing PATCH endpoint. The new cancel endpoint must handle this status explicitly, either by extending `USER_ALLOWED_TRANSITIONS` or by implementing its own status guard independently.
- `in_progress` tasks cannot be cancelled through the hub with an abort signal to the daemon. A running ClaudeCodeRuntime holds `status = in_progress` and the daemon currently has no mechanism to receive a stop signal from the hub mid-execution (see section 1.4 for the prerequisite work required).
- The `task.cancelled` event is missing from `TASK_EVENTS` in `use-hub-events.ts` (fixed in Step 0 above).
- No mechanism to attach a human-readable cancel reason to the task history.

### 1.3 Hub endpoint design

```
POST /workspaces/:workspaceId/tasks/:taskId/cancel
```

**Auth**: `requireWorkspaceMember(db, 'collaborator')`. Any workspace member at collaborator level or above may cancel.

**Request body**

```typescript
interface CancelTaskBody {
  reason?: string; // max 500 chars; stored as a taskHistory payload field
}
```

**Status guard**: 409 if current status is not in `['pending_dispatcher_action', 'pending_design', 'pending_agent', 'assigned', 'in_progress']`. Tasks already in `completed`, `failed`, or `cancelled` return 409 `{ error: 'already_terminal' }`.

Note: this endpoint explicitly covers `pending_dispatcher_action`, which the general PATCH does not. The new endpoint is not wired through `USER_ALLOWED_TRANSITIONS`; it implements its own guard.

**Behavior (all statuses)**

1. Read task, verify workspace membership, check status guard.
2. Atomic UPDATE: `status = 'cancelled'`, `updatedAt = now()` with a `WHERE status = <current>` guard to prevent races.
3. If the UPDATE touches 0 rows, return 409 `{ error: 'status_changed' }` (concurrent write).
4. Insert `taskHistory` row:
   ```typescript
   {
     id: nanoid(),
     taskId,
     eventName: 'task.cancelled',
     source: `user:${user.id}`,
     payload: { previousStatus, reason: body.reason ?? null },
     workspaceId,
   }
   ```
5. Emit EventBus: `task.cancelled` with `{ taskId, workspaceId }`.
6. Return 200 `{ id: taskId, status: 'cancelled' }`.

**Additional behavior when `previousStatus === 'in_progress'`**

After step 3, insert a `taskInstructions` stop signal:

```typescript
await db.insert(schema.taskInstructions).values({
  id: nanoid(),
  taskId,
  workspaceId,
  priority: 'stop',
  body: reason
    ? `Task cancelled by user: ${reason}`
    : 'Task cancelled by user.',
  createdBy: `user:${user.id}`,
});
```

This insert is a prerequisite for the daemon to honour the stop signal. See section 1.4 for the daemon polling work that must be completed before in-progress cancellation actually reaches the running process.

**Response shapes**

```
HTTP 200
{ "id": "TSK-042", "status": "cancelled" }

HTTP 404
{ "error": "not_found" }

HTTP 409 (already terminal)
{ "error": "already_terminal", "status": "completed" }

HTTP 409 (concurrent write)
{ "error": "status_changed" }

HTTP 422 (unreachable given guard, kept for safety)
{ "error": "invalid_transition", "from": "in_progress", "to": "cancelled" }
```

### 1.4 Daemon cancellation signal: prerequisite

**Current state**: The daemon does NOT poll `GET /tasks/:taskId/instructions` during task execution. `ClaudeCodeRuntime` reads from local task files (`packages/forge-daemon/src/sync/task-file.ts`) and the worker loop (`packages/forge-daemon/src/worker-loop/loop.ts`) drives claim/complete/fail cycles. There is no code path in the daemon that fetches hub instructions mid-run.

**This means the `taskInstructions` stop row inserted by the cancel endpoint will NOT reach a running daemon automatically.** The hub status flip to `cancelled` is the authoritative record, but the in-progress abort requires a daemon-side polling loop to be built.

**Required prerequisite work (separate task, blocks in-progress cancel UX)**

Implement a hub instruction polling step in the daemon's run loop:

```
GET /tasks/:taskId/instructions
```

On each iteration (or at a configurable sub-interval), the daemon must:
1. Fetch unacknowledged instructions for the active task.
2. If any instruction has `priority: 'stop'`, abort the current run and ack the instruction.

Until this is implemented, cancel of `in_progress` tasks via the new endpoint will:
- Flip the hub status to `cancelled` (correct)
- Insert the stop instruction (correct)
- NOT abort the running daemon process (limitation)

The daemon will eventually complete or fail on its own; the task will remain visually cancelled in the dashboard but the process runs to its natural end. This is acceptable for the initial release. The prerequisite polling loop should be tracked as a follow-up item.

Three options for delivering the abort signal were considered:

| Option | Mechanism | Pros | Cons |
|---|---|---|---|
| (a) taskInstructions poll | Hub inserts `stop` row; daemon reads on next iteration | No new IPC; infrastructure already exists; daemon already polls for tasks | Requires new polling loop in daemon; latency = daemon poll interval |
| (b) New SSE event | Hub emits `task.cancel_signal`; daemon SSE listener triggers abort | Near-instant | Requires daemon to maintain persistent SSE connection; adds reconnect/error surface; new event type needs adding to both hub and daemon |
| (c) Daemon health-check detects status | Daemon reads task status on each iteration; aborts if `cancelled` | Dead simple; no new tables | Requires daemon to re-fetch task, not just instructions; slightly more DB load |

**Recommendation: option (a), taskInstructions with `priority: stop`.** The insert side is implemented by this design. The daemon polling loop is the prerequisite item that must be built before in-progress abort works end-to-end.

### 1.5 Dashboard UI

**Affected file**: `packages/forge-dash-community/src/app/(dashboard)/workspaces/[id]/tasks/[taskId]/task-action-button.tsx`

The existing `TaskActionButton` calls `updateTaskStatusAction` which uses the general PATCH. The action needs to call the new dedicated endpoint.

**New server action** in `packages/forge-dash-community/src/actions/tasks.ts`:

```typescript
export async function cancelTaskAction(
  workspaceId: string,
  taskId: string,
  reason?: string,
): Promise<{ error?: string }> {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ id?: string; error?: string }>(
    `/workspaces/${workspaceId}/tasks/${taskId}/cancel`,
    {
      method: 'POST',
      body: reason ? { reason } : {},
      cookie: `${SESSION_COOKIE}=${session}`,
    },
  );

  if (!res.ok) {
    const errMsg = (res.data as { error?: string } | null)?.error;
    if (errMsg === 'already_terminal') return { error: 'Task is already in a terminal state.' };
    if (errMsg === 'status_changed') return { error: 'Task status changed. Refresh and try again.' };
    return { error: 'Failed to cancel task.' };
  }

  revalidatePath(`/workspaces/${workspaceId}/tasks/${taskId}`);
  revalidatePath(`/workspaces/${workspaceId}`);
  return {};
}
```

**Cancel button behavior**

- Visible when `task.status` is in `['pending_dispatcher_action', 'pending_design', 'pending_agent', 'assigned', 'in_progress']`.
- Renders as a `danger` / `flat` Button (existing style is already correct).
- On press: opens a small confirmation UI. For in-progress tasks, the confirmation text is "Cancel [Task Title]? The running agent will be signalled to stop at its next checkpoint." For all other statuses: "Cancel [Task Title]?"
- Includes an optional reason `<Textarea>` (max 500 chars, placeholder "Reason (optional)").
- While request is in flight: button shows `isLoading`, textarea is disabled.
- On success: `router.refresh()`. SSE `task.cancelled` event will also trigger refresh once Step 0 is shipped.
- On error: inline error below the button (existing pattern).

**Confirmation interaction**: The simplest approach that fits the existing component structure is an inline expand rather than a modal. The button press expands a small confirmation panel below the chip row, avoiding a modal dependency and staying within the card.

---

## 2. Retry

### 2.1 Current behavior

`PATCH /workspaces/:workspaceId/tasks/:taskId` with body `{ status: 'pending_agent' }` transitions tasks from `failed` or `cancelled` to `pending_agent`. This bypasses FM triage: the task goes directly to the worker queue with its original `assignedAgentId` still set. For failed tasks this is wrong because the assignment that led to failure is still attached and no FM re-evaluation occurs.

### 2.2 Gap

- Retry should route back to `pending_dispatcher_action` so FM can re-triage: reassign a different agent, decompose the task, or escalate.
- `assignedAgentId`, `assignedAt`, and `assignedDeviceId` should be cleared on retry. A task that failed mid-execution should not re-claim the same device.
- The existing general PATCH cannot do this cleanly because `PatchTaskBodySchema` only accepts `{ status: 'cancelled' | 'pending_agent' }`.
- Priority bump on retry is not available through the general PATCH.

### 2.3 Hub endpoint design

```
POST /workspaces/:workspaceId/tasks/:taskId/retry
```

**Auth**: `requireWorkspaceMember(db, 'collaborator')`.

**Request body**

```typescript
interface RetryTaskBody {
  priority?: 'low' | 'normal' | 'high' | 'urgent'; // optional priority override
}
```

**Status guard**: 409 if `task.status !== 'failed'`. Only genuinely failed tasks may be retried through this endpoint. To re-enqueue a cancelled task, the user must use the general PATCH (which already handles `cancelled -> pending_agent`).

**Behavior**

1. Read task, verify workspace, check status guard.
2. Atomic UPDATE with `WHERE status = 'failed'` guard:
   ```typescript
   {
     status: 'pending_dispatcher_action',
     assignedAgentId: null,
     assignedAt: null,
     assignedDeviceId: null,
     priority: body.priority ?? task.priority, // keep existing if not overridden
     updatedAt: new Date(),
   }
   ```
3. If 0 rows updated, return 409 `{ error: 'status_changed' }`.
4. Insert `taskHistory`:
   ```typescript
   {
     eventName: 'task.requeued',
     source: `user:${user.id}`,
     payload: {
       previousStatus: 'failed',
       priorityOverride: body.priority ?? null,
     },
     workspaceId,
   }
   ```
5. Emit EventBus: `task.requeued` with `{ taskId, workspaceId }`.
6. Return 200 `{ id: taskId, status: 'pending_dispatcher_action' }`.

**Response shapes**

```
HTTP 200
{ "id": "TSK-042", "status": "pending_dispatcher_action" }

HTTP 404
{ "error": "not_found" }

HTTP 409 (not failed)
{ "error": "not_failed", "status": "in_progress" }

HTTP 409 (concurrent write)
{ "error": "status_changed" }
```

### 2.4 Dashboard UI

**New server action** in `packages/forge-dash-community/src/actions/tasks.ts`:

```typescript
export async function retryTaskAction(
  workspaceId: string,
  taskId: string,
  priority?: string,
): Promise<{ error?: string }> {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ id?: string; error?: string }>(
    `/workspaces/${workspaceId}/tasks/${taskId}/retry`,
    {
      method: 'POST',
      body: priority ? { priority } : {},
      cookie: `${SESSION_COOKIE}=${session}`,
    },
  );

  if (!res.ok) {
    const errMsg = (res.data as { error?: string } | null)?.error;
    if (errMsg === 'not_failed') return { error: 'Task is not in a failed state.' };
    if (errMsg === 'status_changed') return { error: 'Task status changed. Refresh and try again.' };
    return { error: 'Failed to retry task.' };
  }

  revalidatePath(`/workspaces/${workspaceId}/tasks/${taskId}`);
  revalidatePath(`/workspaces/${workspaceId}`);
  return {};
}
```

**Retry button behavior**

- Visible when `task.status === 'failed'`.
- No confirmation modal required. The action is not destructive; the task returns to the FM queue.
- Inline confirm: single press calls `retryTaskAction` directly. Button text "Retry task", color `primary`, variant `flat` (existing pattern).
- Optional: expose a priority select in the expanded state (low/normal/high/urgent). Start without it; add in a follow-up if needed.
- On success: `router.refresh()`. The `task.requeued` SSE event will also trigger refresh (already in `TASK_EVENTS`).

**Note on the existing cancel retry path**: The `TaskActionButton` currently handles retry via `updateTaskStatusAction` targeting `pending_agent`. Once the dedicated endpoints exist, the action-button should be updated to call `cancelTaskAction` and `retryTaskAction` respectively. The old `pending_agent` retry path via PATCH stays in place for the `cancelled -> pending_agent` case (re-enqueue a cancelled task without FM triage, a valid shortcut for tasks cancelled by mistake).

---

## 3. Reassign

### 3.1 Current behavior

`PATCH /workspaces/:workspaceId/tasks/:taskId/assign` is orchestrator-device-only (`deviceType === 'orchestrator'`). The FM daemon calls this to route a task to a specific agent. The current `AssignTaskBodySchema` is:

```typescript
const AssignTaskBodySchema = z.object({
  agentId: z.string().min(1).max(100), // non-nullable; orchestrator always supplies a value
});
```

No user session path exists.

### 3.2 Gap

- A workspace operator has no UI mechanism to correct a mis-assigned task. If FM routes to the wrong agent, the task sits in `assigned` or `pending_agent` with the wrong `assignedAgentId` until the stale-assignment requeue fires (default 30-minute TTL).
- No path to clear the assignment and return a task to the FM queue without waiting for the stale timer.
- No UI for the dashboard operator to see which tasks are pending for which agents and intervene.

### 3.3 Hub endpoint design

Extend the existing assign endpoint to also accept user session auth:

```
PATCH /workspaces/:workspaceId/tasks/:taskId/assign
```

**Auth change**: Accept `requireWorkspaceMember(db, 'collaborator')` in addition to orchestrator device. The `preHandler` will need to be replaced with a custom handler that accepts either path.

**Rationale for member-level access**: FM can mis-assign; any operator on the workspace needs to be able to correct this promptly. Restricting reassign to owners or admins would create a bottleneck in operational workflows. This matches the access level for cancel and retry. If stricter access control is required in the future, it should be implemented as a Heimdall policy and documented as a separate concern.

Implementation pattern:

```typescript
fastify.patch('/workspaces/:workspaceId/tasks/:taskId/assign', async (req, reply) => {
  // Accept orchestrator device OR workspace member (user session)
  const isOrchestrator = req.authDevice?.deviceType === 'orchestrator';
  const isUser = !!req.authUser;
  if (!isOrchestrator && !isUser) {
    await reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  if (isUser) {
    // Verify workspace membership at collaborator level
    // (inline membership check, same logic as requireWorkspaceMember)
  }
  // ... rest of handler
});
```

**Schema change**

The current `AssignTaskBodySchema` requires a non-nullable string. To support clearing assignments (`agentId: null` returns the task to `pending_dispatcher_action`), the schema must be updated:

```typescript
// Orchestrator path (existing, unchanged)
const AssignTaskBodySchema = z.object({
  agentId: z.string().min(1).max(100),
});

// User session path (new, nullable)
const UserAssignTaskBodySchema = z.object({
  agentId: z.string().min(1).max(100).nullable(),
});
```

The orchestrator path continues to use the non-nullable schema. The user session path uses the nullable schema. Parse the correct schema based on which auth path succeeded.

**Status guards**

| Caller | Allowed source statuses |
|---|---|
| Orchestrator device | `pending_dispatcher_action`, `pending_agent` (existing FM_ASSIGNABLE_STATUSES) |
| User session | `pending_agent`, `assigned` (tasks not yet claimed) |

A user may not reassign an `in_progress` task because the device has already claimed it. If reassignment of an in-progress task is needed, cancel first then retry.

**Behavior when `agentId` is non-null**

Same as current FM assign: set `assignedAgentId = agentId`, `assignedAt = now()`, `status = 'assigned'`. Record `task.assigned` history. Emit `task.assigned` SSE.

**Behavior when `agentId` is null** (user-only; orchestrators always supply an agentId)

```typescript
{
  assignedAgentId: null,
  assignedAt: null,
  status: 'pending_dispatcher_action',
  updatedAt: new Date(),
}
```

Record `task.requeued` history with `{ reason: 'manual_reassign_cleared' }`. Emit `task.requeued` SSE.

**Response shapes**

```
HTTP 200  (non-null agentId)
{ "ok": true }

HTTP 200  (null agentId, assignment cleared)
{ "ok": true, "status": "pending_dispatcher_action" }

HTTP 404
{ "error": "not_found" }

HTTP 409
{ "error": "not_assignable", "status": "in_progress" }
```

### 3.4 Dashboard UI

**Location**: task detail page, metadata section.

**Fetch prerequisite**: the task detail page already fetches the workspace. Add a fetch for workspace agents: `GET /workspaces/:workspaceId/agents` (returns `{ agents: HubAgent[] }`). This hub endpoint exists but the dash has no proxy for it yet; a new proxy route is needed.

**New proxy route**: `packages/forge-dash-community/src/app/api/hub/agents/route.ts`

```typescript
// GET /api/hub/agents?workspaceId=<id>
// Proxies GET /workspaces/:workspaceId/agents
```

**Reassign control**: rendered below the agent/device metadata line in the task card, when `task.status` is `pending_agent` or `assigned`.

```tsx
// Client component: ReassignDropdown
// Props: workspaceId, taskId, currentAgentId, agents: HubAgent[]
// Renders a <Select> with agent name options + a "Return to FM queue" option
// On change: calls reassignTaskAction(workspaceId, taskId, agentId | null)
```

**New server action** in `packages/forge-dash-community/src/actions/tasks.ts`:

```typescript
export async function reassignTaskAction(
  workspaceId: string,
  taskId: string,
  agentId: string | null,
): Promise<{ error?: string }> {
  const session = await getSessionCookie();
  if (!session) redirect('/login');

  const res = await hubFetch<{ ok?: boolean; error?: string }>(
    `/workspaces/${workspaceId}/tasks/${taskId}/assign`,
    {
      method: 'PATCH',
      body: { agentId },
      cookie: `${SESSION_COOKIE}=${session}`,
    },
  );

  if (!res.ok) {
    const errMsg = (res.data as { error?: string } | null)?.error;
    if (errMsg === 'not_assignable') return { error: 'Task cannot be reassigned in its current state.' };
    return { error: 'Failed to reassign task.' };
  }

  revalidatePath(`/workspaces/${workspaceId}/tasks/${taskId}`);
  revalidatePath(`/workspaces/${workspaceId}`);
  return {};
}
```

**HubAgent type** (add to `packages/forge-dash-community/src/lib/hub.ts`):

```typescript
export interface HubAgent {
  id: string;
  name: string;
  workspaceId: string | null;
  runtimeId: string;
  createdAt: string;
}
```

---

## 4. SSE Event Additions

### 4.1 Missing event: `task.cancelled`

**File**: `packages/forge-dash-community/src/lib/use-hub-events.ts`

The hub already emits `task.cancelled` via EventBus (confirmed in `tasks.ts` line 618). The dash SSE hook does not subscribe to it, so task cancellations never trigger `router.refresh()`.

**Change** (covered in Step 0 at the top of this document):

```typescript
const TASK_EVENTS = [
  'task.created',
  'task.assigned',
  'task.claimed',
  'task.completed',
  'task.failed',
  'task.requeued',
  'task.cancelled', // ADD THIS
] as const;
```

This is a one-line change and should be shipped as a standalone fix independent of the rest of this design, since it fixes an existing bug.

### 4.2 Event `task.cancelled` in the SSE stream

The hub SSE route (`/api/hub/events`) proxies EventBus events as named SSE events. No change is needed there: EventBus events with any name are forwarded. The dash proxy at `packages/forge-dash-community/src/app/api/hub/events/route.ts` also needs no change.

---

## 5. TypeScript Types

**Add to `packages/forge-dash-community/src/lib/hub.ts`**:

```typescript
export type TaskStatus =
  | 'pending_dispatcher_action'
  | 'pending_design'
  | 'pending_agent'
  | 'assigned'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Statuses from which a user may trigger Cancel. */
export const CANCELLABLE_STATUSES: TaskStatus[] = [
  'pending_dispatcher_action',
  'pending_design',
  'pending_agent',
  'assigned',
  'in_progress',
];

/** Statuses from which a user may trigger Retry (via dedicated /retry endpoint). */
export const RETRIABLE_STATUSES: TaskStatus[] = ['failed'];

/** Statuses from which a user may reassign the agent. */
export const REASSIGNABLE_STATUSES: TaskStatus[] = ['pending_agent', 'assigned'];
```

**Hub-side Zod schemas** (add to `tasks.ts`):

```typescript
const CancelTaskBodySchema = z.object({
  reason: z.string().max(500).optional(),
});

const RetryTaskBodySchema = z.object({
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
});

const UserAssignTaskBodySchema = z.object({
  agentId: z.string().min(1).max(100).nullable(),
});
```

---

## 6. Tests Required

**Process gate**: All tests in this section must be committed and passing before any UI implementation (Step 5 and above in section 7) begins. Hub endpoint tests are the acceptance criteria for the hub work. Do not start dash UI code until the hub tests are green.

### 6.1 Cancel endpoint tests

File: `packages/forge-hub/src/routes/tasks.test.ts`, new `describe` block

| Test | Setup | Expected |
|---|---|---|
| Happy path (pending_agent) | Create task in pending_agent | 200, status=cancelled, taskHistory row with task.cancelled, bus.emit called |
| Happy path (pending_dispatcher_action) | Create task in pending_dispatcher_action | 200, status=cancelled (confirms gap fix) |
| Happy path (in_progress) | Create task, set in_progress | 200, status=cancelled, taskInstructions stop row inserted |
| Stop instruction body includes reason | Cancel in_progress with `{ reason: 'wrong scope' }` | instructions row body contains reason string |
| Already cancelled | Cancel a cancelled task | 409 `already_terminal` |
| Already completed | Cancel a completed task | 409 `already_terminal` |
| Already failed | Cancel a failed task | 409 `already_terminal` |
| Not found | Cancel non-existent taskId | 404 |
| Not workspace member | Cancel with different user | 403 |
| Unauthenticated | No cookie | 401 |
| Concurrent cancel (status race) | Two concurrent requests | Second returns 409 `status_changed` |
| TaskHistory recorded | Cancel any eligible status | taskHistory row exists with correct eventName, source, previousStatus, reason |
| Reason stored in history | Cancel with `{ reason: 'test' }` | taskHistory payload.reason === 'test' |
| Reason null when omitted | Cancel without body | taskHistory payload.reason === null |

### 6.2 Retry endpoint tests

File: `packages/forge-hub/src/routes/tasks.test.ts`, new `describe` block

| Test | Setup | Expected |
|---|---|---|
| Happy path (failed) | Create task, fail it | 200, status=pending_dispatcher_action, assignedAgentId=null, assignedAt=null |
| Priority override | Retry with `{ priority: 'urgent' }` | task.priority updated to 'urgent' |
| Priority unchanged when not provided | Retry without priority | task.priority unchanged from original |
| Not failed (in_progress) | Task is in_progress | 409 `not_failed` |
| Not failed (pending_agent) | Task is pending_agent | 409 `not_failed` |
| Not found | Retry non-existent taskId | 404 |
| Not workspace member | Retry with different user | 403 |
| Unauthenticated | No cookie | 401 |
| TaskHistory recorded | Retry happy path | taskHistory row with eventName=task.requeued, previousStatus=failed |
| SSE emitted | Retry happy path | bus.emit called with task.requeued |
| assignedDeviceId cleared | Task had assignedDeviceId set | assignedDeviceId=null after retry |

### 6.3 Reassign endpoint: user-session path tests

File: `packages/forge-hub/src/routes/tasks.test.ts`, extend existing assign describe block

| Test | Setup | Expected |
|---|---|---|
| User reassigns pending_agent task | Task in pending_agent, user session | 200, assignedAgentId updated, status=assigned, task.assigned history |
| User clears assignment (agentId: null) | Task in pending_agent | 200, assignedAgentId=null, status=pending_dispatcher_action, task.requeued history |
| User cannot reassign in_progress | Task in in_progress | 409 `not_assignable` |
| User cannot reassign completed | Task completed | 409 `not_assignable` |
| User reassign without workspace membership | Different user | 403 |
| Unauthenticated user | No cookie | 401 |
| Orchestrator device path still works | Existing FM assign path | 200 (regression guard) |
| Orchestrator cannot pass null agentId | Orchestrator with agentId: null | 422 validation error |
| TaskHistory recorded (assign) | User reassigns | task.assigned history row with source=user:<id> |
| TaskHistory recorded (clear) | User clears | task.requeued history row with reason=manual_reassign_cleared |
| SSE emitted (assign) | User reassigns | bus.emit task.assigned |
| SSE emitted (clear) | User clears | bus.emit task.requeued |

---

## 7. Implementation Sequence

The work is ordered to minimize integration gaps at each step. Hub endpoints ship with their tests before any dash code references them.

**Process gate (section 6 above)**: All hub tests must be committed and passing before UI steps (Step 5+) begin. This is a hard gate, not a guideline.

### Step 0: Immediate bug fix (standalone, no new endpoints)

- Add `'task.cancelled'` to `TASK_EVENTS` in `use-hub-events.ts`
- No tests needed (the existing SSE subscription already works; this is a missing constant entry)
- Ship as a standalone commit

### Step 1: Hub: USER_ALLOWED_TRANSITIONS gap fix

- Add `pending_dispatcher_action: ['cancelled']` to `USER_ALLOWED_TRANSITIONS` in `tasks.ts`, OR confirm the new cancel endpoint will handle this status independently of the map
- Document the chosen approach in a code comment

### Step 2: Hub: Cancel endpoint

- Add `POST /workspaces/:workspaceId/tasks/:taskId/cancel` to `tasks.ts`
- Add `CancelTaskBodySchema`
- Write tests (section 6.1), including the `pending_dispatcher_action` case
- Run `pnpm test --filter forge-hub`

### Step 3: Hub: Retry endpoint

- Add `POST /workspaces/:workspaceId/tasks/:taskId/retry` to `tasks.ts`
- Add `RetryTaskBodySchema`
- Write tests (section 6.2)
- Run `pnpm test --filter forge-hub`

### Step 4: Hub: Reassign user-session path

- Extend `PATCH /workspaces/:workspaceId/tasks/:taskId/assign` to accept user session
- Update schema: orchestrator path keeps non-nullable `AssignTaskBodySchema`; user path uses `UserAssignTaskBodySchema` with nullable agentId
- Add user-session status guards (`pending_agent`, `assigned`)
- Add clear-assignment behavior (agentId: null -> pending_dispatcher_action)
- Write tests (section 6.3)
- Run `pnpm test --filter forge-hub`

**[Process gate: all hub tests must be green before continuing to Step 5]**

### Step 5: Dash: Server actions

- Add `cancelTaskAction` to `actions/tasks.ts`
- Add `retryTaskAction` to `actions/tasks.ts`
- Add `reassignTaskAction` to `actions/tasks.ts`

### Step 6: Dash: Proxy routes

- Add `GET /api/hub/agents/route.ts` (workspace-scoped agent list)
- Verify `hubFetch` path: `/workspaces/${workspaceId}/agents`

### Step 7: Dash: UI components

- Update `TaskActionButton` to call `cancelTaskAction` and `retryTaskAction` instead of `updateTaskStatusAction`
- Add cancel reason input and in-progress confirmation text to the cancel expand panel
- Add `ReassignDropdown` client component to task detail page
- Fetch agents in task detail page server component; pass to `ReassignDropdown`

### Step 8: Type additions

- Add `HubAgent`, `TaskStatus`, `TaskPriority`, and status constant arrays to `hub.ts`

### Step 9: Verification

- Manual smoke test: cancel pending_dispatcher_action task (confirms gap fix), cancel pending_agent task, cancel in_progress task (verify stop instruction created, note daemon abort is a future prerequisite), retry failed task (verify FM triage status, cleared assignments), reassign pending_agent task, clear assignment
- Confirm SSE events trigger page refresh for cancel, retry, and reassign flows
- Run full test suite: `pnpm test`

---

## 8. Open Questions

| # | Question | Owner | Default assumption |
|---|---|---|---|
| 1 | Should cancelled tasks appear in the main task list or be hidden by default? | Product | Show with `cancelled` chip; filtering is a separate concern |
| 2 | Should retry be available from the task list view (not just detail page)? | Product | Detail page only for now |
| 3 | Should the reassign dropdown show all registered agents or only agents with recent activity? | Product | All agents registered to the workspace |
| 4 | Should the cancel reason be surfaced as a comment (authorType=system) in addition to taskHistory? | Engineering | TaskHistory only; comments are for human-authored content |
| 5 | Does the daemon need to ack the stop instruction before the task status is set to cancelled, or is the hub-side status flip sufficient? | Engineering | Hub status flip is sufficient; stop instruction is best-effort for in-flight abort |
| 6 | When should the daemon instruction polling loop be prioritised? | Engineering | Track as a follow-up; initial release accepts that in-progress daemons run to natural completion when cancelled |

---

## Appendix A: Existing endpoint inventory (tasks)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/tasks` | user or device | Create task (flat) |
| GET | `/tasks` | user or device | List tasks (flat or by workspaceId) |
| GET | `/tasks/stats` | user | Task statistics |
| GET | `/tasks/:id` | user or device | Get single task |
| GET | `/tasks/:id/history` | user or device | Task history |
| POST | `/tasks/:id/claim` | device | Claim task (worker) |
| POST | `/tasks/:id/complete` | device | Mark complete |
| POST | `/tasks/:id/fail` | device | Mark failed |
| GET | `/tasks/:id/instructions` | user or device | List instructions |
| POST | `/tasks/:id/instructions` | user | Create instruction |
| POST | `/tasks/:id/instructions/:instrId/ack` | user or device | Ack instruction |
| POST | `/workspaces/:workspaceId/tasks` | member | Create workspace task |
| GET | `/workspaces/:workspaceId/tasks` | member | List workspace tasks |
| PATCH | `/workspaces/:workspaceId/tasks/:taskId` | member (collab+) | Update status (cancel, requeue) |
| PATCH | `/workspaces/:workspaceId/tasks/:taskId/assign` | orchestrator device | FM agent assignment |
| GET | `/workspaces/:workspaceId/tasks/stale-assigned` | orchestrator | Stale assignment query |
| POST | `/workspaces/:workspaceId/tasks/stale-assigned/requeue` | orchestrator | Bulk requeue stale |

**New endpoints added by this design**:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/workspaces/:workspaceId/tasks/:taskId/cancel` | member (collab+) | Cancel with optional reason + in-progress stop signal |
| POST | `/workspaces/:workspaceId/tasks/:taskId/retry` | member (collab+) | Reset failed task to pending_dispatcher_action |
| PATCH | `/workspaces/:workspaceId/tasks/:taskId/assign` | member (collab+) OR orchestrator | Extended to accept user session and nullable agentId |
