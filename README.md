# forge-lab

Open-core multi-agent orchestration for AI-assisted development.

Hub server + local daemons + per-machine agents + cross-device dashboard. The next evolution of [vibe-forge](https://github.com/sugar-crash-studios/vibe-forge).

## Status

Phase 1 in progress. Not ready for use.

## Packages

| Package        | Purpose                                                       |
| -------------- | ------------------------------------------------------------- |
| `forge-core`   | Shared types, schemas, AgentRuntime interface, Drizzle schema |
| `forge-hub`    | Fastify hub server, SQLite task engine, WebSocket events      |
| `forge-daemon` | Local bridge between hub and agents, runtime abstraction      |
| `forge-agents` | Runtime-agnostic agent personalities and worker loop          |

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Requires Node 20+ LTS and pnpm 10+.

## License

MIT. See [LICENSE](./LICENSE).
