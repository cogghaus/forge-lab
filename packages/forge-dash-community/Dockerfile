# ── Stage 1: install + build ──────────────────────────────────────────
FROM node:20-slim AS build

RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# Copy workspace manifests for layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY tsconfig.base.json ./
# Workspace members — package.json only for pnpm resolution
COPY packages/forge-core/package.json          packages/forge-core/
COPY packages/forge-agents/package.json        packages/forge-agents/
COPY packages/forge-daemon/package.json        packages/forge-daemon/
COPY packages/forge-hub/package.json           packages/forge-hub/
COPY packages/forge-dash-community/package.json packages/forge-dash-community/tsconfig.json packages/forge-dash-community/

RUN pnpm install --frozen-lockfile

# Build forge-core so its dist/ is available to the dash build
COPY packages/forge-core/src packages/forge-core/src
COPY packages/forge-core/tsconfig.json packages/forge-core/tsconfig.build.json packages/forge-core/
RUN pnpm --filter @forge-lab/core build

# Copy dash source
COPY packages/forge-dash-community/src packages/forge-dash-community/src
COPY packages/forge-dash-community/public packages/forge-dash-community/public
COPY packages/forge-dash-community/next.config.ts \
     packages/forge-dash-community/postcss.config.mjs \
     packages/forge-dash-community/tailwind.config.ts \
     packages/forge-dash-community/

RUN pnpm --filter @forge-lab/forge-dash-community build

# ── Stage 2: production image ─────────────────────────────────────────
FROM node:20-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 forge && adduser --system --uid 1001 forge

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

WORKDIR /app

# Next.js standalone output (self-contained, no node_modules install needed)
COPY --from=build --chown=forge:forge /app/packages/forge-dash-community/.next/standalone ./
COPY --from=build --chown=forge:forge /app/packages/forge-dash-community/.next/static \
     ./packages/forge-dash-community/.next/static
COPY --from=build --chown=forge:forge /app/packages/forge-dash-community/public \
     ./packages/forge-dash-community/public

USER forge
EXPOSE 3001

ENTRYPOINT ["tini", "--"]
CMD ["node", "packages/forge-dash-community/server.js"]
