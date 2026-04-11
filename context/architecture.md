# Project Architecture

This file records the architectural decisions and guardrails that apply to forge-lab specifically. It complements `context/project-context.md` (which contains tech stack and conventions) by focusing on *why* forge-lab is shaped the way it is.

**Source of truth:** the notez folder named `forge-lab`, especially the note titled "forge-lab: Architecture Decisions (SETTLED)". When this file and notez disagree, notez wins. Update this file when a decision is settled in notez so agents can read it without MCP access.

---

## Key Decisions

### Runtime abstraction is load-bearing
`AgentRuntime` is an interface in `@forge-lab/core`. Concrete implementations live in `packages/forge-daemon/src/runtime/`. Phase 1 ships `MockRuntime` and `ClaudeCodeRuntime`; Phase 2 and later may add `ClaudeAPIRuntime`, `OpenAIRuntime`, `OllamaRuntime`. This is the hedge against the Anthropic harness policy announced 2026-04-04. It is also the reason Heimdall and the worker loop live in the daemon rather than as Claude Code hooks.

### Hub is the source of truth
The Fastify hub owns all task and device state. The daemon is a local bridge between the hub and agents. Agents read and write local files only; they are network-unaware. This lets a single hub serve multiple daemons on multiple machines while agents stay simple.

### SQLite via libsql, not better-sqlite3
Decided 2026-04-10. Same SQLite file format; the driver choice is about cross-platform installability and async API shape. See `context/project-context.md` Key Decisions for the full rationale. Do not propose better-sqlite3 for new work.

### Auth from day one
First account is admin, subsequent registrations are disabled. Device tokens and session tokens are hashed at rest. All endpoints require auth except `/healthz`. This is non-negotiable.

### Event-driven over polling
Hub emits events through an in-memory EventBus, which the WebSocket route forwards to connected daemons. Daemons subscribe and react. No polling loops in either direction for normal operation.

### File-based task handoff between daemon and agents
The daemon writes `.forge/tasks/<taskId>.md` when an agent should pick up a task, and watches for `.forge/tasks/<taskId>.done` (a JSON marker) to know when the agent finished. This is the only contract between the daemon and an agent runtime. It lets us swap runtimes without changing the coordination protocol.

### Task ID format
Project-prefixed: `<prefix>-<sequence>`. forge-lab itself is `fl-001` upward. The hub computes the next sequence per project on insert. Vibe-forge tasks in `_vibe-forge/tasks/` use their own domain prefixes like `ARCH-001`; forge-lab work tracked through Vibe Forge uses `FL-XXX`.

---

## Patterns

### Schemas are the contract
Every module that crosses a boundary (HTTP, filesystem, env, WebSocket message) parses through a Zod schema. TypeScript types are inferred from schemas via `z.infer` so the runtime check and the compile-time check cannot drift. When adding a new boundary, define the schema first, then the type, then the logic.

### Dependency injection via constructor options
See `ClaudeCodeRuntime` for the canonical example: the runtime takes a `spawner` in its options, defaulting to a real `node:child_process`-backed implementation. Tests pass a fake spawner that records invocations without executing anything. Apply this pattern to anything that touches the filesystem, network, clock, or process.

### Async everywhere
libsql is async. Fastify handlers are async. File I/O uses `node:fs/promises`. Only pure functions and synchronous in-memory helpers are sync. Do not add sync I/O in runtime code.

### One migration runner, hand-written for now
`packages/forge-hub/src/db/migrate.ts` applies a list of SQL migrations under a `_migrations` tracking table. Phase 1 ships one migration (`0000_init`). Phase 2 adds drizzle-kit when we need a second migration and want generation automated. Until then, new schema changes are hand-written SQL appended to the migrations list.

### Tests colocate with source
`<name>.ts` and `<name>.test.ts` live next to each other. The build excludes `*.test.ts`; typecheck and lint include them. Integration tests live in their own files at the package root (see `packages/forge-daemon/src/integration.test.ts`) and exercise real hub + daemon boots against an ephemeral port.

---

## Guardrails

- No emdashes in any output (global rule)
- Every bug fix ships with a failing-first test (global rule)
- No unauthenticated endpoints except `/healthz`
- No `better-sqlite3` (project standard is libsql)
- No `Content-Type: application/json` on bodyless requests (Fastify 5 rejects)
- No Magic UI Pro in the public repo (license scanner enforces)
- No TypeScript strictness relaxation
- No reaching into the hub database from the daemon. Daemon talks to the hub over HTTP and WebSocket only.
- No spawning runtimes outside the `RuntimeRegistry`.
- No mixing personality content with runtime code. Personalities are data loaded at runtime; runtimes are code imported at compile time.
- No PID-based liveness polling. `wt.exe` exits immediately on Windows; the claude process underneath is an untracked grandchild. Liveness is file-based (task file exists without a done marker).
- No secrets in environment variables. Use Docker secrets and the `_FILE` env var pattern. `forge-hub/src/config.ts` already supports `FORGE_HUB_SESSION_SECRET_FILE`.

---

## Open Questions for Phase 2

- **System prompt composition.** Personalities are standalone strings in Phase 1. vibe-forge layers project-context + agent-overrides + handoff files at spawn time. Where does this composition live? Likely a `composeSystemPrompt()` helper in `@forge-lab/agents`, called by the daemon before invoking `runtime.spawn()`. Design decision pending.
- **Mid-task instructions.** `ClaudeCodeRuntime.sendInstruction` throws in Phase 1. The plan is a signal file in `.forge/tasks/<id>.signal` that the worker loop checks between iterations. Protocol details pending.
- **Full Heimdall policy engine.** Phase 1 is pass-through. Phase 2 adds path allowlists, secret scanning, and audit events posted back to the hub.
- **drizzle-kit migrations.** Switch from hand-written SQL when we need the second migration.
- **Dockerfile for forge-hub.** The compose stack references an image that does not exist yet. Build and publish comes when Ember is active.

---

## ADR Index

<!-- Architecture Decision Records will be added here as the project evolves. For now, the authoritative decisions live in the notez folder "forge-lab". -->
