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

- FIXED in M1 (2026-07-07): FM front door (issue 2), relative done path (3),
  unseeded workspace agents (43), quarantine 409 limbo (44), assign identifier
  validation (45), claim retry spam (46), silent architect default now warns (12).
  See issues.json resolutions for locations.
- A daemon crash mid-task orphans `in_progress` forever - no lease/heartbeat/reclaim
  (issue 1, M3). Manual cancel/retry is the only recovery.
- Claim eligibility uses the DEVICE ROW agentId; FORGE_DAEMON_AGENT_ID only picks
  the spawn personality. FIXED in M2 (issue 47): PATCH /devices/:id updates agentId
  (422 on unknown ids), GET /devices/me inspects the row, and the daemon warns at
  startup when env and row disagree. Still register worker devices WITH the agentId;
  note FM routing is a real LLM decision, so first-run mismatch repair via PATCH is
  normal (QUICKSTART.md step 7).
- Dispatcher-mode daemons still run the worker claim loop (issue 11); the claim
  backoff mutes the spam but the proper skip is open.
- Spawned agents inherit the daemon's full env including auth vars (issue 42).
  OPS-2 landed (PR #129): unset FORGE_DAEMON_MODEL now defaults to sonnet in code.
  OPS-1 (#131) and OPS-3 (#130) also landed remotely on 2026-06-21 via the
  paperclip bot; keep local main freshly fetched before starting work.
- `projectPrefix` must be 2-6 lowercase LETTERS (no digits); task create 422s
  otherwise.
- forge-daemon's real-git test (repo.test.ts) can flake under a parallel root
  `pnpm test` on Windows (issue 49); rerun the package suite in isolation before
  blaming your change.

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
