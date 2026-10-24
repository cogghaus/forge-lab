# forge-lab

Multi-agent AI orchestration for software development: a hub server, local daemons, per-agent personalities and a cross-device dashboard.

## Status

**Retired in October 2026.** forge-lab was built from April to October 2026 and is no longer developed. Its successor is Charter, a private project. The repository stays public as a record of what was built and what was learned.

It grew out of vibe-forge, an earlier private prototype that ran the same idea as Claude Code hooks. forge-lab moved the orchestration into a hub and a runtime-agnostic daemon.

## What it did

- **Hub** (`forge-hub`): Fastify 5 API over SQLite (libsql + Drizzle, hand-written migrations). The hub was the single source of truth for tasks, workspaces, goals, a per-workspace knowledge base, agent memory and an audit history. It pushed events over SSE and WebSocket.
- **Daemons** (`forge-daemon`): one per agent, run under PM2 locally or as containers in deployment. A daemon claimed a task from the hub, spawned the Claude Code CLI with the agent's personality as the system prompt, and reported the result when the agent wrote its done file.
- **Forge Master**: an orchestrator agent that triaged a workspace's inbox, split work into sequenced phases with dependencies, and routed each piece to a specialist (architect, furnace, anvil, crucible, scribe and others).
- **Personalities** (`forge-agents`): 13 Markdown personality files validated by a Zod schema and layered into each agent's system prompt.
- **Dashboard** (`forge-dash-community`): Next.js 15. Workspaces, tasks, goals, knowledge base, analytics, and devices registered from multiple machines.
- **MCP server** (`forge-mcp`): exposed hub tasks, workspaces, docs, devices and analytics to MCP clients.

## What worked

- The full loop ran end to end: a task created in the dashboard was triaged by Forge Master, claimed by a worker daemon, executed by the Claude Code CLI, and marked complete in the hub.
- Delivery was at-least-once. Claims were atomic, leases expired, heartbeats extended them, and a reclaim sweep recovered tasks from crashed daemons.
- Builds moved off the deploy host into CI, which publishes images to GHCR, so the host only pulls.
- Two security reviews of the hub found cross-tenant access-control gaps. All findings were fixed with failing-first regression tests (#141, #142, #143). See [docs/security-review.md](docs/security-review.md).

**Final test count: 1006 passing** (`pnpm test`, 2026-10-24):

| Package | Tests |
|---|---|
| `forge-hub` | 691 |
| `forge-daemon` | 214 |
| `forge-core` | 54 |
| `forge-agents` | 25 |
| `forge-dash-community` | 20 |
| `forge-mcp` | 2 |

## Lessons

These are the calls that decided what carried forward and what didn't.

### Carried forward

- **Atomic claim with a lease and heartbeat.** A claim is one guarded SQL `UPDATE`. When daemons race, exactly one wins and the others get a 409. A lease and heartbeat cover the opposite failure: before them, a daemon that crashed mid-task left the task stuck in `in_progress` forever. Together they make delivery at-least-once without a coordinator. ([m3-reliability](docs/design/m3-reliability.md))
- **The done-file contract.** An agent signals completion by writing `.forge/tasks/<id>.done`, and the daemon watches for it. That works with any CLI runtime and needs no runtime-specific hooks. The cost was agents writing the file in the wrong directory, so the daemon now hands each agent the absolute path and accepts the freshest file.
- **Hub as source of truth.** Daemons hold no authoritative state, so any daemon can die and restart without losing work. Agent output and log text are never treated as status.
- **Interface contracts before parallel work.** Forge Master defines the shared interface before spawning parallel specialists ([ADR-003](docs/adr/ADR-003-inter-agent-coordination.md)), and the M3 reliability work was specified as one written contract that the hub and daemon changes were both built against. The rule: write the contract first, then parallelize.
- **Personalities.** Versioned Markdown files with a schema, composed in layers into the system prompt. Every personality includes the same output contract, so specialists stay interchangeable to the daemon.

### Dropped, and why

- **Log tailing.** The dashboard streamed an agent's progress by tailing its log file, and the daemon matched log text to detect auth failures. Stale text got re-read as fresh failures, the dashboard needed filesystem access to the daemon's workdir, and logs could contain the system prompt. Status belongs in structured events reported to the hub, not in text parsed after the fact.
- **The half-built policy engine.** Heimdall shipped a rule engine, database-backed rules and an audit trail. It still fell short of its design in two places. It failed open when rules couldn't load (on purpose, so a database hiccup didn't stop all agent work). And it gated by device type, not tenancy, because devices carried no workspace membership. The security reviews found the cross-tenant gaps right there. Plain membership checks at each route fixed them. The baseline should be explicit authorization in code; a general policy engine comes after that, if ever.
- **The container waker.** Idle daemons exited, and a waker service polled the hub and restarted containers through the Docker socket to save cost overnight. That added a root-equivalent socket mount, another authenticated endpoint, and another image to build. It optimized cost before the system needed it.
- **`--dangerously-skip-permissions`.** Unattended agents can't answer permission prompts, so daemons ran the CLI with its permission checks disabled, as a non-root user because the CLI refuses the flag as root. A design that has to switch off the agent runtime's own guardrails to run unattended is working against that runtime, not with it.

Other places where the design pushed against the platform: several daemons shared one OAuth login, and when its token rotated mid-run the losing agents died, so the fix was per-container API keys. Building images on the deploy host wedged it twice, so builds moved to CI. A runaway triage loop showed that unattended agents need cost limits, so Forge Master got a cooldown.

## Packages

| Package | Purpose |
|---|---|
| `forge-core` | Shared types, Zod schemas, Drizzle schema, `AgentRuntime` interface |
| `forge-hub` | Fastify 5 API server, SQLite task engine, SSE and WebSocket events |
| `forge-daemon` | Bridge between the hub and agents: worker and dispatcher loops |
| `forge-agents` | Agent personality files (forge-master, scribe, architect, furnace and more) |
| `forge-dash-community` | Next.js 15 dashboard: workspaces, tasks, goals, knowledge base, analytics |
| `forge-mcp` | MCP server over the hub API |

## Architecture

```
forge-hub (API + DB)
  ↕ HTTP + SSE / WebSocket
forge-daemon (one per agent)
  ↕ subprocess
claude CLI
  ↕ done-file protocol
forge-dash-community (Next.js dashboard)
```

## Documentation

The design docs and ADRs are historical records. They describe the system as designed at the time, and some describe work that was planned but never built.

Decision records:

- [ADR-001: Forge Master Orchestrator](docs/adr/ADR-001-forge-master-orchestrator.md)
- [ADR-002: Workspace Knowledge Base](docs/adr/ADR-002-workspace-knowledge-base.md)
- [ADR-003: Inter-agent Coordination](docs/adr/ADR-003-inter-agent-coordination.md)
- [ADR-004: Single Fleet, Multi Workspace](docs/adr/ADR-004-single-fleet-multi-workspace.md)

Design docs:

- [Task sequencing](docs/design/task-sequencing.md): how multi-phase work is planned and ordered
- [Task lifecycle management](docs/design/task-lifecycle-management.md): leases, heartbeats, reclaim
- [Heimdall policy engine](docs/design/heimdall-policy-engine.md): what agents are permitted to do
- [Device management](docs/design/device-management.md)
- [M3 reliability](docs/design/m3-reliability.md): the lease and reclaim design and its failure modes
- [FM architecture reference](docs/architecture/forge-master-system.md)
- [Security review record](docs/security-review.md)

Running it: [QUICKSTART](docs/QUICKSTART.md). Deploying it: [DEPLOYMENT](docs/DEPLOYMENT.md).

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Requires Node 20+ LTS and pnpm 10+.

## License

MIT. See [LICENSE](./LICENSE).
