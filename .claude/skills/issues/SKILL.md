---
name: issues
description: Schema and rules for issues/issues.json, the findings source of truth for forge-lab. Use when recording findings, triaging work, or closing issues.
---

# issues/issues.json

The cross-session findings DB. Chat history is NOT the source of truth; this file is.

## Schema

`{schemaVersion, nextId, issues: [...]}`. Each issue:

- `id` (int, from nextId; bump nextId when adding)
- `title` (one line), `detail` (root cause + file:line evidence where known)
- `category`: bug | reliability | security | observability | product | feature |
  cleanup | polish | docs | agents | maintenance | ops | design
- `area`: comma-joined package names (`forge-hub`, `forge-daemon`,
  `forge-dash-community`, `forge-agents`, `docs`, `ops`, `all`)
- `status`: open | in-progress | fixed | deferred | wont-fix
- `priority`: critical | high | medium | low
- `round`, `source`, `created`, `updated` (ISO dates)
- `resolution` (REQUIRED when closing: root cause + fix location, e.g.
  "pending_agent hardcode; fixed in tasks.ts:1800, test tasks.test.ts:T-fm-frontdoor")

## Rules

- Flip statuses AS WORK LANDS, not in an end sweep.
- Closing without a `resolution` is invalid.
- New findings get a new issue immediately, even mid-task - do not hold them in
  conversation memory.
- `ops`-area issues marked human-only (leaked tokens, prod fleet, live secrets) are
  NEVER attempted by agents; they exist so the milestone plan can gate on them.
- Issues 1-42 were seeded by the 2026-07-07 product pass; their `source` values name
  the audit that found them (e2e-smoke-run, reliability-audit, dashboard-audit,
  docs-audit, backlog-mining, agents-once-over, docs/handoff/HANDOFF.md).
- Every bug fix ships with a failing-first test (Adam's standing rule) - reference
  the test in the resolution.
