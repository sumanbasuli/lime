# LIME - Accessibility Scanner

LIME is an accessibility scanning system that uses axe-core to evaluate websites for accessibility issues. It processes sitemaps, scans individual pages with a headless browser, and presents grouped results through a web UI.

## Architecture

- **Shopkeeper** (`/shopkeeper`): Go backend REST API that orchestrates scanning (Chi router, pgx)
- **UI** (`/lime`): NextJS frontend dashboard (shadcn/ui, Drizzle ORM)
- **Database**: PostgreSQL (shared between both services)

See the [docs](./docs/index.md) folder for detailed architecture and design documentation.

## Prerequisites

- Docker and Docker Compose
- Go 1.24+ (for local development)
- Node.js 23+ (for local development)

## Quick Start

### Start everything

```bash
make start-all
```

### Access the application

- **UI**: http://localhost:3000
- **API**: http://localhost:8080
- **API Health**: http://localhost:8080/api/health

### Stop everything

```bash
make stop-all
```

## Local Development (without Docker)

Start only the database:

```bash
make start-db
```

Then in separate terminals:

```bash
make dev-shopkeeper    # Go backend with hot reload (Air)
make dev-ui            # NextJS with hot reload
```

## Available Commands

| Command | Description |
|---------|-------------|
| `make start-db` | Start PostgreSQL only |
| `make start-shopkeeper` | Start Go backend (starts DB if needed) |
| `make start-ui` | Start NextJS frontend |
| `make start-all` | Start entire stack |
| `make stop-all` | Stop all services |
| `make logs-db` | Tail database logs |
| `make logs-shopkeeper` | Tail backend logs |
| `make logs-ui` | Tail frontend logs |
| `make dev-ui` | Run NextJS locally with hot reload |
| `make dev-shopkeeper` | Run Go backend locally with Air hot reload |
| `make clean` | Stop all services and remove volumes |
