# Docker & Deployment

The entire accessibility system is containerized to ensure consistent local development and production environments.

## Architecture

The system will use `docker-compose` to manage the multi-container setup.

### Containers

1. **db**: The PostgreSQL database instance.
2. **shopkeeper**: The Go backend API, orchestrating the scans. This container will also need headless browser dependencies installed (e.g., Chromium) for axe-core to run via Juicer.
3. **ui**: The NextJS application.

## CLI Scripts

The project root will contain helper scripts (e.g., Makefile or bash scripts) to manage the containers easily:

* `make start-db`: Starts only the PostgreSQL container.
* `make start-shopkeeper`: Starts the Go backend (requires the DB to be running).
* `make start-ui`: Starts the NextJS frontend.
* `make start-all`: Brings up the entire stack using `docker-compose up -d`.
* `make stop-all`: Tears down the stack.

## Considerations for Shopkeeper Container

Running headless browsers inside Docker requires specific configurations to avoid memory issues (e.g., utilizing `--shm-size` or disabling `/dev/shm` usage). The Dockerfile for Shopkeeper must be based on an image that supports these dependencies (like `buildkite/puppeteer` or a custom Debian base).
