# MCP Integration

LIME includes a read-only MCP endpoint so third-party AI clients can inspect scans and reports without needing to run inside the LIME dashboard.

## Transport

The first MCP release uses HTTP JSON-RPC on the existing Shopkeeper HTTP service.

Endpoint:

```text
/mcp
```

The MCP listener is controlled from Settings. Users can enable or disable MCP at runtime.

## Authentication

Authentication uses a generated instance-level MCP key:

- users generate or regenerate the key in Settings
- the raw key is shown only once
- only a hash is stored in PostgreSQL
- clients send `Authorization: Bearer <mcp-key>`
- regenerating the key revokes the old key

Full OAuth-based MCP authorization is deferred.

## First Capability Set

The first MCP release is read-only.

Expose:

- list scans
- get scan metadata, status, progress, score, and coverage
- list issue groups for a scan
- get issue detail with paginated occurrences
- read report availability and export metadata
- read relevant reporting and performance settings

Do not expose:

- create scans
- retry, pause, resume, rescan, or delete scans
- mark or unmark false positives
- mutate Settings
- trigger report generation automatically

## Safety Requirements

- Disabled MCP must reject new requests immediately.
- Unauthorized MCP requests must return `401`.
- Large responses must be paginated.
- Screenshot access must stay behind the existing LIME serving model.
- MCP must not add a new required service in the first release.
