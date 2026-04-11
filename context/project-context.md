# Project Context

**This file is the single source of truth for all Vibe Forge agents working on forge-lab.**

Every agent loads this file at session start. Update this when architecture or conventions change. The authoritative architectural decisions live in the `notez` MCP under the folder named `forge-lab` — when this file and notez disagree, notez wins.

---

## Project Identity

- **Name:** forge-lab
- **Description:** Open-core multi-agent orchestration for AI-assisted development. The next evolution of vibe-forge itself. We are dogfooding vibe-forge to build forge-lab.
- **Repository:** https://github.com/sugar-crash-studios/forge-lab (public, MIT)
- **Private companion:** https://github.com/sugar-crash-studios/forge-dash-pro (dashboard + marketing site, proprietary, personal use only — Magic UI Pro is NOT redistributable)
- **Deployment configs:** `homelab-docs` repo
- **Developer:** Adam (sole developer)
- **Current state:** Phase 1 vertical slice complete (commit `d7d9c44`). 28 tests green. Ready to begin Phase 2.
- **Victory milestone:** Phase 2 complete + community dashboard used daily for two weeks.

---

## Tech Stack

### Runtime and tooling
- **Node:** 20+ LTS (dev machine runs Node 25; production targets Node 22 LTS)
- **Package manager:** pnpm 10
- **Monorepo:** pnpm workspaces + Turborepo
- **TypeScript:** 5.7+ with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` — do not relax these
- **Lint:** ESLint 9 flat config (`eslint.config.js`)
- **Format:** Prettier
- **Tests:** Vitest

### Backend
- **Server:** Fastify 5
- **Database:** SQLite via `@libsql/client` + `drizzle-orm/libsql` (NOT `better-sqlite3` — see Key Decisions)
- **Auth:** bcryptjs (cost 12) for passwords, SHA-256 for device tokens, cookie sessions for users, `Authorization: Bearer` for devices
- **WebSocket:** `@fastify/websocket`
- **IDs:** nanoid

### Frontend (future, Phase 2+)
- **Framework:** Next.js (App Router)
- **Styling:** Tailwind
- **Component library:** HeroUI v3 (community dashboard, free to bundle)
- **Visual library:** Magic UI Pro (forge-dash-pro ONLY, proprietary, never in public repo)
- **Motion:** Framer Motion

### CLI (future, Phase 4)
- **Prompts:** `@clack/prompts`

### Containers
- **Compose:** modern spec, file named `compose.yml`, no `version:` field, `docker compose` (with space)
- **Secrets:** Docker secrets, not env vars, for sensitive values

---

## File Structure

```
forge-lab/
├── packages/
│   ├── forge-core/       # Zod schemas, AgentRuntime interface, Drizzle schema, event taxonomy
│   ├── forge-hub/        # Fastify hub server, auth, routes, WebSocket, migrations
│   ├── forge-daemon/     # Hub client, runtime registry, task file sync, MockRuntime, ClaudeCodeRuntime
│   └── forge-agents/     # Personality schema, registry (personalities stub — port in progress)
├── scripts/
│   └── check-license.mjs # License scanner (blocks Magic UI Pro in public repo)
├── .github/workflows/
│   └── ci.yml            # lint / typecheck / build / test / license scanner
├── context/              # Project brief for vibe-forge agents (this file lives here)
├── _vibe-forge/          # Vibe Forge tool + its internal state (most of it is gitignored; tasks/ and context/ tracked)
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
└── package.json
```

Phase 2 and later will add `packages/forge-cli`, `packages/forge-context`, `packages/forge-dash-shared`, `packages/forge-dash-community`. Private dashboard and marketing site live in the separate `forge-dash-pro` repo.

---

## Coding Standards

### Naming
- **Packages:** `@forge-lab/<name>` in the workspace
- **TypeScript:** Interfaces and types use PascalCase. Functions use camelCase. Constants use SCREAMING_SNAKE only for true module-level constants. Schema variables end in `Schema` (Zod).
- **Files:** kebab-case (`task-file.ts`, `hub-client.ts`). Test files colocate with source as `<name>.test.ts`.

### Patterns
- **Zod for all external boundary validation.** Route handlers, config loaders, environment parsing, file parsing all parse through Zod schemas. Infer TypeScript types from schemas (`z.infer<typeof X>`) rather than defining types separately.
- **AgentRuntime is the runtime abstraction.** Any new runtime (Claude API, OpenAI, Ollama, etc.) implements the interface from `@forge-lab/core`. Runtimes are injected, not imported globally, so they can be swapped and tested.
- **Dependency injection via constructor options.** Tests pass fakes (see `RuntimeSpawner` in `packages/forge-daemon/src/runtime/claude-code.ts`). Real code uses default implementations.
- **Async by default.** All DB operations are async (libsql constraint). All Fastify routes are async. Only pure functions and synchronous helpers are sync.
- **File-based coordination between daemon and agents.** Daemon writes `.forge/tasks/<id>.md`, agents write `.forge/tasks/<id>.done` as a JSON marker. Liveness is "task file exists without done marker."

### Forbidden
- **No emdashes in any output.** Global rule from Adam's CLAUDE.md. Use hyphens or parentheticals or rephrase.
- **No `any` types.** If you must escape the type system, use `unknown` and narrow.
- **No `console.log` in production code paths.** Tests may use `process.stdout.write` for diagnostic output. Runtime code uses injected loggers.
- **No `better-sqlite3`.** Project standard is libsql. See Key Decisions.
- **No `Content-Type: application/json` on bodyless HTTP requests.** Fastify 5 rejects with `FST_ERR_CTP_EMPTY_JSON_BODY`. Only set the header when there is a body.
- **No secrets in environment variables.** Use Docker secrets and the `FORGE_HUB_SESSION_SECRET_FILE` pattern.
- **No Magic UI Pro imports in public packages.** The license scanner at `scripts/check-license.mjs` enforces this in CI.
- **No tsconfig relaxation.** `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` stay on.

### Bug fix rule (non-negotiable, global)
Every bug fix ships with a failing-first test. Write the test that reproduces the bug, watch it fail against the buggy code, apply the fix, watch the test pass. No bug fix is complete without a regression test. This is a global rule from `C:\Users\acogg\.claude\CLAUDE.md`.

---

## Key Decisions

### Runtime abstraction (hedge against Anthropic harness policy)
Anthropic announced on 2026-04-04 that third-party harnesses will require pay-as-you-go usage. forge-lab is structurally a harness. The response was a runtime abstraction from day one: `AgentRuntime` is an interface, `ClaudeCodeRuntime` and `MockRuntime` implement it, and future runtimes (`ClaudeAPIRuntime`, `OpenAIRuntime`, `OllamaRuntime`) can be added without touching orchestration code. Heimdall and the worker loop moved from Claude Code hooks to daemon capabilities so they are portable across runtimes.

### SQLite driver: libsql, not better-sqlite3
Decided 2026-04-10. Same SQLite file format, different Node driver. libsql has NAPI prebuilts for every modern Node version (better-sqlite3 does not cover Node 25) and installs cleanly on Windows without Visual Studio Build Tools. Drizzle has first-class support via `drizzle-orm/libsql`. The trade-off is an async-only API, which matches forge-lab's async-by-default style anyway. Do not propose better-sqlite3 for new work without explicit sign-off from Adam.

### Auth from day one
No unauthenticated endpoints, ever. First account becomes admin; subsequent registrations are disabled (by design — this is a personal tool). Device tokens are hashed before storage. Session tokens are also hashed. `/healthz` is the only endpoint that skips auth, and it returns a static payload.

### Heimdall and Worker Loop moved to daemon
vibe-forge implements Heimdall as a Claude Code PreToolUse hook and the worker loop as a Claude Code Stop hook. Both are Claude-Code specific. forge-lab moves them into the daemon so they work with any runtime. Phase 1 has Heimdall as a pass-through stub; the real policy engine lands in Phase 2.

### Task IDs are project-prefixed
Task IDs follow the pattern `<project_prefix>-<sequence>`, e.g. `fl-001` for forge-lab, `cg-001` for a hypothetical project prefixed `cg`. The hub computes the next sequence per project on task create. Vibe-forge tasks in `_vibe-forge/tasks/` use domain prefixes like `ARCH-001`; forge-lab tasks created via Vibe Forge use `FL-XXX`.

### Dashboard strategy (Phase 2+)
Two dashboards. `forge-dash-community` lives in the public repo and uses HeroUI only, free to bundle. `forge-dash-pro/packages/dash` lives in the private repo and layers Magic UI Pro on top of HeroUI for Adam's personal experience. Feature parity is mandatory. Magic UI Pro NEVER appears in the public repo — the license scanner enforces this.

### Why libsql over built-in node:sqlite
node:sqlite (Node 22.5+) is sync and would allow the original better-sqlite3 code shape, but Drizzle support was newer and less tested at decision time. libsql with drizzle-orm/libsql was the more mature path and brings a clean Turso cloud sync option if we ever want cross-region replicas later.

---

## Environment

### Local Development
```bash
pnpm install
pnpm build
pnpm test
```

Requires Node 20+ LTS and pnpm 10+. The repo is TypeScript strict with `exactOptionalPropertyTypes` on. Turborepo caches everything; `pnpm build` / `pnpm test` hit full turbo after the first successful run.

### Environment Variables (forge-hub)

| Variable | Required | Description |
|---|---|---|
| `FORGE_HUB_SESSION_SECRET` | yes (or file) | Session cookie signing secret, min 32 chars |
| `FORGE_HUB_SESSION_SECRET_FILE` | yes (or env) | Path to a file containing the secret (for Docker secrets) |
| `FORGE_HUB_DATABASE_URL` | no | libsql URL, defaults to `:memory:`. Use `file:./hub.db` for local dev |
| `FORGE_HUB_HOST` | no | defaults to `127.0.0.1` |
| `FORGE_HUB_PORT` | no | defaults to 3000 |
| `FORGE_HUB_SESSION_TTL_HOURS` | no | defaults to 336 (14 days) |
| `FORGE_HUB_BCRYPT_COST` | no | defaults to 12 |
| `FORGE_HUB_COOKIE_SECURE` | no | defaults to false, set true in production |

### Environment Variables (forge-daemon)

| Variable | Required | Description |
|---|---|---|
| `FORGE_DAEMON_HUB_URL` | yes | Hub base URL |
| `FORGE_DAEMON_DEVICE_TOKEN` | yes | Device token from `POST /devices` on the hub |
| `FORGE_DAEMON_WORKDIR` | no | Defaults to `process.cwd()`. Where task files are written |
| `FORGE_DAEMON_DEFAULT_RUNTIME` | no | Defaults to `mock`. Set to `claude-code` for real agents |

---

## Agent-Specific Notes

### Architect (🏛️)
Reviews every slice's design before code is written. Schema shapes, runtime interface decisions, and auth flows deserve extra scrutiny. When reviewing, check that Zod schemas and TypeScript types stay in sync (prefer `z.infer`) and that any new module follows the dependency injection pattern.

### Loki (🎭)
Challenges scope and motivation on every task. "Is this the right next thing? Are we over-building? Could a smaller version ship today?" Loki's job is to prevent scope creep and surface the boring-but-load-bearing work. Loki has standing authority to block any task that doesn't move forge-lab toward the "daily driver by Phase 2" victory milestone.

### Aegis / Heimdall (🛡️)
Reviews anything touching auth, tokens, secrets, deployment, or published artifacts. forge-lab is building its own security layer (Heimdall) so Aegis is first-class here, not an afterthought. Specifically: every new endpoint must have explicit auth requirements (user session, device token, or `/healthz`-style public), every secret must use the `_FILE` pattern for Docker secrets, and the license scanner runs on every PR.

### Crucible (🧪)
Enforces test coverage. Global rule: bug fixes need failing-first tests. forge-lab uses Vitest for all testing. Integration tests are preferred over unit tests when the interaction boundary is the interesting part (see `packages/forge-daemon/src/integration.test.ts` — that is the model). When reviewing, Crucible checks that test count is non-decreasing and that new functionality has at least one positive and one negative test case.

### Oracle (📊)
Keeps the "daily driver by Phase 2" victory milestone in view. Push back on work that does not move toward that. Oracle owns product positioning: forge-lab is a personal tool with a product door open (Option B from the notez Architecture Decisions note), not a SaaS. Requirements checks ask "does this make forge-lab usable daily, or is it polish?"

### Scribe (📝)
Ports content from vibe-forge into forge-lab. The current active port is agent personalities (see FL-001 in `_vibe-forge/tasks/pending/`). Scribe reads the vibe-forge personality.md files at `G:\dev\vibe-forge\agents\{agent}\personality.md` and produces structured equivalents in `packages/forge-agents/personalities/` that match the `AgentPersonalitySchema` in `packages/forge-agents/src/personality.ts`.

### Pixel (🎨)
Comes in when dashboard or UI work is active. HeroUI for the community dashboard, Magic UI Pro for forge-dash-pro only (never in the public repo). Pixel follows the Pixel Design Vision note in notez for color, layout, and forge temperature.

### Ember (⚙️)
Comes in when actual deployment happens. The forge-lab compose stack at `homelab-docs/servers/accserver/stacks/forge-lab.yml` deploys the hub to accserver via Traefik. Ember owns the Dockerfile (not yet written), GHCR publish workflow, and the accserver deployment flow.

### Anvil (🔨)
Comes in when heavy scaffolding or infrastructure code is needed. Not active in early Phase 2.

---

## Links

- **Source of truth for architecture:** notez folder `forge-lab` (especially "Architecture Decisions (SETTLED)", "Ready to Build", "Project Conventions")
- **Vibe-forge reference repo:** `G:\dev\vibe-forge` (for personality ports and spawn logic reference)
- **Public repo:** https://github.com/sugar-crash-studios/forge-lab
- **Private dashboard repo:** https://github.com/sugar-crash-studios/forge-dash-pro
- **Deployment configs:** `homelab-docs/servers/accserver/stacks/forge-lab.yml`
- **Adam's global rules:** `C:\Users\acogg\.claude\CLAUDE.md`
