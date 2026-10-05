# syntax=docker.io/docker/dockerfile:1

# Keep in step with "packageManager" in package.json.
FROM oven/bun:1.3.6-alpine AS base

# Production dependencies only, for the runtime image.
FROM base AS deps
WORKDIR /app

COPY bun.lock package.json ./
RUN bun install --frozen-lockfile --production

# Lint, typecheck and tests with the full dependency set. CI builds this
# stage first (test-target: test) and only builds, pushes and deploys the
# image when it passes.
FROM base AS test
WORKDIR /app

COPY bun.lock package.json ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run lint && bun run typecheck && bun run test

# Production image
FROM base AS runner
WORKDIR /app

RUN apk add --no-cache curl && \
    addgroup --system --gid 1001 coolify && \
    adduser --system --uid 1001 hono

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=hono:coolify . .

USER hono

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

CMD ["bun", "--bun", "run", "src/index.ts"]
