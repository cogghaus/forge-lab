# forge-lab UI mockups

**Status:** finalized design reference. Three clickable HTML mockups of the forge-lab dashboard vision. No build step, no dependencies, open directly in any browser.

## Files

- **`forge-community.html`** - community edition desktop dashboard. HeroUI primitives only. Tasteful dark theme, static glow on working agent cards, temperature states reflected in gradient palette only. No particles, no embers, no number ticker, no confetti. This is what ships in the public MIT repo as `forge-dash-community`.

- **`forge-pro.html`** - personal pro edition desktop dashboard. HeroUI + approximated Magic UI Pro visual layer. Canvas particle background that responds to temperature (cold = sparse blue, warm = orange sparks, hot = gold shower). Breathing glow on working agents, rising ember sparks from the top edge of the hottest cards, number ticker animation on counters, confetti on "mark complete." This is the direction `forge-dash-pro/packages/dash` is heading for Adam's personal use at `forge.cogg.haus`.

- **`forge-mobile.html`** - mobile dispatcher in a 390x844 iPhone frame. Pro aesthetic (breathing glow, embers, temperature particles in the ambient gradient). Single-column thumb-driven layout: attention panel pinned to top when something needs you, big agent cards with progress and live status message, compact hub summary, idle-agent summon grid, recent activity. FAB bottom-right opens a dispatcher bottom sheet with create-task / intervene / spawn actions. This is the Phase 3 "monitor your forge from anywhere" killer view.

## Design decisions captured here

- **Color palette and typography** match the notez note `forge-lab: Pixel's Design Vision` exactly (`#0D0D0F`, `#FF6B2B`, `#FFB547`, `#4A9EFF`, `#2DD4A0`, `#FF4757`, `#F5F0EB`, JetBrains Mono headings, Inter body)
- **Workshop floor layout** - pipeline pillars across the top, agent ring in the middle (4x2 grid, NOT literal circle - we tried a circular ring variant and rejected it; grid won), activity stream and devices side-by-side at the bottom
- **Heat indicators** - static box-shadow in community, breathing animation + rising ember particles on the hottest cards in pro
- **Temperature system** - cold/warm/hot states affect the background gradient in community; additionally drive a canvas particle system in pro
- **Task display pattern** - icon + ticket + title (with marquee scroll when overflowing) + assigned agent. Applied everywhere tasks are listed: pillar summaries, pillar popups, agent tiles, agent detail modal, task detail modal, mobile agent cards
- **Loki is visually recessed** in both editions (dim tile, "hub-side" status label) because Loki is a Hub-side voice, not a spawnable worker, per vibe-forge's own convention and Loki's own FL-001 review
- **Mobile = pro aesthetic** - the mobile dispatcher is the "monitor from anywhere" killer feature which is essentially the pro experience. The community mobile view would dial animations down but keep the same layout

## How to view

Double-click any file or open via `file://` in any modern browser. They are fully self-contained; the only network calls are to cdn.tailwindcss.com and fonts.googleapis.com for Tailwind and JetBrains Mono / Inter. If you are offline and fonts are missing, Tailwind still renders with system fallbacks.

## Interactive bits to try

- **Click the temperature pill at the top right** (🌡 warm by default) to cycle `warm → hot → cold → warm`. In community edition only the background gradient shifts. In pro edition the particle system responds visibly, and the `hot` state adds a pulsing glow to the pill itself.
- **Click a pipeline pillar** (Pending / Active / Review / Complete) to see a filtered task list modal with full ticket + title + assigned agent per item.
- **Click any agent tile** in the ring to see an agent detail modal with stats, current task, and recent activity.
- **Click a task ID** in the activity stream or in a pillar popup to see the full task detail modal with timeline, description, and mid-task instruction controls.
- **Click "mark this task complete"** inside a task detail modal in the pro edition to see the confetti effect.
- **On mobile, tap the 🔥 FAB** bottom-right to open the dispatcher bottom sheet with create-task / intervene / spawn actions.
- **On mobile, tap the red attention panel** to open the FL-REV-004 decision sheet.
- **Press Escape** or click outside a modal to close it.

## What's NOT here

- Login form, settings, user menu, notifications (all Phase 2-3 deliverables)
- Real data or wiring to a running hub
- Tablet / foldable split layout (Phase 3)
- Command palette (Cmd+K) - stub in the vision, not in the mockup
- Actual Magic UI Pro components - the pro edition approximates them with vanilla CSS/JS. Real implementation uses the licensed library.
- The community mobile variant - the mobile dispatcher IS the pro aesthetic because that's where mobile fits in the killer use case

## Comparison: community vs pro

Side-by-side is the intended use. Open both desktop files in adjacent browser windows. Same data, same layout, same interactions. The only differences are visual fidelity:

| Feature | Community | Pro |
|---|---|---|
| Dark palette | Yes | Yes |
| Typography (JetBrains Mono + Inter) | Yes | Yes |
| Icon + ticket + title (marquee) pattern | Yes | Yes |
| Pillar popups with title + assigned agent | Yes | Yes |
| Agent heat glow | Static box-shadow | Breathing animation |
| Rising ember sparks on hottest cards | None | Yes (replaced the rejected rotating border beam) |
| Particle background | None | Canvas system, temperature-responsive |
| Number ticker count-up | None | On load |
| Status dot pulse | None | On active / live dots |
| Progress bar shimmer | None | Traveling highlight across filled bars |
| Confetti on complete | None | Radial burst from click origin |
| Temperature pill glow | Muted border | Pulsing shadow, stronger at hot |
| Background gradient | Static palette shift | Shifts intensity with temperature |

Feature parity is mandatory between editions. Community users do not lose any functionality, they just do not get the atmospheric layer.

## Relationship to notez design vision

These mockups implement the "The Forge" vision from the notez note `forge-lab: Pixel's Design Vision` (Date: 2026-04-08). The palette hex codes, typography, "workshop floor" layout, agent heat indicators, pipeline pillars, and temperature system are drawn directly from that note. The ASCII sketch in the notez vision of the workshop floor layout is rendered here in HTML.

The mockups add a few elements beyond the vision note:

- Concrete task detail and agent detail modals with timeline + mid-task instruction controls (derived from the architecture note's task lifecycle and dispatcher coordination protocol)
- Rising ember particles on hot cards (the vision note described "particle effects on events" for task completions; we extended it to ongoing heat indicators)
- Pillar popups showing full task lists with icons and titles (the vision note sketched the pillars as summary counters only)
- Mobile dispatcher layout and bottom sheet pattern (the vision note mentioned mobile as a phase 3 deliverable but didn't sketch it)

Rejected variant: a literal circular agent ring (hub at center, agents positioned at 45-degree intervals around the perimeter with SVG connection lines). Built as `forge-pro-ring.html`, reviewed, and removed. The grid layout carries more data density and is more scannable as a daily-driver dashboard. The ring idea is preserved here for posterity if a future "Hub view" toggle wants to revisit it.

## Fate of these files

These are preserved as the canonical design reference for the visual identity and workshop-floor layout. Color palette, typography, heat states, badge styles, pipeline pillars, activity stream, and agent card patterns are all still authoritative.

**2026-05-24 direction update:** The community/pro product split is retired. One consolidated dashboard ships everything. Visual fidelity (particles, breathing glows, confetti) becomes a reduce-motion toggle, not a product tier. The layout model has also shifted from workshop-floor-as-homepage (full-page, no nav) to a **left-rail navigation shell** inspired by BridgeMind/Paperclip/Linear — the workshop floor content moves into the main content area of that shell. The agent ring moves from a 4x2 grid in the main area to an inline agent list in the left rail with per-agent progress bars and status dots.

See `docs/forge-dash/01-consolidated-dashboard.md` for the current design target.
