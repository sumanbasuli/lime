ifneq (,$(wildcard .env))
include .env
export
endif

VERSION := $(shell cat VERSION)
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DIST_DIR := dist
BACKUP_DIR := $(DIST_DIR)/backups
HOST_KERNEL := $(shell uname -s 2>/dev/null || echo unknown)
ifeq ($(HOST_KERNEL),Darwin)
HOST_OS := macos
else ifeq ($(HOST_KERNEL),Linux)
HOST_OS := linux
else
HOST_OS := unknown
endif
LIME_INSTALL_ROOT ?= /opt/lime
LIME_CONFIG_ROOT ?= /etc/lime
LIME_SYSTEMD_DIR ?= /etc/systemd/system
UI_IMAGE ?= lime-ui
SHOPKEEPER_IMAGE ?= lime-shopkeeper
LIME_API_PORT ?= 8080
LIME_UI_PORT ?= 3000
LIME_DOCS_PORT ?= 3001
LIME_IMAGE_TAG ?= v$(VERSION)
DOCKER_BUILD_FLAGS ?= --pull
DOCKER_COMPOSE ?= $(shell if docker compose version >/dev/null 2>&1; then printf 'docker compose'; elif command -v docker-compose >/dev/null 2>&1; then printf 'docker-compose'; else printf 'docker compose'; fi)
SHOPKEEPER_LDFLAGS := -s -w \
  -X github.com/sumanbasuli/lime/shopkeeper/internal/buildinfo.Version=$(VERSION) \
  -X github.com/sumanbasuli/lime/shopkeeper/internal/buildinfo.Commit=$(GIT_COMMIT)

.PHONY: start-db start-shopkeeper start-ui start-dev start-all stop-all \
       logs-db logs-shopkeeper logs-ui \
       dev-ui dev-shopkeeper \
       migrate-all \
       build build-ui build-shopkeeper build-release-bundle \
       build-docker build-docker-ui build-docker-shopkeeper \
       publish-release-images \
       backup-db update update-release debian-install debian-update require-linux host-info \
       docs docs-run docs-dev docs-build docs-site-build docs-check-source \
       clean

# ---- Host detection ----

host-info:
	@echo "Host OS:       $(HOST_OS) ($(HOST_KERNEL))"
	@echo "Docker Compose: $(DOCKER_COMPOSE)"
	@echo "Install root:  $(LIME_INSTALL_ROOT)"
	@echo "Config root:   $(LIME_CONFIG_ROOT)"

require-linux:
	@if [ "$(HOST_OS)" != "linux" ]; then \
		echo "This target is Debian/Linux-only. Detected $(HOST_OS) ($(HOST_KERNEL))."; \
		echo "On macOS, use 'make start-all' for Docker or 'make start-dev' for hot reload."; \
		exit 1; \
	fi

# ---- Docker commands ----

start-db:
	$(DOCKER_COMPOSE) up -d db
	@echo "PostgreSQL is starting..."
	@$(DOCKER_COMPOSE) exec db sh -c 'until pg_isready -U "$${POSTGRES_USER:-lime}" -d "$${POSTGRES_DB:-lime_db}"; do sleep 1; done'
	@echo "PostgreSQL is ready."

migrate-all: start-db
	$(DOCKER_COMPOSE) run --rm --build --no-deps shopkeeper ./shopkeeper --migrate
	@echo "Database migrations completed."

start-shopkeeper: start-db
	$(DOCKER_COMPOSE) up -d --build shopkeeper
	@echo "Shopkeeper is starting on port $(LIME_API_PORT)..."

start-ui: start-db
	$(DOCKER_COMPOSE) up -d --build --force-recreate ui
	@echo "UI is starting on port $(LIME_UI_PORT)..."

start-dev: start-db
	$(DOCKER_COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml up -d --build shopkeeper
	$(DOCKER_COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml up -d --build --force-recreate ui
	@echo "Development services starting with NextJS hot reload..."
	@echo "  DB:         bundled local PostgreSQL on localhost:5432"
	@echo "  Shopkeeper: http://localhost:$(LIME_API_PORT)"
	@echo "  UI:         http://localhost:$(LIME_UI_PORT)"

start-all: start-db
	$(DOCKER_COMPOSE) up -d --build shopkeeper
	$(DOCKER_COMPOSE) up -d --build --force-recreate ui
	@echo "Production services starting from built images..."
	@echo "  DB:         bundled local PostgreSQL on localhost:5432"
	@echo "  Shopkeeper: http://localhost:$(LIME_API_PORT)"
	@echo "  UI:         http://localhost:$(LIME_UI_PORT)"

stop-all:
	$(DOCKER_COMPOSE) down
	@echo "All services stopped."

# ---- Logs ----

logs-db:
	$(DOCKER_COMPOSE) logs -f db

logs-shopkeeper:
	$(DOCKER_COMPOSE) logs -f shopkeeper

logs-ui:
	$(DOCKER_COMPOSE) logs -f ui

# ---- Development (outside Docker) ----

dev-ui:
	cd lime && SHOPKEEPER_URL=http://localhost:$(LIME_API_PORT) npm run dev

dev-shopkeeper:
	cd shopkeeper && go install github.com/air-verse/air@latest && air

# ---- Production build ----

build: build-shopkeeper build-ui build-release-bundle
	@echo "Production artifacts ready in $(DIST_DIR)/"

build-shopkeeper:
	rm -rf $(DIST_DIR)/shopkeeper
	mkdir -p $(DIST_DIR)/shopkeeper
	cd shopkeeper && GOCACHE=$$PWD/.cache/go-build go build -ldflags "$(SHOPKEEPER_LDFLAGS)" -o ../$(DIST_DIR)/shopkeeper/shopkeeper ./cmd/shopkeeper
	cp -R shopkeeper/migrations $(DIST_DIR)/shopkeeper/migrations

build-ui:
	rm -rf $(DIST_DIR)/ui
	cd lime && npm run build
	mkdir -p $(DIST_DIR)/ui
	cp -R lime/.next/standalone/. $(DIST_DIR)/ui/
	mkdir -p $(DIST_DIR)/ui/.next
	cp -R lime/.next/static $(DIST_DIR)/ui/.next/static
	cp -R lime/public $(DIST_DIR)/ui/public

build-release-bundle:
	./scripts/build-release-bundle.sh $(VERSION)

build-docker: build-docker-shopkeeper build-docker-ui
	@echo "Production images built:"
	@echo "  $(SHOPKEEPER_IMAGE):$(LIME_IMAGE_TAG)"
	@echo "  $(UI_IMAGE):$(LIME_IMAGE_TAG)"

build-docker-shopkeeper:
	docker build $(DOCKER_BUILD_FLAGS) \
		--build-arg LIME_VERSION=$(VERSION) \
		--build-arg LIME_COMMIT=$(GIT_COMMIT) \
		--tag $(SHOPKEEPER_IMAGE):$(LIME_IMAGE_TAG) \
		--file shopkeeper/Dockerfile \
		.

build-docker-ui:
	docker build $(DOCKER_BUILD_FLAGS) \
		--build-arg LIME_VERSION=$(VERSION) \
		--build-arg LIME_COMMIT=$(GIT_COMMIT) \
		--tag $(UI_IMAGE):$(LIME_IMAGE_TAG) \
		--file lime/Dockerfile \
		.

publish-release-images:
	LIME_IMAGE_REGISTRY="$(LIME_IMAGE_REGISTRY)" \
	LIME_SHA_TAG="$(LIME_SHA_TAG)" \
	PUBLISH_LATEST="$(PUBLISH_LATEST)" \
	PUSH_IMAGES="$(PUSH_IMAGES)" \
	./scripts/publish-release-images.sh $(LIME_IMAGE_TAG)

# ---- Docs site ----

docs:
	./scripts/docs-refresh.sh

docs-run: docs-build
	npm --prefix docs-site run serve -- --port $(LIME_DOCS_PORT)

docs-dev:
	npm --prefix docs-site run dev -- -p $(LIME_DOCS_PORT)

docs-check-source:
	@untracked=$$(git ls-files --others --exclude-standard docs-site/app docs-site/components docs-site/content docs-site/lib docs-site/scripts | grep -E '\.(css|mjs|ts|tsx)$$' || true); \
	ignored=$$(git ls-files --others --ignored --exclude-standard docs-site/app docs-site/components docs-site/content docs-site/lib docs-site/scripts | grep -E '\.(css|mjs|ts|tsx)$$' || true); \
	if [ -n "$$untracked$$ignored" ]; then \
		echo "Docs source files would be present locally but missing from GitHub Pages CI:" >&2; \
		if [ -n "$$untracked" ]; then echo "$$untracked" >&2; fi; \
		if [ -n "$$ignored" ]; then echo "$$ignored" >&2; fi; \
		echo "Track these files or update .gitignore before building docs." >&2; \
		exit 1; \
	fi

docs-build docs-site-build: docs-check-source
	npm --prefix docs-site run build

# ---- Backup + update ----

backup-db:
	@mkdir -p $(BACKUP_DIR)
	@ts=$$(date +%Y%m%d-%H%M%S); \
	backup_file=$(BACKUP_DIR)/lime-manual-$$ts.sql.gz; \
	echo "Dumping bundled db service to $$backup_file"; \
	$(DOCKER_COMPOSE) exec -T db pg_dump -U $${POSTGRES_USER:-lime} $${POSTGRES_DB:-lime_db} | gzip -9 > $$backup_file; \
	echo "Backup written to $$backup_file"

# `make update TAG=v0.2.0` — rolling update for a local dev Docker stack.
# Rebuilds images from source and recreates services one at a time.
update:
	@if [ -z "$(TAG)" ]; then echo "usage: make update TAG=<version>" >&2; exit 1; fi
	@echo "==> Backing up bundled database"
	@$(MAKE) backup-db
	@echo "==> Checking out $(TAG) and rebuilding"
	git fetch --tags --prune
	git checkout $(TAG)
	@echo "==> Rebuilding images"
	$(MAKE) build-docker
	@echo "==> Applying migrations"
	$(DOCKER_COMPOSE) run --rm --no-deps shopkeeper ./shopkeeper --migrate
	@echo "==> Rolling Shopkeeper"
	$(DOCKER_COMPOSE) up -d --no-deps shopkeeper
	@echo "==> Rolling UI"
	$(DOCKER_COMPOSE) up -d --no-deps ui
	@echo "Update to $(TAG) complete."

# `make update-release TAG=v0.2.0` — rolling update for a release-bundle
# deployment that pulls the published GHCR images.
update-release:
	@if [ -z "$(TAG)" ]; then echo "usage: make update-release TAG=<version>" >&2; exit 1; fi
	./scripts/docker-update.sh $(TAG)

# `make debian-install` — build and install the native systemd deployment on Debian-family Linux.
debian-install:
	@$(MAKE) require-linux
	$(MAKE) build
	sudo LIME_INSTALL_ROOT="$(LIME_INSTALL_ROOT)" \
		LIME_CONFIG_ROOT="$(LIME_CONFIG_ROOT)" \
		LIME_SYSTEMD_DIR="$(LIME_SYSTEMD_DIR)" \
		./scripts/debian-install.sh

# `make debian-update TAG=vX.Y.Z` — update a native Debian-family systemd deployment.
debian-update:
	@if [ -z "$(TAG)" ]; then echo "usage: make debian-update TAG=<version>" >&2; exit 1; fi
	@$(MAKE) require-linux
	sudo LIME_INSTALL_ROOT="$(LIME_INSTALL_ROOT)" \
		LIME_CONFIG_ROOT="$(LIME_CONFIG_ROOT)" \
		LIME_SYSTEMD_DIR="$(LIME_SYSTEMD_DIR)" \
		./scripts/debian-update.sh $(TAG)

# ---- Cleanup ----

clean:
	$(DOCKER_COMPOSE) down -v
	rm -rf $(DIST_DIR)
	@echo "All services stopped and volumes removed."
