# syntax=docker.io/docker/dockerfile:1

FROM oven/bun:alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache curl
WORKDIR /app

# Install dependencies
COPY bun.lock package.json ./
RUN bun install

# Production image
FROM base AS runner
WORKDIR /app

# Install curl for healthchecks
RUN apk add --no-cache curl

ENV NODE_ENV=production
ENV PORT=3001

RUN addgroup --system --gid 1001 coolify
RUN adduser --system --uid 1001 hono

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=hono:coolify . .

USER hono

EXPOSE 3001

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

CMD ["bun", "--bun", "run", "src/index.ts"]
