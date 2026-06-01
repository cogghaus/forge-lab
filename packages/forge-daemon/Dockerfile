# forge-daemon image.
#
# One image, many daemons: behavior is driven entirely by FORGE_DAEMON_* env
# vars (see ecosystem.config.cjs / deploy/daemons.compose.yml). Each container
# runs one agent identity and spawns `claude` (background runtime) per task.
#
# Auth: the spawned `claude` CLI reads OAuth credentials from $HOME/.claude.
# Mount a credentials volume at /home/forge/.claude at runtime. The container
# runs as the non-root `forge` user because claude refuses
# --dangerously-skip-permissions when running as root.

FROM node:20-slim AS builder
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /repo
# Manifests first for layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages/forge-core/package.json packages/forge-core/
COPY packages/forge-agents/package.json packages/forge-agents/
COPY packages/forge-daemon/package.json packages/forge-daemon/
COPY packages/forge-hub/package.json packages/forge-hub/
COPY packages/forge-dash-community/package.json packages/forge-dash-community/
COPY packages/forge-mcp/package.json packages/forge-mcp/
RUN pnpm install --frozen-lockfile
# Sources for the daemon and its workspace dependencies.
COPY packages/forge-core packages/forge-core
COPY packages/forge-agents packages/forge-agents
COPY packages/forge-hub packages/forge-hub
COPY packages/forge-daemon packages/forge-daemon
RUN pnpm --filter @forge-lab/daemon... build

FROM node:20-slim AS runner
# git + gh: agents check out repos, commit, and open PRs. `claude` = the CLI.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl gpg \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code \
  && npm cache clean --force
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
# Non-root user (claude refuses --dangerously-skip-permissions as root).
RUN groupadd --system --gid 1001 forge \
  && useradd --system --uid 1001 --gid forge --create-home --home-dir /home/forge forge
WORKDIR /repo
ENV NODE_ENV=production \
    HOME=/home/forge \
    FORGE_DAEMON_WORKDIR=/workdir
# Full built monorepo so pnpm workspace symlinks resolve @forge-lab/* at runtime.
COPY --from=builder /repo /repo
RUN mkdir -p /workdir && chown -R forge:forge /repo /workdir /home/forge
USER forge
WORKDIR /repo/packages/forge-daemon
CMD ["node", "dist/bin/forge-daemon.js"]
