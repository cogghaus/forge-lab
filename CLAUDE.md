# forge-lab

This project is retired (see `README.md`). Changes are limited to security fixes
and documentation corrections.

Hard constraints for any change:

- No emdashes in code, comments, docs or commit messages.
- No `any`. The strict tsconfig stays on.
- Failing-first tests: commit the red test before the fix.
- Zod at every boundary (HTTP bodies, env config, files read from disk).
- Migrations are hand-written and append-only. No better-sqlite3.
- The hub is the source of truth. Daemons hold no authoritative state.
- Authorize every caller through its user: the session user, or a device's
  owner (`packages/forge-hub/src/auth/access.ts`). A device type or agentId is
  not a trust boundary.

Build: `pnpm install && pnpm build && pnpm test` (Node 20+, pnpm 10+, turborepo).

End-to-end check: `scripts/smoke-test.sh --create-workspace` against a running hub
and daemons (see `--help`). Set `FORGE_DAEMON_MODEL` explicitly on the daemons.
