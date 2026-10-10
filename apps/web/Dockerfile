# syntax=docker/dockerfile:1
#
# AYVO OS web (Next.js) image, using Next's standalone output. Build from the repository root:
#   docker build -f apps/web/Dockerfile .
#
# No secrets and no NEXT_PUBLIC_* values are used at build time. API_URL is a server-only
# runtime variable (src/lib/env.ts), so the same image works in any environment.

# Keep in step with .nvmrc. The exact version also pins the Corepack that fetches pnpm.
ARG NODE_VERSION=24.21.0
# Keep in step with the turbo devDependency in the root package.json.
ARG TURBO_VERSION=2.11.7

FROM node:${NODE_VERSION}-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable pnpm
WORKDIR /app

# --- Prune the monorepo to the web app and its workspace dependencies ----------------------------
FROM base AS prune
ARG TURBO_VERSION
RUN npm install --global --no-fund --no-audit "turbo@${TURBO_VERSION}"
COPY . .
RUN turbo prune @ayvo/web --docker

# --- Install and build ---------------------------------------------------------------------------
FROM base AS build
# Dependency manifests + pruned lockfile first, so this layer is cached until dependencies change.
COPY --from=prune /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prune /app/out/full/ .
RUN pnpm exec turbo run build --filter=@ayvo/web

# --- Web server ----------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
# HOSTNAME must be set explicitly: Docker sets it to the container ID, and the standalone server
# would then listen only on the container's own address.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Files stay owned by root: the unprivileged `node` user can read but not modify the app.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
