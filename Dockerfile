#
# Git Haiku backend image (TEE-deployable to Phala dstack).
#
# Multi-stage: a deps/build stage installs the workspace, typechecks, and emits
# a bundled JS backend; a deploy stage materializes production dependencies; the
# runtime stage carries only dist + production node_modules. The RedPill key,
# backend identity, node host, etc. are injected as dstack ENCRYPTED env at
# deploy time — never baked into the image.
#
# amd64 is REQUIRED: Phala CVMs run on Intel TDX. Build with:
#   docker buildx build --platform linux/amd64 -t githaiku-backend .

# ---- build stage ---------------------------------------------------------
FROM --platform=linux/amd64 public.ecr.aws/docker/library/node:20-slim AS build
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

# Typecheck/bundle the backend (fails the build on type errors).
RUN pnpm --filter @githaiku/backend build

# ---- production dependency stage ----------------------------------------
FROM build AS prod-deps
RUN pnpm --filter @githaiku/backend deploy --prod /runtime

# ---- runtime stage -------------------------------------------------------
FROM --platform=linux/amd64 public.ecr.aws/docker/library/node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Deploy provenance surfaced on GET /info for stale-deploy detection by
# internal.tinycloud.xyz. GIT_SHA is the delta signal the dashboard compares
# against the repo default-branch HEAD; pass it at build time, e.g.:
#   docker buildx build --platform linux/amd64 --build-arg GIT_SHA=$(git rev-parse HEAD) ...
ARG GIT_SHA=""
ENV GIT_SHA=${GIT_SHA}

# Runtime carries the deployed backend package: package.json, dist, and
# production node_modules only.
COPY --from=prod-deps /runtime ./

EXPOSE 8787

CMD ["node", "dist/index.js"]
