FROM node:20-slim AS builder
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY tsconfig.base.json ./
COPY packages/forge-core/package.json packages/forge-core/
COPY packages/forge-agents/package.json packages/forge-agents/
COPY packages/forge-daemon/package.json packages/forge-daemon/
COPY packages/forge-hub/package.json packages/forge-hub/
COPY packages/forge-dash-community/package.json packages/forge-dash-community/
COPY packages/forge-mcp/package.json packages/forge-mcp/tsconfig.json packages/forge-mcp/tsconfig.build.json packages/forge-mcp/
RUN pnpm install --frozen-lockfile
COPY packages/forge-mcp/src packages/forge-mcp/src
RUN pnpm --filter @forge-lab/mcp build

FROM node:20-slim AS runner
RUN addgroup --system --gid 1001 forge && adduser --system --uid 1001 forge
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=forge:forge /repo/packages/forge-mcp/dist ./dist
COPY --from=builder --chown=forge:forge /repo/packages/forge-mcp/package.json ./package.json
COPY --from=builder --chown=forge:forge /repo/packages/forge-mcp/node_modules ./node_modules
USER forge
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
