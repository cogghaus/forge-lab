# forge-lab

Open-core multi-agent AI orchestration for software development workflows.

Hub server + local daemons + per-agent personalities + cross-device dashboard. It grew out of vibe-forge, an earlier private prototype that ran the same idea as Claude Code hooks; forge-lab moves the orchestration into a runtime-agnostic daemon.

## Status

**Active development. All core systems operational.** Not yet recommended for production without reading the deployment docs.

**915 tests passing** across the workspace (`pnpm test`, 2026-08-01):

| Package | Tests |
|---|---|
| `forge-hub` | 610 |
| `forge-daemon` | 210 |
| `forge-core` | 50 |
| `forge-agents` | 25 |
| `forge-dash-community` | 20 |

Design docs in [`docs/design/`](docs/design/) are the source of record for how the
system behaves; the ADRs record why it is shaped that way.

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

Decision records:

- [ADR-001: Forge Master Orchestrator](docs/adr/ADR-001-forge-master-orchestrator.md)
- [ADR-002: Workspace Knowledge Base](docs/adr/ADR-002-workspace-knowledge-base.md)
- [ADR-003: Inter-agent Coordination](docs/adr/ADR-003-inter-agent-coordination.md)
- [ADR-004: Single Fleet, Multi Workspace](docs/adr/ADR-004-single-fleet-multi-workspace.md)

Design docs:

- [Task sequencing](docs/design/task-sequencing.md) — how multi-phase work is planned and ordered
- [Task lifecycle management](docs/design/task-lifecycle-management.md) — leases, heartbeats, reclaim
- [Heimdall policy engine](docs/design/heimdall-policy-engine.md) — what agents are permitted to do
- [Device management](docs/design/device-management.md)
- [M3 reliability](docs/design/m3-reliability.md) — the lease/reclaim design and its failure modes
- [FM architecture reference](docs/architecture/forge-master-system.md)

Getting it running: [QUICKSTART](docs/QUICKSTART.md).

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Requires Node 20+ LTS and pnpm 10+.

## License

MIT. See [LICENSE](./LICENSE).
