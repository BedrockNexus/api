# syntax=docker.io/docker/dockerfile:1

FROM oven/bun:alpine AS base

# Install dependencies
FROM base AS deps
WORKDIR /app

COPY bun.lock package.json ./
RUN bun install

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

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

CMD ["bun", "--bun", "run", "src/index.ts"]
