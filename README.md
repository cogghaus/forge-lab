# forge-lab

Open-core multi-agent AI orchestration for software development workflows.

Hub server + local daemons + per-agent personalities + cross-device dashboard. The next evolution of [vibe-forge](https://github.com/sugar-crash-studios/vibe-forge).

## Status

**Active development. All core systems operational.** Not yet recommended for production without reading the deployment runbook.

- forge-hub: ~480 tests passing
- forge-daemon: 117 tests passing
- forge-agents: 27 tests passing

See [docs/handoff/HANDOFF.md](docs/handoff/HANDOFF.md) for the authoritative current
status and open work. (`docs/roadmap/current-state.md` is historical / superseded.)

## Packages

| Package | Purpose |
|---|---|
| `forge-core` | Shared types, schemas, Drizzle schema, AgentRuntime interface |
| `forge-hub` | Fastify 5 API server, SQLite task engine, SSE event stream |
| `forge-daemon` | Local bridge between hub and agents, worker + dispatcher loops |
| `forge-agents` | Agent personality files (forge-master, scribe, architect, furnace, and more) |
| `forge-dash-community` | Next.js 15 dashboard — workspaces, tasks, goals, knowledge base, analytics |

## Architecture

forge-lab runs multiple specialized AI agents coordinated by a central hub:

```
forge-hub (API + DB)
  ↕ HTTP + SSE
forge-daemon (one per agent type, via PM2)
  ↕ subprocess
claude CLI (--dangerously-skip-permissions)
  ↕ done-file protocol
forge-dash-community (Next.js dashboard)
```

Forge Master (FM) orchestrates work: it triages tasks, routes them to specialized agents (architect, furnace, anvil, crucible, etc.), and maintains a knowledge base via Scribe.

## Documentation

- [Current state and gap analysis](docs/roadmap/current-state.md)
- [FM architecture reference](docs/architecture/forge-master-system.md)
- [Production deployment runbook](docs/runbooks/production-deployment.md)
- [ADR-001: Forge Master Orchestrator](docs/adr/ADR-001-forge-master-orchestrator.md)
- [ADR-002: Workspace Knowledge Base](docs/adr/ADR-002-workspace-knowledge-base.md)

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Requires Node 20+ LTS and pnpm 10+.

## License

MIT. See [LICENSE](./LICENSE).
