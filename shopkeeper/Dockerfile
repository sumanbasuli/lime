# Build stage.
# Expects the docker build context at the repository root so the
# shared ./data catalog can be baked into the image alongside the
# Go source tree under ./shopkeeper.
FROM golang:1.27.3-alpine AS builder
ARG LIME_VERSION=dev
ARG LIME_COMMIT=""
WORKDIR /app
COPY shopkeeper/go.mod shopkeeper/go.sum ./
RUN go mod download
COPY shopkeeper/ ./
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags "-s -w -X github.com/sumanbasuli/lime/shopkeeper/internal/buildinfo.Version=${LIME_VERSION} -X github.com/sumanbasuli/lime/shopkeeper/internal/buildinfo.Commit=${LIME_COMMIT}" \
    -o /shopkeeper ./cmd/shopkeeper \
    && CGO_ENABLED=0 GOOS=linux go build -o /container-init ./cmd/container-init

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
    util-linux \
    passwd \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 lime \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin lime \
    && chmod 0700 /home/lime \
    && mkdir -p /app/screenshots \
    && chmod 0700 /app/screenshots

ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV HOME=/home/lime
ENV XDG_CONFIG_HOME=/home/lime/.config
ENV XDG_CACHE_HOME=/home/lime/.cache

WORKDIR /app
COPY --chmod=0755 --from=builder /shopkeeper /container-init ./
COPY shopkeeper/migrations/ ./migrations/
# Baked data catalog so the image works without bind mounts.
# Local Docker and release bundles still override via /shared-data mount.
COPY data/ ./data/
RUN find /app/migrations /app/data -type d -exec chmod 0755 {} + \
    && find /app/migrations /app/data -type f -exec chmod 0644 {} +

EXPOSE 8080

# Root is used only to prepare the existing screenshot volume. The entrypoint
# then replaces itself with the requested command as UID/GID 10001, no groups,
# no capabilities, and no-new-privileges. HTTP/Chromium never run as root.
USER 0:0
ENTRYPOINT ["/app/container-init"]
CMD ["./shopkeeper"]
