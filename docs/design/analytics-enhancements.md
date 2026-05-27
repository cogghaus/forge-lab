# Analytics Enhancements

| Field       | Value       |
|-------------|-------------|
| Date        | 2026-05-27  |
| Status      | Draft       |
| Author      | Architect   |
| Reviewed by | TBD         |

---

## Overview

The analytics page at `/workspaces/:id/analytics` currently shows all-time stats with no interactivity or trend visibility. This document specifies three enhancements:

1. **Date range filter** — scope both tabs to a user-selected window
2. **Status breakdown drill-through** — make the status distribution clickable
3. **Trend data** *(Phase 2)* — per-bucket task volume chart

---

## 1. Date Range Filter

### Problem

All stats are computed over the full lifetime of the workspace. For active workspaces with months of history, all-time aggregates provide little operational signal. A weekly or monthly window is more actionable.

### Hub Changes

#### Existing endpoint: `GET /agents/performance?workspaceId=<id>`

Add optional query parameters:

| Parameter    | Type                 | Description                                                  |
|--------------|----------------------|--------------------------------------------------------------|
| `workspaceId`| string               | Required. Identifies the workspace to scope results to       |
| `from`       | ISO 8601 date string | Start of range, inclusive. Filters `tasks.createdAt >= from` |
| `to`         | ISO 8601 date string | End of range, inclusive. Defaults to now if omitted          |

**Validation rules:**
- `from` must be a valid ISO 8601 date string
- `to` must be a valid ISO 8601 date string
- `from` must be strictly before `to`; if violated, respond `400 Bad Request`
- Range must not exceed 365 days; if violated, respond `400 Bad Request`
- If neither param is present, existing all-time behavior is unchanged

**Timezone handling:** The API assumes UTC for ISO date strings without explicit timezone offset. Clients should always provide fully qualified ISO 8601 strings with timezone (e.g., `2026-05-01T00:00:00Z`) or accept UTC interpretation of date-only strings. The hub converts ISO strings to Unix epoch milliseconds using `new Date(isoString).getTime()`.

**Implementation:** the existing query does aggregation with `GROUP BY agentId`. Add a conditional `WHERE tasks.createdAt >= :from AND tasks.createdAt <= :to` clause when params are present. Both date strings should be parsed to Unix epoch milliseconds at the handler layer before being passed to the query.

**Request examples:**
```
GET /agents/performance?workspaceId=ws_abc
GET /agents/performance?workspaceId=ws_abc&from=2026-05-01T00:00:00Z&to=2026-05-27T23:59:59Z
GET /agents/performance?workspaceId=ws_abc&from=2026-05-01T00:00:00Z
```

**Response shape (unchanged):**
```json
[
  {
    "agentId": "agent_xyz",
    "agentName": "Scribe",
    "totalCount": 42,
    "completedCount": 38,
    "failedCount": 2,
    "inProgressCount": 2,
    "avgCompletionTimeMs": 14320
  }
]
```

---

#### New endpoint: `GET /workspaces/:id/analytics/overview`

The overview tab currently computes stats in the page component from the raw task list. Moving this server-side enables date filtering and reduces client-side data transfer.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `from`    | ISO 8601 date string | Start of range, inclusive |
| `to`      | ISO 8601 date string | End of range, inclusive. Defaults to now |

Same validation rules as the performance endpoint.

**Request example:**
```
GET /workspaces/ws_abc/analytics/overview?from=2026-05-01&to=2026-05-27
```

**Response shape:**
```json
{
  "totalTasks": 120,
  "completedTasks": 98,
  "failedTasks": 7,
  "pendingTasks": 10,
  "inProgressTasks": 5,
  "completionRate": 0.816,
  "avgCompletionTimeMs": 18450,
  "period": {
    "from": "2026-05-01",
    "to": "2026-05-27"
  }
}
```

- `completionRate` is `completedTasks / totalTasks`, rounded to three decimal places. Returns `0` when `totalTasks` is `0`.
- `avgCompletionTimeMs` is computed as the average of `completedAt - assignedAt` (both Unix ms INTEGER columns) over tasks where both columns are non-null. Returns `null` when no such tasks exist in the period. `durationMs` is not a stored column; duration is always derived from this calculation.
- `period.from` and `period.to` echo back the resolved range (substituting the actual `to` timestamp when the param was omitted).

**Implementation notes:**
- Single aggregation query; no cursor or pagination needed
- Auth guard: workspace membership required, same pattern as the performance endpoint
- Register route in the hub under `src/routes/analytics.ts` (new file) and mount in `app.ts`

---

### Dashboard UI Changes

#### Date Range Picker Component

A shared `DateRangePicker` component placed at the top of the analytics page, above the tab bar. It applies to both tabs simultaneously.

**Preset options (radio/segmented control):**
- Last 7 days
- Last 30 days
- Last 90 days
- All time

**Custom range:** two date inputs (`from`, `to`) revealed when no preset is active. Validation mirrors the hub: `from` before `to`, max 365 days. Submit button triggers the fetch; do not re-fetch on every keystroke.

**URL persistence:** the selected range is reflected in URL query params:
```
/workspaces/ws_abc/analytics?from=2026-05-01&to=2026-05-27
```

On page load, parse `from`/`to` from the URL and initialize the picker accordingly. If neither is present, default to "Last 30 days". This makes the current view shareable and bookmarkable.

**Re-fetch behavior:** both tabs re-fetch their data when the range changes. Pass `from` and `to` as props to the tab content components; each component is responsible for including them in its API call to the dash proxy routes.

#### Dash API Proxy Routes

Two proxy routes needed (Next.js route handlers under `src/app/api/hub/`):

- `GET /api/hub/workspaces/[id]/analytics/overview`: forwards `from`/`to` to the hub overview endpoint
- `GET /api/hub/agents/performance?workspaceId=<id>`: already exists; ensure `from`/`to` are forwarded as additional query params

Both route handlers should pass query params through without re-validating them (hub owns validation).

---

## 2. Status Breakdown Drill-Through

### Problem

The pie chart displaying task distribution by status (completed, failed, pending, in-progress) is currently display-only. Users have no path from the chart to the underlying tasks.

### No New Hub Endpoint Required

The existing task list endpoint already supports status filtering:
```
GET /workspaces/:id/tasks?status=failed
```

### Dashboard UI Changes

#### Making the Status Distribution Clickable

Each segment of the status distribution (whether rendered as a pie chart slice or a summary card row) becomes a clickable element. Clicking navigates to the tasks page filtered by that status.

**Target URL:**
```
/workspaces/:id/tasks?status=<status>
```

Where `<status>` is one of: `completed`, `failed`, `pending`, `in_progress`.

#### Navigation vs. Inline Drawer Evaluation

Two approaches are possible:

**Option A: Navigate to tasks page** (recommended)

- Clicking a status segment calls `router.push('/workspaces/:id/tasks?status=failed')`
- The tasks page already renders with that filter applied (or gains the ability to, per the section below)
- Browser back button returns to analytics with full state restored via URL params
- No additional component complexity

**Option B: Inline drawer panel**

- A slide-in panel renders the filtered task list without leaving the analytics page
- Requires panel state management, a separate data fetch, and a task list sub-component extracted from the tasks page
- Adds meaningful complexity for marginal UX gain

Recommendation: Option A. Navigation is simpler, testable, and the URL-param analytics state means the back button returns to the correct view. The tasks page is already the right rendering surface for task lists.

#### Tasks Page Status Filter

Verify whether `/workspaces/:id/tasks` already reads `?status=` from the URL. If it does not:

- Add `searchParams.status` as a prop to the page server component
- Pass the value to the hub fetch: `GET /workspaces/:id/tasks?status=<value>`
- The existing hub tasks endpoint must support `status` as a query filter; confirm or add it

If the filter is already present, no tasks-page changes are needed beyond confirming the status values match what the hub accepts.

#### Visual Affordance

Chart segments and status rows should display a pointer cursor and a subtle hover state (background highlight or opacity shift) to signal interactivity. A tooltip on hover can read "View <status> tasks."

---

## 3. Trend Data (Phase 2)

> **Phase 2 (lower priority).** Design is included here for completeness. Implementation follows Phase 1 (date filter + drill-through) once those are stable.

### Hub Endpoint: `GET /workspaces/:id/analytics/trend`

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `from`    | ISO 8601 date string | Start of range, required |
| `to`      | ISO 8601 date string | End of range, inclusive. Defaults to now |
| `bucket`  | `day` or `week` | Time bucket granularity. Defaults to `day` |

Same date validation as the overview endpoint. `from` is required for this endpoint (unbucketed all-time trend is not useful).

**Request example:**
```
GET /workspaces/ws_abc/analytics/trend?from=2026-05-01&to=2026-05-27&bucket=week
```

**Response shape:**
```json
{
  "bucket": "week",
  "period": {
    "from": "2026-05-01",
    "to": "2026-05-27"
  },
  "data": [
    { "period": "2026-W18", "created": 14, "completed": 11, "failed": 1 },
    { "period": "2026-W19", "created": 22, "completed": 19, "failed": 2 },
    { "period": "2026-W20", "created": 18, "completed": 15, "failed": 0 },
    { "period": "2026-W21", "created": 9, "completed": 6, "failed": 1 }
  ]
}
```

- `period` strings use ISO 8601 week notation (`YYYY-Www`) for `bucket=week` and `YYYY-MM-DD` for `bucket=day`
- Buckets with zero activity are included in the response (not omitted) so the chart can render a continuous axis
- SQLite bucketing expressions:
  - Daily: `strftime('%Y-%m-%d', datetime(created_at / 1000, 'unixepoch'))`
  - Weekly: `strftime('%G-W%V', datetime(created_at / 1000, 'unixepoch'))` (`%G` = ISO week-numbering year, `%V` = ISO week number 1-53; do not use `%Y-W%W` which produces non-ISO week numbering)

**Dashboard UI:**

- Bar chart rendered below the status distribution on the Overview tab
- Toggle between "Daily" and "Weekly" bucket; persists in URL as `&bucket=day` or `&bucket=week`
- Shows three series: created, completed, failed
- Only rendered when the data array contains more than one bucket (a single-bucket window does not benefit from a trend chart)
- Axis labels formatted to match the bucket type

---

## 4. Tests Required

All new hub endpoints require the following test coverage. Tests live alongside existing tests in `src/routes/`.

### `GET /workspaces/:id/analytics/overview`

| Case | Expected |
|------|----------|
| No auth token | `401 Unauthorized` |
| Valid token, no date params | Returns all-time stats |
| Valid `from` and `to` | Returns stats scoped to that window |
| `from` after `to` | `400 Bad Request` |
| Range exceeds 365 days | `400 Bad Request` |
| Valid range, no tasks in period | Returns all-zero counts, `completionRate: 0`, `avgCompletionTimeMs: null` |
| Workspace not found or user not a member | `404 Not Found` |

### `GET /agents/performance?workspaceId=<id>` (extended)

| Case | Expected |
|------|----------|
| No date params | Existing all-time behavior unchanged |
| Valid `from` and `to` | Counts reflect only tasks in that window |
| `from` after `to` | `400 Bad Request` |
| Range exceeds 365 days | `400 Bad Request` |
| Valid range, no tasks in period | Returns agents with all-zero counts |

### `GET /workspaces/:id/analytics/trend` (Phase 2)

| Case | Expected |
|------|----------|
| No auth token | `401 Unauthorized` |
| Missing `from` | `400 Bad Request` |
| `from` after `to` | `400 Bad Request` |
| `bucket=day`, known data | Returns correct daily buckets including zero-activity days |
| `bucket=week`, known data | Returns correct ISO week buckets |
| `bucket` invalid value | `400 Bad Request` |

---

## 5. Implementation Sequence

### Phase 1

1. **Hub:** add date range params and validation to `GET /agents/performance?workspaceId=<id>`
2. **Hub:** implement `GET /workspaces/:id/analytics/overview` with date range support
3. **Hub tests:** cover all cases for both endpoints
4. **Dash proxy routes:** add `GET /api/hub/workspaces/[id]/analytics/overview`; update `GET /api/hub/agents/performance?workspaceId=<id>` proxy to forward date params
5. **Dash:** build `DateRangePicker` component with presets and URL persistence
6. **Dash:** wire `DateRangePicker` into the analytics page; update both tabs to pass date params to their fetches
7. **Dash:** make status distribution segments clickable with navigation to the tasks page
8. **Dash:** confirm or add `?status=` filter support on the tasks page

### Phase 2

9. **Hub:** implement `GET /workspaces/:id/analytics/trend` with daily/weekly bucketing
10. **Hub tests:** cover trend endpoint cases
11. **Dash proxy:** add `GET /api/hub/workspaces/[id]/analytics/trend`
12. **Dash:** add bar chart component to the Overview tab with bucket toggle

---

## Open Questions

- **Tasks page status filter:** needs a quick audit to confirm whether `?status=` is already supported before implementing drill-through. If it is, step 8 is a no-op.
- **Date input UX:** confirm whether a calendar picker library is available in the project or whether plain `<input type="date">` elements are preferred for the custom range inputs.
- **`avgCompletionTimeMs` definition:** computed as `completedAt - assignedAt` over completed tasks only (both columns must be non-null). In-progress tasks are excluded from the average (assumed yes in this design).
