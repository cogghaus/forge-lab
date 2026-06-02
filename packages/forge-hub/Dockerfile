# ── Stage 1: install + build ──────────────────────────────────────────
FROM node:20-slim AS build

RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

WORKDIR /app

# Copy lockfile + workspace manifests for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY tsconfig.base.json ./
# Packages we build (core, agents, hub)
COPY packages/forge-core/package.json    packages/forge-core/tsconfig.json    packages/forge-core/tsconfig.build.json    packages/forge-core/
COPY packages/forge-hub/package.json     packages/forge-hub/tsconfig.json     packages/forge-hub/tsconfig.build.json     packages/forge-hub/
COPY packages/forge-agents/package.json  packages/forge-agents/tsconfig.json  packages/forge-agents/tsconfig.build.json  packages/forge-agents/
# Other workspace members — package.json only (pnpm workspace resolution)
COPY packages/forge-daemon/package.json          packages/forge-daemon/
COPY packages/forge-dash-community/package.json  packages/forge-dash-community/

# Full install (dev deps needed for tsc)
RUN pnpm install --frozen-lockfile

# Copy source for the packages we build (+ agents personalities the hub serves)
COPY packages/forge-core/src/ packages/forge-core/src/
COPY packages/forge-hub/src/  packages/forge-hub/src/
COPY packages/forge-agents/src/ packages/forge-agents/src/
COPY packages/forge-agents/personalities/ packages/forge-agents/personalities/

# Build core first, then agents (hub imports it), then hub
RUN pnpm --filter @forge-lab/core build \
  && pnpm --filter @forge-lab/agents build \
  && pnpm --filter @forge-lab/hub build

# ── Stage 2: production deps only ────────────────────────────────────
FROM node:20-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/forge-core/package.json          packages/forge-core/
COPY packages/forge-hub/package.json           packages/forge-hub/
COPY packages/forge-agents/package.json        packages/forge-agents/
COPY packages/forge-daemon/package.json        packages/forge-daemon/
COPY packages/forge-dash-community/package.json packages/forge-dash-community/

RUN pnpm install --frozen-lockfile --prod

# ── Stage 3: production ──────────────────────────────────────────────
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

# Workspace root files needed for pnpm resolution
COPY --from=deps /app/package.json ./
COPY --from=deps /app/pnpm-workspace.yaml ./

# Production node_modules
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/forge-core/node_modules   ./packages/forge-core/node_modules
COPY --from=deps /app/packages/forge-hub/node_modules    ./packages/forge-hub/node_modules
COPY --from=deps /app/packages/forge-agents/node_modules ./packages/forge-agents/node_modules

# Built output + package.json (for module resolution)
COPY --from=build /app/packages/forge-core/dist        ./packages/forge-core/dist
COPY --from=build /app/packages/forge-core/package.json ./packages/forge-core/
COPY --from=build /app/packages/forge-hub/dist          ./packages/forge-hub/dist
COPY --from=build /app/packages/forge-hub/package.json  ./packages/forge-hub/
# Agents: built dist + the personality markdown the hub serves
COPY --from=build /app/packages/forge-agents/dist          ./packages/forge-agents/dist
COPY --from=build /app/packages/forge-agents/personalities ./packages/forge-agents/personalities
COPY --from=build /app/packages/forge-agents/package.json  ./packages/forge-agents/

# libsql data directory
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node

EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "packages/forge-hub/dist/bin/forge-hub.js"]
