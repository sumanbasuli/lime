# Build stage.
# Expects the docker build context at the repository root so the
# shared ./data catalog can be baked into the image alongside the
# Go source tree under ./shopkeeper.
FROM golang:1.25-alpine AS builder
ARG LIME_VERSION=dev
ARG LIME_COMMIT=""
WORKDIR /app
COPY shopkeeper/go.mod shopkeeper/go.sum ./
RUN go mod download
COPY shopkeeper/ ./
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags "-s -w -X github.com/sumanbasuli/lime/shopkeeper/internal/buildinfo.Version=${LIME_VERSION} -X github.com/sumanbasuli/lime/shopkeeper/internal/buildinfo.Commit=${LIME_COMMIT}" \
    -o /shopkeeper ./cmd/shopkeeper

# Runtime stage - Debian for Chromium headless browser support (needed by Juicer)
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app
COPY --from=builder /shopkeeper .
COPY shopkeeper/migrations/ ./migrations/
# Baked data catalog so the image works without bind mounts (Fly, standalone VPS).
# Local Docker and release bundles still override via /shared-data mount.
COPY data/ ./data/

EXPOSE 8080

CMD ["./shopkeeper"]
