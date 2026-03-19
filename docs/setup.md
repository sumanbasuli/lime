# Local Development Setup

This document describes how to set up the LIME accessibility scanner for local development.

## Prerequisites

- **Docker** and **Docker Compose** (for running PostgreSQL and full stack)
- **Go 1.25+** (for Shopkeeper backend development)
- **Node.js 23+** and **npm** (for NextJS frontend development)

## Environment Variables

All environment configuration is managed through `.env` files:

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_USER` | `lime` | PostgreSQL username |
| `POSTGRES_PASSWORD` | `lime_dev_password` | PostgreSQL password |
| `POSTGRES_DB` | `lime_db` | PostgreSQL database name |
| `DATABASE_URL` | `postgresql://lime:lime_dev_password@db:5432/lime_db?sslmode=disable` | Full connection string (Docker) |
| `SHOPKEEPER_PORT` | `8080` | Port for the Go backend API |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8080` | Shopkeeper API URL for the frontend |

### File Locations

- **Root `.env`**: Used by `docker-compose.yml` for container configuration.
- **Root `.env.example`**: Template — copy to `.env` for new setups.
- **`lime/.env.local`**: Used by NextJS in local development. Uses `localhost` instead of `db` for the database host.

## Running the Stack

### Full Stack (Docker)

```bash
make start-all      # Build and start all services
make stop-all       # Stop all services
make clean          # Stop and remove all data volumes
```

### Local Development (Hybrid)

For faster iteration, run only the database in Docker and the apps natively:

```bash
make start-db          # Start PostgreSQL in Docker
make dev-shopkeeper    # Go backend with Air hot reload (in a new terminal)
make dev-ui            # NextJS with hot reload (in a new terminal)
```

### Individual Services

```bash
make start-db          # PostgreSQL only
make start-shopkeeper  # Go backend (auto-starts DB)
make start-ui          # NextJS frontend
```

### Logs

```bash
make logs-db
make logs-shopkeeper
make logs-ui
```

## Service URLs

| Service | URL |
|---------|-----|
| NextJS UI | http://localhost:3000 |
| Shopkeeper API | http://localhost:8080 |
| Health Check | http://localhost:8080/api/health |
| Dashboard Stats | http://localhost:8080/api/stats |
| PostgreSQL | localhost:5432 |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Service health check |
| GET | `/api/stats` | Dashboard aggregates (total scans/issues/pages) |
| POST | `/api/scans` | Create a new scan (body: `{"sitemap_url": "..."}`) |
| GET | `/api/scans` | List all scans |
| GET | `/api/scans/{id}` | Get scan detail by ID |
| GET | `/api/scans/{id}/issues` | Get issues with occurrences for a scan |

## Frontend Pages

| Route | Description |
|-------|-------------|
| `/` | Dashboard: stats, recent scans, new scan form |
| `/scans` | All scans list |
| `/scans/new` | New scan form |
| `/scans/[id]` | Scan detail with live progress |
| `/scans/[id]/issues` | Expandable issues viewer |

## Project Structure

```
lime/                    (project root)
├── docs/                Documentation
├── lime/                NextJS frontend (App Router, shadcn/ui, Drizzle ORM)
├── shopkeeper/          Go backend (Chi, pgx, golang-migrate)
├── docker-compose.yml   Multi-container orchestration
├── Makefile             Developer commands
└── .env                 Environment variables
```

## Tech Stack

### Frontend (`/lime`)
- **Framework**: NextJS with App Router
- **UI Components**: shadcn/ui (built on Radix UI + TailwindCSS)
- **Database ORM**: Drizzle ORM (read-only access to shared PostgreSQL)
- **Styling**: TailwindCSS v4

### Backend (`/shopkeeper`)
- **Language**: Go
- **Router**: Chi v5
- **Database Driver**: pgx v5 with pgxpool connection pooling
- **Migrations**: golang-migrate v4
- **Hot Reload**: Air

### Infrastructure
- **Database**: PostgreSQL 17 (Alpine)
- **Containers**: Docker Compose
- **Headless Browser**: Chromium (installed in Shopkeeper container for Juicer module)

## Database Migrations

Migrations are managed by the Go backend using `golang-migrate`. They run automatically when Shopkeeper starts. Migration files live in `shopkeeper/migrations/`.

The Drizzle schema in `lime/src/db/schema.ts` must be kept in sync with the SQL migrations manually. All schema changes should originate in the Go migrations (since Shopkeeper owns writes), then be reflected in the Drizzle schema.
