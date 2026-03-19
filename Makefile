.PHONY: start-db start-shopkeeper start-ui start-all stop-all \
       logs-db logs-shopkeeper logs-ui \
       dev-ui dev-shopkeeper clean

# ---- Docker commands ----

start-db:
	docker compose up -d db
	@echo "PostgreSQL is starting on port 5432..."
	@docker compose exec db sh -c 'until pg_isready -U lime -d lime_db; do sleep 1; done'
	@echo "PostgreSQL is ready."

start-shopkeeper: start-db
	docker compose up -d --build shopkeeper
	@echo "Shopkeeper is starting on port 8080..."

start-ui:
	docker compose up -d --build ui
	@echo "UI is starting on port 3000..."

start-all:
	docker compose up -d --build
	@echo "All services starting..."
	@echo "  DB:         http://localhost:5432"
	@echo "  Shopkeeper: http://localhost:8080"
	@echo "  UI:         http://localhost:3000"

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
	cd lime && npm run dev

dev-shopkeeper:
	cd shopkeeper && go install github.com/air-verse/air@latest && air

# ---- Cleanup ----

clean:
	docker compose down -v
	@echo "All services stopped and volumes removed."
