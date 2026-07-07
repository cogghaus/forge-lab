# forge-lab

Read `.claude/HANDOFF.md` first in any new session - it points to the authoritative
repo state (`docs/handoff/HANDOFF.md`), the findings DB (`issues/issues.json`), and
the known traps.

Hard constraints live in `docs/handoff/HANDOFF.md` section 4 (no emdashes, no `any`,
no better-sqlite3, strict tsconfig stays on, failing-first tests, Zod at boundaries,
hand-written append-only migrations, hub is source of truth).

Build: `pnpm install && pnpm build && pnpm test` (Node 20+, pnpm 10+, turborepo).

End-to-end verification: `.claude/skills/smoke/SKILL.md` (fresh DB, scratch workdir,
`FORGE_DAEMON_MODEL=claude-sonnet-4-6` always).

Findings go in `issues/issues.json` per `.claude/skills/issues/SKILL.md`, not in
chat history.
