# Device Management Enhancements

| Field       | Value                    |
|-------------|--------------------------|
| Date        | 2026-05-27               |
| Status      | Draft                    |
| Author      | Architect                |
| Reviewed by | TBD                      |

---

## Overview

This document specifies three enhancements to forge-hub device management:

1. **Deregister**: revoke a device's access and remove it from the active device list
2. **Rename**: update a device's human-readable name without re-registration
3. **Token rotation**: invalidate a compromised token and issue a replacement, preserving device identity and history

---

## Background and Schema Reality

Devices are currently scoped by `userId`, not by workspace. The `devices` table:

```sql
CREATE TABLE devices (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  hostname    TEXT,
  platform    TEXT CHECK(platform IN ('win32','darwin','linux')),
  token_hash  TEXT NOT NULL UNIQUE,   -- SHA-256 hex, not bcrypt
  last_seen   INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  agent_id    TEXT,
  device_type TEXT NOT NULL DEFAULT 'worker'
                   CHECK(device_type IN ('worker','orchestrator'))
);
```

Two foreign keys in other tables reference `devices.id`:

- `tasks.assigned_device_id`: `ON DELETE SET NULL` (safe for hard delete)
- `agent_instances.device_id`: `ON DELETE CASCADE` (hard delete removes instance records)

Token hashing uses Node.js `crypto.createHash('sha256')`. The hash is stored; the plaintext is returned once at registration and never again.

---

## 1. Deregister

### 1.1 Schema migration

Deregister requires a new `status` column. This column does not currently exist.

```sql
ALTER TABLE devices
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'deregistered'));
```

Add an index for the middleware lookup (which filters by `token_hash` and should also check `status`):

```sql
CREATE INDEX devices_status_idx ON devices(status);
```

### 1.2 Hard delete vs. soft delete

**Hard delete** removes the row entirely.

Consequences:
- `tasks.assigned_device_id` becomes `NULL` for any task that was assigned to this device. Acceptable: the FK is `ON DELETE SET NULL`.
- `agent_instances.device_id` rows cascade-delete. Agent instance history (start time, end time, which task it ran) is permanently lost.

**Soft delete** (recommended) sets `status = 'deregistered'` and leaves the row in place.

Consequences:
- `agentInstances` history is preserved.
- The token becomes logically invalid immediately (enforced in the auth middleware).
- Deregistered devices accumulate in the table. A background prune job can hard-delete rows older than a configurable retention window (e.g., 90 days) after soft-delete.

**Recommendation: soft delete.** The `agentInstances` audit trail is the primary reason. A device that ran tasks for weeks has meaningful history attached to it; discarding it silently would make debugging task failures harder.

### 1.3 Hub endpoint

```
DELETE /devices/:deviceId
```

**Auth:** User session (`requireUser`). The requesting user must own the device (`devices.user_id = req.authUser.id`).

**Guard:** Load the device row. If not found or `user_id` does not match the authenticated user, return 404. (Returning 404 for both cases avoids confirming whether a device ID exists for another user.)

**Behavior:**

```
UPDATE devices SET status = 'deregistered' WHERE id = :deviceId
```

The existing token hash row is preserved. The auth middleware will now reject it.

**Response:** `204 No Content`

**Request shape:**

Do not send a `Content-Type: application/json` header on this request. Fastify 5 rejects bodyless requests that include `Content-Type: application/json` (see `feedback_fastify_empty_body.md`).

```http
DELETE /devices/dev_abc123 HTTP/1.1
Cookie: session=<token>
```

**Response shape:**

```http
HTTP/1.1 204 No Content
```

### 1.4 Auth middleware update

The `populateAuth` function in `src/auth/middleware.ts` currently resolves a device by `token_hash` alone. After this change it must also filter for `status = 'active'`:

```typescript
const device = await db
  .select({ ... })
  .from(schema.devices)
  .where(
    and(
      eq(schema.devices.tokenHash, tokenHash),
      eq(schema.devices.status, 'active'),  // NEW
    )
  )
  .get();
```

A deregistered device presenting its old token receives no `authDevice` on the request object. Any route guarded by `requireDevice` returns `401`. This takes effect immediately on the next request. There is no TTL or cache layer to flush.

### 1.5 Dashboard proxy

```
DELETE /api/hub/devices/:id
```

New Next.js route handler at `packages/forge-dash-community/src/app/api/hub/devices/[id]/route.ts`.

```typescript
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const res = await hubFetch(`/devices/${params.id}`, {
    method: 'DELETE',
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status ?? 500 });
  return new Response(null, { status: 204 });
}
```

### 1.6 Dashboard UI

Location: device card in the devices list (existing or future devices page).

- "Deregister" button on each device card (destructive, red or outlined variant)
- Confirmation modal: "Deregister [device name]? The daemon on this machine will lose access immediately. This cannot be undone."
- On confirm: `DELETE /api/hub/devices/:id`
- On success: call `router.refresh()` to re-fetch the device list
- Deregistered devices: hidden by default. A "Show deregistered" toggle reveals them as dimmed cards with a "Deregistered" badge. This reduces noise without discarding history.

---

## 2. Rename

### 2.1 Hub endpoint

```
PATCH /devices/:deviceId
```

**Auth:** User session. Device must be owned by the authenticated user.

**Body:**

```typescript
const RenameDeviceBodySchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9-]+$/, 'Name may only contain letters, numbers, and hyphens'),
});
```

**Behavior:**

```
UPDATE devices SET name = :name WHERE id = :deviceId AND user_id = :userId
```

**Response:** `200 OK`

```typescript
{
  id: string;
  name: string;
  hostname: string | null;
  platform: string | null;
  deviceType: 'worker' | 'orchestrator';
  agentId: string | null;
  lastSeen: string | null;
  createdAt: string;
  status: 'active' | 'deregistered';
}
```

**Request shape:**

```http
PATCH /devices/dev_abc123 HTTP/1.1
Cookie: session=<token>
Content-Type: application/json

{ "name": "mac-studio-furnace" }
```

**Error shapes:**

```json
// 400 -- validation failure
{ "error": "validation_error", "issues": [...] }

// 404 -- device not found or not owned by user
{ "error": "not_found" }
```

### 2.2 Dashboard proxy

```
PATCH /api/hub/devices/:id
```

```typescript
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json() as { name: string };
  const res = await hubFetch<HubDevice>(`/devices/${params.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: body.name }),
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status ?? 500 });
  return Response.json(res.data);
}
```

### 2.3 Dashboard UI

Inline rename on the device card:

- Click the device name text: it becomes a single-line text input pre-filled with the current name
- Return or a checkmark button saves; Escape cancels
- On save: `PATCH /api/hub/devices/:id` with `{ name }`
- On success: update the card optimistically or call `router.refresh()`
- Validation: enforce the same `^[a-zA-Z0-9-]+$` pattern client-side before submitting; show inline error otherwise

Alternative: edit icon next to the name opens a modal. The inline approach is preferred for the current card layout.

---

## 3. Token Rotation

Token rotation is the security-critical operation. It replaces the device's token without changing its ID, preserving all task and agent instance history.

### 3.1 Hub endpoint

```
POST /devices/:deviceId/rotate-token
```

**Auth:** User session. Device must be owned by the authenticated user.

**Body:** Empty. No payload. Do not send `Content-Type: application/json` on this request (Fastify 5 behavior with empty bodies; see `feedback_fastify_empty_body.md`).

**Behavior:**

1. Load the device row; 404 if not found or not owned by the user.
2. If `status = 'deregistered'`, return `410 Gone` with `{ error: 'device_deregistered' }`. The device no longer logically exists; 410 communicates the resource is permanently gone rather than implying a transient state conflict.
3. Generate a new token: `generateToken()` (32 bytes, base64url, identical to registration).
4. Hash it: `hashToken(token)` (SHA-256 hex).
5. Write the new hash: `UPDATE devices SET token_hash = :newHash WHERE id = :deviceId`.
6. The old hash is immediately invalid. The next request from the daemon using the old token will find no matching row (or a status mismatch if soft-delete is in play).
7. Return the plaintext token.

**Response:** `200 OK`

```typescript
{
  token: string; // plaintext, only time it will be shown
}
```

**Request shape:**

```http
POST /devices/dev_abc123/rotate-token HTTP/1.1
Cookie: session=<token>
```

**Error shapes:**

```json
// 404 -- device not found
{ "error": "not_found" }

// 410 -- device is deregistered (resource permanently gone)
{ "error": "device_deregistered" }

// 429 -- rate limit exceeded
{ "error": "too_many_requests", "retryAfterSeconds": 60 }
```

### 3.2 Rate limiting

Token rotation must be rate-limited to prevent abuse (e.g., a script rapidly cycling tokens to lock out a daemon).

Apply the existing `TokenBucketStore` / `createTokenBucketPreHandler` infrastructure, keyed on `req.ip`:

- Capacity: 5 rotations per device per hour. Since the bucket is keyed on IP (not device ID), the effective limit is 5 rotations per hour from any given IP. This is a pragmatic starting point; a per-device-ID bucket would require storing state per device, which is more complex and not needed at current scale.
- Window: 3600000 ms (1 hour)

> **Future mitigation:** add a `last_rotated_at` timestamp column to the devices table. At rotation time, reject with 429 if `now - last_rotated_at < 3600000ms` (1 hour). This per-device enforcement prevents attackers with multiple IPs from multiplying rotation volume. Implement in Phase B hardening.

```typescript
const rotateTokenLimiter = new TokenBucketStore();
const rotateTokenRateLimit = createTokenBucketPreHandler(rotateTokenLimiter, {
  max: 5,
  windowMs: 60 * 60 * 1000,
});

fastify.post(
  '/devices/:deviceId/rotate-token',
  { preHandler: [requireUser, rotateTokenRateLimit] },
  async (req, reply) => { ... },
);
```

### 3.3 Logging

Token rotation is a security event. Log it to the Fastify logger at `info` level with:

```typescript
req.log.info({ deviceId, userId: user.id, event: 'token_rotated' }, 'device token rotated');
```

This produces a structured log entry that can be queried in production. A separate `deviceEvents` table is not required at this scale. The structured log is sufficient and avoids additional schema complexity.

### 3.4 Dashboard proxy

```
POST /api/hub/devices/:id/rotate-token
```

New route handler at `packages/forge-dash-community/src/app/api/hub/devices/[id]/rotate-token/route.ts`:

```typescript
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const session = await getSessionCookie();
  if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const res = await hubFetch<{ token: string }>(`/devices/${params.id}/rotate-token`, {
    method: 'POST',
    cookie: `${SESSION_COOKIE}=${session}`,
  });
  if (!res.ok) return Response.json({ error: 'hub_error' }, { status: res.status ?? 500 });
  return Response.json(res.data);
}
```

### 3.5 Dashboard UI

Token rotation requires explicit user intent and clear post-action guidance.

**Flow:**

1. "Rotate Token" button on device card (always available for active devices, disabled/hidden for deregistered devices)
2. Warning modal before rotation:
   > "Generate a new device token for [device name]? The daemon on this machine will stop authenticating immediately. You must update its `FORGE_DAEMON_DEVICE_TOKEN` environment variable with the new token before it can reconnect. Continue?"
3. On confirm: `POST /api/hub/devices/:id/rotate-token`
4. On success: show the new token in a modal with:
   - A read-only, monospace input containing the plaintext token
   - A "Copy" button (writes to clipboard)
   - Bold warning: "This token will not be shown again. Copy it now and update your daemon config."
   - A dismiss button (does not auto-dismiss)
5. On dismiss: `router.refresh()` to re-fetch the device list (no visible change to the card; token state is opaque)

---

## 4. Status Display

With the addition of the `status` column:

| Status         | Badge text      | Card appearance        | Shown by default |
|----------------|-----------------|------------------------|------------------|
| `active`       | none (implicit) | normal                 | yes              |
| `deregistered` | "Deregistered"  | dimmed, actions hidden | no               |

The device list query should exclude `status = 'deregistered'` by default. A toggle ("Show deregistered") in the UI re-fetches with a `?includeDeregistered=true` query param. The hub `GET /devices` endpoint accepts this param and conditionally includes the `WHERE` clause.

The dashboard proxy route for `GET /devices` must forward the `?includeDeregistered=true` query param to the hub. Use `req.nextUrl.searchParams` to extract and forward it:

```typescript
const includeDeregistered = req.nextUrl.searchParams.get('includeDeregistered');
const url = includeDeregistered
  ? `/devices?includeDeregistered=true`
  : `/devices`;
```

---

## 5. Test Specifications

All tests follow the existing pattern: `vitest`, `hub.fastify.inject`, in-memory libsql, `setupAdmin` + `registerDevice` helpers from `test-utils.ts`.

### 5.1 DELETE /devices/:deviceId

```
describe('DELETE /devices/:deviceId')

it('returns 204 and device can no longer authenticate')
  -- register device, get token
  -- DELETE as owning user
  -- expect 204
  -- try a device-authed request with the old token
  -- expect 401

it('returns 404 when device does not exist')
  -- DELETE /devices/nonexistent
  -- expect 404

it('returns 404 when device belongs to a different user')
  -- register device as user1
  -- DELETE as user2
  -- expect 404 (not 403 -- avoid ID enumeration)

it('returns 401 when not authenticated')
  -- DELETE without session cookie
  -- expect 401

it('hides deregistered device from default GET /devices response')
  -- register device, deregister it
  -- GET /devices (default)
  -- expect device absent from list

it('includes deregistered device when ?includeDeregistered=true')
  -- register device, deregister it
  -- GET /devices?includeDeregistered=true
  -- expect device present with status='deregistered'

it('after deregister, tasks.assigned_device_id for tasks previously assigned to this device is NULL')
  -- register device, assign a task to that device
  -- DELETE the device (soft delete sets status=deregistered)
  -- note: FK ON DELETE SET NULL only fires on hard delete; soft delete does NOT null assigned_device_id automatically
  -- this test documents that hard-delete prune jobs must handle the nullification, or tasks should be re-assigned before deregister

it('after deregister, the device old token returns 401 (populateAuth filters status=active)')
  -- register device, capture token
  -- DELETE the device
  -- make a device-authed request with the captured token
  -- expect 401 (populateAuth WHERE clause excludes status=deregistered rows)

it('calling DELETE twice on same device returns 404 on second call (idempotency)')
  -- register device
  -- DELETE the device -- expect 204
  -- DELETE the device again -- expect 404
```

### 5.2 PATCH /devices/:deviceId

```
describe('PATCH /devices/:deviceId')

it('returns 200 with updated name')
  -- register device as "old-name"
  -- PATCH { name: "new-name" }
  -- expect 200, body.name === 'new-name'
  -- GET /devices and confirm name updated

it('returns 400 for empty name')
  -- PATCH { name: "" }
  -- expect 400

it('returns 400 for name exceeding 64 chars')
  -- PATCH { name: "a".repeat(65) }
  -- expect 400

it('returns 400 for name with invalid characters')
  -- PATCH { name: "name with spaces" }
  -- expect 400
  -- PATCH { name: "name_underscore" }
  -- expect 400

it('returns 404 when device does not exist')
  -- PATCH /devices/nonexistent
  -- expect 404

it('returns 404 when device belongs to a different user')
  -- PATCH as user2 on user1 device
  -- expect 404

it('returns 401 when not authenticated')
  -- PATCH without session
  -- expect 401
```

### 5.3 POST /devices/:deviceId/rotate-token

```
describe('POST /devices/:deviceId/rotate-token')

it('returns 200 with a new plaintext token')
  -- register device, capture original token
  -- rotate-token
  -- expect 200, body.token is truthy and different from original

it('old token no longer authenticates after rotation')
  -- register device, capture token
  -- rotate-token
  -- make a device-authed request with old token
  -- expect 401

it('new token authenticates after rotation')
  -- register device
  -- rotate-token, capture new token
  -- make a device-authed request with new token
  -- expect 200

it('returns 410 when rotating token for a deregistered device')
  -- register device, deregister it
  -- rotate-token
  -- expect 410 with error='device_deregistered'

it('returns 404 when device does not exist')
  -- POST /devices/nonexistent/rotate-token
  -- expect 404

it('returns 404 when device belongs to a different user')
  -- rotate-token as user2 on user1 device
  -- expect 404

it('returns 401 when not authenticated')
  -- POST without session
  -- expect 401

it('returns 429 after exceeding rate limit')
  -- call rotate-token 6 times in quick succession
  -- expect the 6th call to return 429
  -- expect Retry-After header to be present, be a positive integer, and be <= 3600

it('two simultaneous rotate-token requests are safe: only the last token is valid')
  -- register device
  -- fire two POST /devices/:id/rotate-token requests concurrently (Promise.all)
  -- expect both to complete without error (200)
  -- only the token from the response that completed last is valid for auth
  -- the token from the earlier response returns 401 when used
  -- note: SQLite single-writer serializes these writes, so the behavior is deterministic; this test verifies no corruption occurs and that the last-write-wins invariant holds
```

---

## 6. Security Considerations

### Token storage

Tokens are hashed with SHA-256 before storage. SHA-256 is appropriate here because tokens are 32 bytes of cryptographically secure random data (`randomBytes(32)`), giving sufficient entropy that a precomputed rainbow table attack is infeasible. This is unlike passwords, which require a slow KDF. The existing `generateToken` / `hashToken` pair is correct and should not be changed.

### Immediate invalidation

Both deregister and token rotation invalidate the old token with no grace period. The SQLite write is synchronous within the request; the auth middleware performs a fresh DB read on every request. There is no in-memory token cache to flush. Invalidation is effective on the daemon's next API call.

### Token rotation abuse

An attacker with dashboard access (i.e., a compromised user session) could rotate tokens repeatedly to lock out daemons. Rate limiting (5 rotations per hour per IP) bounds the impact. If the attacker has dashboard access they already have full access to the workspace; the rate limit is a nuisance defense, not a security boundary.

A more targeted defense would be per-device rotation limiting (track `last_rotated_at` on the device row and reject rotations within a minimum interval). This is optional scope. Log the `token_rotated` event so anomalous rotation patterns are detectable.

### Deregistered device enumeration

The deregister and rename endpoints return 404 for both "not found" and "not owned by this user". This prevents a user from confirming whether a device ID exists on another account.

### Rotate-on-deregistered guard

Returning `410 Gone` (not `200`) for a rotate request on a deregistered device prevents a confusing footgun: a user rotates a token, gets a new plaintext back, configures the daemon, and is baffled when the daemon still gets 401s. 410 communicates that the resource is permanently gone, which is semantically correct for a deregistered device. 409 would imply a transient state conflict rather than a permanent absence.

---

## 7. Implementation Sequence

Implement in this order to avoid broken states in any intermediate deployment:

### Step 1: Schema migration

Add `status TEXT NOT NULL DEFAULT 'active'` to `devices`. Add `status_idx`. All existing devices default to `active`. No data migration needed.

File: `packages/forge-hub/src/db/migrate.ts`

### Step 2: Auth middleware update

Update `populateAuth` in `src/auth/middleware.ts` to add `eq(schema.devices.status, 'active')` to the token lookup `WHERE` clause.

This is safe to deploy before any deregister endpoint exists. No devices have `status = 'deregistered'` yet, so behavior is unchanged.

### Step 3: Hub endpoints

Add all three endpoints to `src/routes/devices.ts`:

- `DELETE /devices/:deviceId`
- `PATCH /devices/:deviceId`
- `POST /devices/:deviceId/rotate-token`

Update `GET /devices` to filter `status = 'active'` by default, accept `?includeDeregistered=true`.

Add rate limiter instance for token rotation.

### Step 4: Tests

Write tests per Section 5 before or alongside the implementation. The deregistered-token-returns-401 test validates the middleware change from Step 2.

### Step 5: Dashboard proxy routes

Add Next.js route handlers:

- `DELETE /api/hub/devices/[id]/route.ts`
- `PATCH /api/hub/devices/[id]/route.ts` (can share file with DELETE)
- `POST /api/hub/devices/[id]/rotate-token/route.ts`

Update `GET /api/hub/devices/route.ts` to accept and forward `includeDeregistered`.

Update the `HubDevice` type in `src/lib/hub.ts` to include `status`.

### Step 6: Dashboard UI components

- Deregister button + confirmation modal on device card
- Inline rename on device name field
- Rotate Token button + warning modal + token display modal
- "Show deregistered" toggle on the devices list
