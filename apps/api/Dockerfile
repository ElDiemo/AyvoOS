# syntax=docker/dockerfile:1
#
# AYVO OS API (NestJS) image. Build from the repository root:
#   docker build -f apps/api/Dockerfile --target runtime .
#
# Targets:
#   runtime  the API server (default, last stage): compiled dist + production node_modules only
#   migrate  one-off `prisma migrate deploy` runner used by the deploy scripts, followed by the
#            core runtime role setup (dist/database/core-db-setup.js, ADR 0041); with the Finance
#            config, by scripts/deploy-finance-dev.sh (ADR 0039)
#   runtime  also the Finance unit: same image, entry point `node dist/finance/main.js`
#
# No secrets are used at build time. Configuration (DATABASE_URL, REDIS_URL, ...) is injected
# at runtime as environment variables and validated by src/config/env.ts.

# Keep in step with .nvmrc. The exact version also pins the Corepack that fetches pnpm.
ARG NODE_VERSION=24.21.0
# Keep in step with the turbo devDependency in the root package.json.
ARG TURBO_VERSION=2.11.7

FROM node:${NODE_VERSION}-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1
# openssl lets Prisma pick the right schema-engine binary for migrations on musl.
RUN apk add --no-cache openssl && corepack enable pnpm
WORKDIR /app

# --- Prune the monorepo to the API and its workspace dependencies --------------------------------
FROM base AS prune
ARG TURBO_VERSION
RUN npm install --global --no-fund --no-audit "turbo@${TURBO_VERSION}"
COPY . .
RUN turbo prune @ayvo/api --docker

# --- Install and build ---------------------------------------------------------------------------
FROM base AS build
# Dependency manifests + pruned lockfile first, so this layer is cached until dependencies change.
COPY --from=prune /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=prune /app/out/full/ .
# Builds @ayvo/types, generates the Prisma client and compiles the API (see turbo.json).
RUN pnpm exec turbo run build --filter=@ayvo/api
# Self-contained copies of the API package: production-only for the server, full for migrations.
RUN pnpm --filter=@ayvo/api deploy --prod /out/runtime \
 && pnpm --filter=@ayvo/api deploy /out/migrate

# --- Migration runner ----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS migrate
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/migrate/package.json /out/migrate/prisma.config.ts /out/migrate/prisma-finance.config.ts ./
COPY --from=build /out/migrate/prisma ./prisma
# Finance unit (ADR 0039): its migrations and the role/schema setup (dist/finance/db-setup.js).
COPY --from=build /out/migrate/prisma-finance ./prisma-finance
# The core runtime role setup (ADR 0041) and its compiled Prisma client.
COPY --from=build /out/migrate/dist ./dist
COPY --from=build /out/migrate/node_modules ./node_modules
USER node
# Applies committed migrations only. Never `migrate dev`, `migrate reset` or `db push` (ADR 0008).
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# --- API server ----------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    API_PORT=4000
# Files stay owned by root: the unprivileged `node` user can read but not modify the app.
COPY --from=build /out/runtime/package.json ./
COPY --from=build /out/runtime/node_modules ./node_modules
COPY --from=build /out/runtime/dist ./dist
# Mount point for persistent file storage (FILE_STORAGE_DIR). A new named volume inherits this
# ownership, so the unprivileged `node` user can write label artwork and PDFs there.
RUN mkdir -p /var/lib/ayvo/files && chown node:node /var/lib/ayvo/files
USER node
EXPOSE 4000
# Liveness only: the endpoint answers 200 (status ok or degraded) while the process serves HTTP.
# scripts/deploy-dev.sh additionally requires status "ok" (PostgreSQL and Redis reachable).
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
