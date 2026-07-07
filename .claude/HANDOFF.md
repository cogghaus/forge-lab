# forge-lab session handoff (.claude/HANDOFF.md)

Read this first in any new session. Repo state and scope live in
`docs/handoff/HANDOFF.md` (authoritative, 2026-06-20); this file adds the working
infrastructure created by the product pass of 2026-07-07 and the orchestration
protocol for multi-agent sessions.

## Where things are

- **Findings source of truth:** `issues/issues.json` (42 issues seeded 2026-07-07 from
  a full product pass: docs audit, backlog mining, dashboard audit, reliability and
  security audit, and a live end-to-end smoke run). Statuses flip as work lands.
  Closing needs a resolution (root cause + fix location).
- **Repo state, hard constraints, process rules:** `docs/handoff/HANDOFF.md` sections
  3-5. Non-negotiable: no emdashes, no `any`, no better-sqlite3, no console.log in
  prod paths, strict tsconfig stays on, failing-first tests, Zod at boundaries,
  hand-written append-only migrations in `packages/forge-hub/src/db/migrate.ts`.
- **Agent personality review:** `docs/agents-once-over-2026-07-07.md`.
- **Product-pass verdict + milestone plan:** presented to Adam 2026-07-07; check
  Graphiti (group_id `forge-lab`) episodes if the chat is gone.
- **Local boot recipe (validated):** `.claude/skills/smoke/SKILL.md`. It encodes the
  exact env vars, device registration curl calls, and the traps hit during the pass.

## Known traps (hit during the product pass; issue numbers refer to issues.json)

- Workspace-created tasks currently SKIP FM triage: `tasks.ts:1800` hardcodes
  `pending_agent` where the comment above it promises `pending_dispatcher_action`
  (issue 2). Don't trust the FM inbox until fixed.
- Non-repo-bound spawns get a RELATIVE done-file path (`daemon.ts:934`); an agent
  that loses its cwd completes work but is marked failed (issue 3). Happened live.
- A daemon crash mid-task orphans `in_progress` forever - no lease/heartbeat/reclaim
  (issue 1). Manual cancel/retry is the only recovery.
- `FORGE_DAEMON_AGENT_ID` silently defaults to `architect` (issue 12).
- Dispatcher-mode daemons still run the worker claim loop and spam policy_denied
  (issue 11).
- Spawned agents inherit the daemon's full env including auth vars (issue 42). Pin
  `FORGE_DAEMON_MODEL=claude-sonnet-4-6` explicitly until OPS-2 (issue 6) lands.

## Orchestration protocol (multi-agent sessions in this repo)

- ONE persistent agent per tightly-coupled domain (hub routes + migrations are one
  domain; daemon loops another; dash a third), fed sequential tasks via SendMessage.
- Parallel waves only for loose domains (docs, personalities, independent packages),
  with explicit file ownership per agent.
- The coordinator owns integration: `pnpm build && pnpm test` at repo root, plus the
  smoke-skill dispatch loop for anything touching hub/daemon/dash interplay.
- Machine rules: Adam may be using this machine. No focus stealing. Kill only
  processes you started, by pid. Daemons and hub log to files, never a visible window.
- Commit only on Adam's word. Dash patch version bumps on any code push to main
  (`docs/handoff/HANDOFF.md` section 5); no 0.9 minor without his OK.

## Memory discipline

At every milestone boundary: update `issues/issues.json` statuses, write a Graphiti
episode (group_id `forge-lab`), and refresh this file's Known traps if any were fixed.
