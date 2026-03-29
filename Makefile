ifneq (,$(wildcard .env))
include .env
export
endif

VERSION := $(shell cat VERSION)
DIST_DIR := dist
UI_IMAGE := lime-ui
SHOPKEEPER_IMAGE := lime-shopkeeper
LIME_API_PORT ?= 8080
LIME_UI_PORT ?= 3000

.PHONY: start-db start-shopkeeper start-ui start-all stop-all \
       logs-db logs-shopkeeper logs-ui \
       dev-ui dev-shopkeeper \
       build build-ui build-shopkeeper build-release-bundle \
       build-docker build-docker-ui build-docker-shopkeeper \
       clean

# ---- Docker commands ----

start-db:
	docker compose up -d db
	@echo "PostgreSQL is starting..."
	@docker compose exec db sh -c 'until pg_isready -U "$${POSTGRES_USER:-lime}" -d "$${POSTGRES_DB:-lime_db}"; do sleep 1; done'
	@echo "PostgreSQL is ready."

start-shopkeeper: start-db
	docker compose up -d --build shopkeeper
	@echo "Shopkeeper is starting on port $(LIME_API_PORT)..."

start-ui:
	docker compose up -d --build ui
	@echo "UI is starting on port $(LIME_UI_PORT)..."

start-all:
	docker compose up -d --build
	@echo "All services starting..."
	@echo "  DB:         bundled local PostgreSQL on localhost:5432"
	@echo "  Shopkeeper: http://localhost:$(LIME_API_PORT)"
	@echo "  UI:         http://localhost:$(LIME_UI_PORT)"

stop-all:
	docker compose down
	@echo "All services stopped."

# ---- Logs ----

logs-db:
	docker compose logs -f db

logs-shopkeeper:
	docker compose logs -f shopkeeper

logs-ui:
	docker compose logs -f ui

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
	cd shopkeeper && GOCACHE=$$PWD/.cache/go-build go build -o ../$(DIST_DIR)/shopkeeper/shopkeeper ./cmd/shopkeeper
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
	@echo "  $(SHOPKEEPER_IMAGE):v$(VERSION)"
	@echo "  $(UI_IMAGE):v$(VERSION)"

build-docker-shopkeeper:
	docker build \
		--tag $(SHOPKEEPER_IMAGE):v$(VERSION) \
		--file shopkeeper/Dockerfile \
		shopkeeper

build-docker-ui:
	docker build \
		--tag $(UI_IMAGE):v$(VERSION) \
		--file lime/Dockerfile \
		lime

# ---- Cleanup ----

clean:
	docker compose down -v
	rm -rf $(DIST_DIR)
	@echo "All services stopped and volumes removed."
