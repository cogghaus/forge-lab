# forge-dash: Consolidated Dashboard Design

**Author:** Pixel (with Adam)
**Date:** 2026-05-24
**Status:** Active design direction — supersedes community/pro split and the workshop-floor-as-homepage model
**Replaces:** `docs/forge-dash-community/00-workspace-ui-sketch.md` (workspace tab model)

---

## 1. Decision Record

**Consolidated single tier.** The community/pro distinction is retired as a product tier. One dashboard ships everything — pipeline pillars, agent ring, activity stream, skills, costs, settings. Visual fidelity (particles, breathing glows) becomes a user preference toggle ("reduce motion"), not an edition gate.

**Left-rail navigation.** The workshop-floor-as-homepage model (full-width pipeline + agent ring) served a passive monitor use case. The target is an active workspace — project and task management, agent oversight, cost tracking — closer to BridgeMind/Paperclip/Linear in navigation model. A left rail preserves full canvas width for the main content area while making all surfaces reachable without tabs-per-workspace.

---

## 2. Visual Identity (unchanged)

From the existing mockups and Pixel's Design Vision. These are not up for debate.

| Token | Value |
|---|---|
| `--bg` | `#0D0D0F` |
| `--card` | `#1A1A1F` |
| `--card-hi` | `#24242C` |
| `--border` | `rgba(255,255,255,0.06)` |
| `--border-hi` | `rgba(255,255,255,0.12)` |
| `--text` | `#F5F0EB` |
| `--text-dim` | `rgba(245,240,235,0.6)` |
| `--text-mute` | `rgba(245,240,235,0.35)` |
| `--orange` | `#FF6B2B` |
| `--gold` | `#FFB547` |
| `--blue` | `#4A9EFF` |
| `--green` | `#2DD4A0` |
| `--red` | `#FF4757` |

Typography: Inter body, JetBrains Mono for all headings, IDs, badges, counters, status labels.

---

## 3. Layout Model

```
+-------------------------------------------------------------------------+
| 🔥 forge-lab                                            🌡 warm   ⚙  A |
+------------------------+------------------------------------------------+
|                        |                                                |
| WORKSPACES             |    [Main content area — changes by nav]        |
| ▸ Sugar Crash   3 act  |                                                |
|   my-project    1 act  |                                                |
|                        |                                                |
| + New workspace        |                                                |
|                        |                                                |
| ──────────────────     |                                                |
|                        |                                                |
| TASKS                  |                                                |
| All tasks              |                                                |
| + New task             |                                                |
|                        |                                                |
| ──────────────────     |                                                |
|                        |                                                |
| AGENTS                 |                                                |
|                        |                                                |
| ● Anvil   [active]     |                                                |
|   ████████░░  FL-042   |                                                |
|   reviewing auth PR    |                                                |
|                        |                                                |
| ○ Furnace  [idle]      |                                                |
|                        |                                                |
| ○ Crucible [idle]      |                                                |
|                        |                                                |
| ○ Sentinel [waiting]   |                                                |
|   ─────░░░░  queued    |                                                |
|                        |                                                |
| ○ Scribe  [offline]    |                                                |
|                        |                                                |
| ──────────────────     |                                                |
|                        |                                                |
| SKILLS                 |                                                |
| ORG                    |                                                |
| COSTS            $4.2  |                                                |
| SETTINGS               |                                                |
|                        |                                                |
+------------------------+------------------------------------------------+
```

**Left rail width:** 220px fixed (collapsible to 48px icon rail at `<768px`).
**Top bar:** sticky, `bg-background/90` with backdrop blur, height 52px.
**Main content:** fills remaining width, scrollable, max unconstrained (data-dense dashboard).

---

## 4. Top Bar

```
+-------------------------------------------------------------------------+
| 🔥 forge-lab                [workspace switcher ▼]    🌡 warm   ⚙  A  |
+-------------------------------------------------------------------------+
```

Left: logo lockup (flame + "forge-lab" in JetBrains Mono bold).
Center: workspace switcher dropdown (shows current workspace name + chevron). Opens dropdown matching existing spec in `00-workspace-ui-sketch.md §4`.
Right: temperature pill (cycles cold/warm/hot) + active count + settings icon + user avatar/initial.

The top bar does NOT contain navigation tabs. All navigation lives in the left rail.

---

## 5. Left Rail — Section Breakdown

### 5.1 Workspaces

```
WORKSPACES
▸ Sugar Crash Studios   3        ← active, expanded, task count badge
    Workshop                     ← sub-item: current view
    Tasks
    Goals
    Members
    Settings
  my-project            1        ← collapsed, click to expand
  
+ New workspace
```

- Workspace row: name (truncated) + active task count badge
- Expanded workspace shows sub-items: Workshop, Tasks, Goals, Members, Settings
- Only one workspace expanded at a time
- "Workshop" sub-item navigates to the pipeline+activity-stream view scoped to that workspace

### 5.2 Tasks

```
TASKS
  All tasks              ← cross-workspace task list
  + New task
```

When a workspace is active and expanded, "Tasks" shows that workspace's tasks. Without an active workspace it shows all tasks across all workspaces.

### 5.3 Agents

Agent ring reimagined as a vertical agent list with inline status. This is the most changed section from the original mockup.

```
AGENTS

● Anvil         active
  ████████░░    FL-042
  reviewing auth PR

○ Furnace       idle

○ Sentinel      waiting
  ─────░░░░     2 queued

◌ Scribe        offline
```

**Dot states:**
- `●` filled orange = active (task in progress)
- `●` filled blue = idle (ready, no task)
- `●` filled amber = waiting (task queued, not yet started)
- `◌` hollow dim = offline (agent not spawned)

**Progress bar:** renders only when agent has an active task. Orange fill, 6px height, border-radius 3px. Width derived from task progress (0-100%). When progress is unknown, shows an indeterminate shimmer.

**Task reference:** ticket ID + one-line description, truncated. Clicking navigates to that task's detail view.

**Agent detail panel:** clicking the agent name opens a detail panel in the right portion of the main content area (not a modal, not a new route). The panel shows:
- Agent stats (tasks completed, avg duration, total cost)
- Current task with full description
- Recent activity log (last 10 events)
- Controls: pause / intervene / spawn new instance

### 5.4 Skills

```
SKILLS
  Browse skills
  + Register skill
```

Skills page lists all registered skills/tools available to agents: name, description, which agents can use it, usage count, cost-per-call.

### 5.5 Org

```
ORG
  Orchestrator
  Agent roster
  Roles
```

Org section shows the hub structure: orchestrator config (heartbeat interval, dispatcher settings), full agent roster with spawn settings, role definitions and permissions.

### 5.6 Costs

```
COSTS                   $4.20
  This month
  By workspace
  By agent
```

Cost total badge on the nav item (this month). Costs page shows spend breakdown: by workspace, by agent, by skill call, by run. Date range filter. Export CSV.

### 5.7 Settings

```
SETTINGS
  Profile
  API keys
  Notifications
  Danger zone
```

---

## 6. Main Content Views

### 6.1 Workshop (default when workspace selected)

Pipeline pillars + activity stream side by side. This is the existing mockup layout (`forge-community.html`) rendered within the main content area instead of full-page.

```
+----------------------------------------------------------------+
| Sugar Crash Studios — Workshop                    🟠 2 active  |
+----------------------------------------------------------------+
|                                                                |
|  PIPELINE                                                      |
|  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐      |
|  │ Pending  │  │  Active  │  │  Review  │  │ Complete │      |
|  │    4     │  │    2     │  │    1     │  │   18     │      |
|  │ click ▼  │  │ click ▼  │  │ click ▼  │  │ click ▼  │      |
|  └──────────┘  └──────────┘  └──────────┘  └──────────┘      |
|                                                                |
|  ACTIVITY STREAM                                               |
|  ┌──────────────────────────────────────────────────────┐     |
|  │ ● Anvil       FL-042  review complete       2m ago   │     |
|  │   Sentinel    FL-041  assigned               5m ago  │     |
|  │ ● Furnace     FL-040  build started          8m ago  │     |
|  │   ...                                               │     |
|  └──────────────────────────────────────────────────────┘     |
|                                                                |
+----------------------------------------------------------------+
```

Clicking a pipeline pillar opens a slide-over panel with the full task list for that status (existing pillar popup behavior from mockup).

### 6.2 Tasks view

Full task list for the current workspace. Sortable by status, priority, agent, goal. Inline status chips. Clicking a task opens the task detail panel (same right-side panel pattern as agent detail).

### 6.3 Task Detail panel

Slides in from the right, does not navigate away from the current view. Shows:
- Task header: ID, title, status chip, priority chip
- Description
- Assigned agent (with link to agent detail)
- Goal link
- Timeline / event log (existing task history)
- Action buttons: reassign / cancel / add instruction
- Mid-task instruction field (dispatcher intervention)

### 6.4 Agent Detail panel

Slides in from the right when an agent in the left nav is clicked.

### 6.5 Goals

Existing goals tree view (already built). Goal cards expand inline.

### 6.6 Skills, Org, Costs, Settings

Standard full-width content pages. No panel pattern needed.

---

## 7. Responsive behavior

| Breakpoint | Layout |
|---|---|
| `>= 1024px` | Left rail 220px + main content |
| `768–1023px` | Left rail collapsed to 48px icon rail; hover/click expands as overlay |
| `< 768px` | Rail hidden; hamburger opens as sheet from left |

---

## 8. Implementation phases

### Phase A — Shell (nav + routing)
- Left rail component with all sections, active state, collapse behavior
- Route structure: `/`, `/tasks`, `/agents`, `/agents/[id]`, `/skills`, `/org`, `/costs`, `/settings`
- Workspace context: switcher in top bar, workspace sub-items in rail
- Top bar with logo, workspace switcher, temperature pill placeholder, user avatar

### Phase B — Workshop view
- Pipeline pillars (static counts, click to open list panel)
- Activity stream (real-time via polling or SSE)
- Scope to current workspace

### Phase C — Agent rail (live)
- Wire agent list to real hub agent data
- Inline progress bars
- Agent detail panel

### Phase D — Supporting views
- Skills page
- Org page
- Costs page (requires hub cost tracking)
- Settings pages

---

## 9. What this replaces

- The workshop-floor-as-homepage (full-page pipeline + agent ring) — content preserved, moved inside left-rail layout
- The horizontal tab model per workspace (`Tasks | Goals` tabs) — replaced by workspace sub-items in left rail
- The community/pro product split — one dashboard, all features, reduce-motion toggle for animation intensity
- The circular agent ring variant (already rejected) — agent list in left rail is the settled pattern
