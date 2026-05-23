# forge-dash-community: Workspace UI Sketch

**Author:** Adam (with Claude)
**Date:** 2026-05-13
**Status:** Design exploration, ready for review
**Related:** `docs/paperclip-integration/00-integration-plan.md`, `mockups/forge-community.html`

---

## 1. Scope and Framing

This document sketches the UI additions needed to support workspaces (multi-tenancy) in `forge-dash-community`. It is NOT a redesign. The existing community mockup (`mockups/forge-community.html`) and Pixel's Design Vision (in notez) are settled and authoritative. This doc shows how the workspace concept threads through that existing design.

The Paperclip integration plan introduces these new concepts that need UI surfaces:

- Workspaces (the tenancy unit)
- Workspace members and roles
- Invites (admin-initiated, for Pam onboarding)
- Goals (top-level objectives with child tasks)
- Approvals (governance gates)
- Costs and budgets (per agent, per workspace)
- Run history (heartbeat execution records)

Each surface is a new screen or chrome addition. The workshop floor (pipeline pillars, agent ring, activity stream, devices) stays exactly as designed; it just gets scoped to the currently-selected workspace.

---

## 2. Visual Identity (preserved from existing mockups)

From `context/project-context.md` and the existing mockups, these are not up for debate:

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
| `--orange` | `#FF6B2B` (forge flame, primary accent) |
| `--gold` | `#FFB547` |
| `--blue` | `#4A9EFF` |
| `--green` | `#2DD4A0` |
| `--red` | `#FF4757` |

- Typography: Inter for body, JetBrains Mono for headings, IDs, badges, numeric data
- Heat states: `idle`, `warm`, `hot`, `standby`, `offline` (box-shadow only, no animation in community)
- No emdashes anywhere
- HeroUI v3 primitives only in this package; nothing from Magic UI Pro

Loki is visually recessed everywhere as a hub-side voice (dim tile, "hub" status label, never a spawnable worker).

---

## 3. Navigation Model

The existing top bar holds: logo, name, edition badge, temperature pill, active count, settings, user avatar. The existing layout has no navigation chrome below the top bar because there is only one screen.

With workspaces, we add two things:

**A workspace switcher** in the top bar, positioned between the logo group and the right-side controls. This is the most-used control after login; it gets prominent placement.

**Nav tabs** below the top bar, scoped to the current workspace. The default tab is "Workshop" which renders the existing workshop floor design. Other tabs unlock progressively per phase.

```
+----------------------------------------------------------------------+
| 🔥 forge-lab [community]   [Adam's Workspace ▼]      🌡 warm  2 active  ⚙ A |
+----------------------------------------------------------------------+
|  Workshop   Goals   Members   Approvals(2)   Costs   Runs   Settings |
+----------------------------------------------------------------------+
|                                                                       |
|                       [ current tab content ]                         |
|                                                                       |
+----------------------------------------------------------------------+
```

Rationale for tabs vs left sidebar: the workshop floor is wide (4-column pipeline pillars, 4-column agent ring). A left sidebar would compress it. Horizontal tabs are how Linear and GitHub handle workspace navigation; they preserve full canvas width for the primary view.

---

## 4. Workspace Switcher Behavior

The switcher is a button with the current workspace name and a chevron. Clicking opens a dropdown:

```
+----------------------------------+
| MY WORKSPACES                    |
|                                  |
| ● Adam's Workspace      owner    |  <- current, highlighted
| ○ Pam's Pottery Studio  viewer   |
| ○ Sugar Crash Studios   admin    |
|                                  |
| ----                             |
|                                  |
| SHARED WITH ME                   |
|                                  |
| ○ Pam's Wedding Plans   collab.. |
|                                  |
| ----                             |
|                                  |
| + Create workspace               |
| > Workspace settings...          |
+----------------------------------+
```

Grouping rules:
- "My workspaces" are owned by the current user
- "Shared with me" are workspaces where the user is a member but not the owner
- Each entry shows the user's role in that workspace as a badge

Switching is client-side: replace the workspace context, fetch the new workspace's data, no full page reload. URL updates from `/w/adam/workshop` to `/w/pam-pottery/workshop`. If the new workspace doesn't have a "Workshop" surface yet (it always does), redirect to the workspace home.

Slugs (not UUIDs) in URLs. `adam` and `pam-pottery` are shareable, memorable, and look right in browser history. Slug is set at workspace creation, immutable after, unique per-user. (UUIDs stay in the database and API; the dashboard does the slug-to-id mapping.)

---

## 5. Screens by Phase

The same UI ships through Phase 2, but tabs and widgets unlock as features land. Until a feature is built, its tab is hidden from the nav (not greyed out, just absent).

| Tab | Unlocks | Description |
|---|---|---|
| Workshop | P2.0.1 | Existing workshop floor, scoped to current workspace |
| Members | P2.0.1 | Member list, role management, invite button (admin/owner only) |
| Settings | P2.0.1 | Workspace name, description, budget (when P2.2.4 lands), delete |
| Goals | P2.1.3 | Tree of goals with progress; create/edit goals; drag tasks onto goals |
| Runs | P2.2.3 | Heartbeat run history with filters; click for full output |
| Costs | P2.2.4 | Per-workspace and per-agent spend, budget thresholds |
| Approvals | P2.3.2 | Pending approval queue with approve/reject/revise actions; badge shows count |

Admin-only routes live outside the workspace context:

| Route | Unlocks | Description |
|---|---|---|
| `/admin/invites` | P2.0.4 | Create invite, list outstanding invites, revoke |
| `/admin/users` | future | User management (currently just first-admin + signups disabled) |
| `/signup/:token` | P2.0.4 | One-time invite acceptance page Pam visits |

---

## 6. Per-Screen Sketches

### 6.1 Workshop (the existing design, workspace-scoped)

No visual changes from `forge-community.html`. The data displayed (`STATE.pipeline`, `STATE.agents`, `STATE.devices`, `STATE.temperature`) is now scoped to the current workspace. Switching workspaces re-fetches all of it.

Optional addition once P2.2.4 lands: a budget pip in the top bar showing `$12 / $50` or a percentage. Hover for breakdown.

### 6.2 Members

```
+---------------------------------------------------------------+
| WORKSPACE MEMBERS                                  + Invite   |
+---------------------------------------------------------------+
|                                                               |
| ● Adam Coggrave                                               |
|   adam@... · joined Apr 14                          [owner]   |
|                                                               |
| ● Pam ........                                                |
|   pam@... · joined May 20                        [collab... ▼]|
|                                                               |
+---------------------------------------------------------------+
| PENDING INVITES                                               |
+---------------------------------------------------------------+
|                                                               |
| ○ assistant@cogg.haus                                         |
|   invited 2d ago by Adam · expires in 5d        [revoke]      |
|                                                               |
+---------------------------------------------------------------+
```

- Role badges use the existing badge styles (`badge-pending` etc); add `badge-owner` (orange tint, matches accent)
- Role dropdown lets owner/admin change a collaborator's role or remove them
- Invite button opens a modal: email input, role selector, optional note, generate link button
- Generated invite link is shown for copy-paste (no SMTP in v1, per the plan)

### 6.3 Goals

```
+-----------------------------------------------------------+
| GOALS                                          + New goal |
+-----------------------------------------------------------+
|                                                           |
| 🎯 Ship Phase 2 multi-tenancy             ████████░░ 80%  |
|    8 tasks · 6 done · 2 in progress                       |
|    └─ FL-101  Workspaces tables           ✓               |
|    └─ FL-102  Scope existing tables       ✓               |
|    └─ FL-103  Workspace auth middleware   ⏵ in progress   |
|    └─ FL-104  Atomic claim fix            ⏵ in progress   |
|                                                           |
| 🎯 Ship Phase 2 heartbeat model           ░░░░░░░░░░ 0%   |
|    0 tasks                                                |
|                                                           |
+-----------------------------------------------------------+
```

- Goal cards expand inline to show child tasks (recursive CTE on the backend)
- Progress bar uses the existing `.bar` and `.bar-fill` styles
- Click a goal title to open the goal detail page (`/w/:slug/goals/:id`)
- Task ids link to the task detail modal (matches existing pattern from workshop floor)
- New goal modal: title, description, status (defaults to `active`)

### 6.4 Approvals

```
+-----------------------------------------------------------+
| PENDING APPROVALS                                         |
+-----------------------------------------------------------+
|                                                           |
| 🛡 HIRE AGENT                                              |
|    Planning Hub wants to hire: Custodian (cleanup agent)  |
|    requested 12m ago · runtime: claude-code               |
|    [Approve]  [Reject]  [Request revision]                |
|                                                           |
| ⚖ EXECUTE STRATEGY                                         |
|    Architect proposes: refactor task router               |
|    requested 1h ago                                       |
|    [Approve]  [Reject]  [Request revision]                |
|                                                           |
+-----------------------------------------------------------+
| RESOLVED (last 7 days)                                    |
+-----------------------------------------------------------+
|                                                           |
| ✓ Hire agent: Scribe                                      |
|   approved by Adam · 3 days ago                           |
|                                                           |
| ✗ Execute strategy: bypass review gates                   |
|   rejected by Adam · 5 days ago · "no, never"             |
|                                                           |
+-----------------------------------------------------------+
```

- Tab badge shows pending count (e.g., `Approvals (2)`)
- "Request revision" opens a textarea modal so the requesting agent gets context
- Resolved section is collapsible, defaults open if there are recent items

### 6.5 Costs

```
+-----------------------------------------------------------+
| THIS MONTH (May 2026)                                     |
|                                                           |
| $42.18 / $100 budget                                      |
| ████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  42%               |
|                                                           |
+-----------------------------------------------------------+
| BY AGENT                                                  |
+-----------------------------------------------------------+
| 🔨 Anvil       $18.42  ████░░░░░░  37% of cap             |
| 🧪 Crucible    $12.10  ██░░░░░░░░  24% of cap             |
| 🏛️ Architect    $7.66  █░░░░░░░░░  15% of cap             |
| ⚖️ Temper       $3.20  █░░░░░░░░░   6% of cap             |
| 🎭 Loki         $0.80  ░░░░░░░░░░   2% of cap             |
+-----------------------------------------------------------+
| RECENT RUNS                                               |
| (table: agent / run id / model / tokens / cost / time)    |
+-----------------------------------------------------------+
```

- Workspace total bar uses orange-to-gold gradient; turns red at 100%
- Per-agent rows show their individual budget cap progress
- Recent runs table links to run detail when clicked
- "Increase budget" button (owner only) opens an inline editor

### 6.6 Settings

```
+-----------------------------------------------------------+
| WORKSPACE SETTINGS                                        |
+-----------------------------------------------------------+
|                                                           |
| Name        [ Adam's Workspace                      ]     |
| Slug        [ adam                                   ]    |
| Description [                                       ]     |
|                                                           |
| ----                                                      |
|                                                           |
| Monthly budget (cents)  [ 10000  ] = $100.00              |
| Warning threshold       [ 80 ] %                          |
|                                                           |
| ----                                                      |
|                                                           |
| DANGER ZONE                                               |
|                                                           |
| [ Archive workspace ]    [ Delete workspace ]             |
|                                                           |
+-----------------------------------------------------------+
```

- Only owner sees danger zone
- Slug field is read-only after creation (per §4)
- Archive vs delete: archive hides from switcher and disables agents but keeps data; delete is irreversible after a confirmation dialog with the workspace name retyped

---

## 7. Component Inventory

Most components come from HeroUI v3 primitives. New compositions on top:

| Component | Type | Notes |
|---|---|---|
| `WorkspaceSwitcher` | Custom | HeroUI Dropdown + Avatar/Badge composition |
| `WorkspaceTabs` | Custom | HeroUI Tabs scoped to workspace context |
| `MemberRow` | Custom | List item with avatar, role badge, role dropdown |
| `InviteModal` | Custom | HeroUI Modal + Input + Select + copy-to-clipboard |
| `GoalCard` | Custom | Expandable card with `.bar` progress + task list |
| `ApprovalCard` | Custom | Card with action buttons + payload renderer |
| `BudgetBar` | Custom | Wraps `.bar` with threshold-aware coloring |
| `RoleBadge` | Custom | Extends existing `.badge` with new variants |
| `WorkspaceContext` | Provider | React context for current workspace; consumed by every screen |

`RoleBadge` variants to add:
- `badge-owner` (orange fill, like forge flame, the strongest visual claim)
- `badge-admin` (orange outline)
- `badge-collaborator` (white-low outline, neutral)
- `badge-viewer` (white-very-low, dimmed)

Loki recess rule extends here: if a member's role is `viewer`, their row gets `opacity: 0.7` and the role badge gets the dimmed variant. Visual hierarchy reflects authority.

---

## 8. Progressive Disclosure Rules

A user might be on a server running P2.0 only (workspaces exist, but no goals/approvals/costs yet). The dashboard must not show empty stubs for unbuilt features.

Implementation: feature flags returned from the hub's `/healthz` or a new `/capabilities` endpoint. The frontend reads the list once at app load and hides tabs/widgets for any feature flag that returns false.

```typescript
// Sketch
interface HubCapabilities {
  goals: boolean;       // P2.1.3
  runs: boolean;        // P2.2.3
  costs: boolean;       // P2.2.4
  approvals: boolean;   // P2.3.2
  budgetEnforcement: boolean; // P2.3.1
}
```

The nav tabs component filters its tab list against capabilities. The same flag system controls the in-workshop budget pip (only renders if `costs` and `budgetEnforcement` are both true).

---

## 9. Edge Cases and Behaviors

**First login, no workspaces yet.** New user (Pam) accepts an invite to Adam's workspace. After signup she lands in that workspace by default. If she creates her own, the switcher updates without reload.

**Last admin tries to leave.** Workspace must have at least one owner. Removing the last owner is rejected at the API; UI shows a tooltip on the disabled remove button.

**Member deleted from auth but referenced in history.** Soft-delete (deactivate flag) instead of hard delete. Activity log entries keep showing their name with a "(former member)" suffix.

**Switching workspace mid-task.** If the user is viewing a task detail modal and switches workspace, the modal closes (the task may not exist in the new context). No silent data leak.

**Invite link shared accidentally.** Tokens are single-use and expire (7 days default). Once consumed, the link returns 410 Gone. Owner can revoke an outstanding invite from the Members page.

**Workspace deletion.** Deletes cascade: agents, tasks, goals, approvals, costs, runs, history. Activity log entries in OTHER workspaces (none, in practice) stay. Outstanding invites are revoked.

---

## 10. Open Questions

1. Should the workshop floor's temperature pill be per-workspace or per-user? (Recommend per-workspace; switching workspaces shouldn't carry temperature.)
2. Where do shared agents fit, if anywhere? (Probably nowhere in v1: agents are workspace-scoped. Pam can't borrow Adam's Anvil; she gets her own Anvil if she wants one. Forge templates in P2.4.4 are the answer to "I want what Adam has.")
3. Cmd+K command palette across workspaces, or per-workspace? (Per-workspace for v1. Cross-workspace search is a later flourish.)
4. Mobile dispatcher view: should it gain a workspace switcher too? (Yes, but the mockup at `mockups/forge-mobile.html` predates workspaces. New design pass needed for the mobile workspace switcher; defer until after desktop ships.)
5. Per-workspace branding (custom name color, custom logo)? (Defer. The "Pam's Pottery" workspace concept is fine for v1 without branding.)
6. Workspace activity feed: workspace-scoped, or does the existing activity stream become workspace-aware automatically? (Automatic. The activity stream queries `entity_history WHERE workspace_id = current`. No new component.)

---

## 11. What's Deferred

- Mobile workspace switcher and mobile-specific workspace UIs
- Forge template import/export UI (P2.4.4, full design after backend ships)
- Cross-workspace search
- Workspace-level audit log dashboard (raw entity_history table is enough for v1)
- Org chart visualization (P2.4.1 backend ships first; UI design comes later)
- Role permission matrix editor (the four roles are fixed in v1; no custom roles)
- SSO / SAML (not on roadmap)
- Public workspaces or discoverable workspaces (not on roadmap)

---

## 12. Source References

- `mockups/README.md` (design language source of truth)
- `mockups/forge-community.html` (current dashboard implementation)
- `context/architecture.md` (constraints, dispatcher coordination patterns)
- `context/project-context.md` (HeroUI v3, palette, typography decisions)
- `docs/paperclip-integration/00-integration-plan.md` (which features need UI in which phase)
- Notez `forge-lab: Pixel's Design Vision` (source of palette, layout, temperature system)
