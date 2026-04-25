# Expects the docker build context at the repository root so the
# shared ./data catalog can be baked into the image alongside ./lime.
FROM node:23-alpine AS base
ARG LIME_VERSION=dev
ARG LIME_COMMIT=""

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app
COPY lime/package.json lime/package-lock.json ./
RUN npm ci

# Development image
FROM base AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY lime/ ./
EXPOSE 3000
CMD ["npm", "run", "dev"]

# Production build
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY lime/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Production image
FROM base AS runner
ARG LIME_VERSION=dev
ARG LIME_COMMIT=""
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV LIME_VERSION=${LIME_VERSION}
ENV LIME_COMMIT=${LIME_COMMIT}
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Baked data catalog so the image works without bind mounts (Fly, standalone VPS).
# Local Docker and release bundles still override via /shared-data mount.
COPY --chown=nextjs:nodejs data/ ./data/
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
