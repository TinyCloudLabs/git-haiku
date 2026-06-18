# syntax=docker/dockerfile:1.7
#
# Git Haiku backend image (TEE-deployable to Phala dstack).
#
# Multi-stage: a deps/build stage installs the workspace and typechecks; the
# runtime stage carries only what the backend needs to run (its source + the
# shared package + production node_modules) and starts it via tsx. The RedPill
# key, backend identity, node host, etc. are injected as dstack ENCRYPTED env at
# deploy time — never baked into the image.
#
# amd64 is REQUIRED: Phala CVMs run on Intel TDX. Build with:
#   docker buildx build --platform linux/amd64 -t githaiku-backend .

# ---- build stage ---------------------------------------------------------
FROM --platform=linux/amd64 node:20-slim AS build
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Workspace manifests first (better layer caching).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/backend/package.json packages/backend/
# The frontend is a separate deploy target — copy ONLY its manifest so
# --frozen-lockfile can validate the workspace, but install just backend + shared.
COPY packages/frontend/package.json packages/frontend/
RUN pnpm install --frozen-lockfile --filter @githaiku/backend... --filter @githaiku/shared...

# Sources.
COPY packages/shared packages/shared
COPY packages/backend packages/backend

# Typecheck both packages (fails the build on type errors).
RUN pnpm --filter @githaiku/shared build && pnpm --filter @githaiku/backend build

# ---- runtime stage -------------------------------------------------------
FROM --platform=linux/amd64 node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Carry the installed workspace (node_modules + sources) from the build stage.
COPY --from=build /app /app

WORKDIR /app/packages/backend
EXPOSE 8787

# tsx runs the TypeScript entrypoint directly (tsx is a backend dependency).
CMD ["pnpm", "start"]
