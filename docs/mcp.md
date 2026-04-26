# MCP Integration

LIME includes a read-only MCP endpoint for connecting third-party AI tools to an existing LIME instance. It lets an AI client inspect scans, scores, issue groups, paginated occurrences, report availability, and server settings without running inside the dashboard.

This page is both the operator guide and the client-connection guide. It documents the current endpoint, key handling, headers, tools, and client configuration.

## Status

MCP is available now when it is enabled in **Settings > Integrations** and an MCP key has been generated.

The current implementation provides:

- `POST /mcp` on the Shopkeeper HTTP service.
- JSON-RPC request and response handling for MCP initialization, ping, tool listing, and tool calls.
- `Authorization: Bearer <lime-mcp-key>` authentication.
- Hashed MCP key storage; the raw key is only shown when generated.
- Read-only tools for scans, issue groups, issue detail, report metadata, and visible settings.
- Bounded `limit` and `offset` pagination for large lists.

Current limitations and planned hardening:

- `GET /mcp` streaming is not enabled. LIME currently returns JSON responses to `POST /mcp`.
- MCP session state is not currently used.
- OAuth and scoped MCP keys are not implemented.
- Origin validation currently accepts requests with no `Origin` header and localhost origins. Server-to-server clients and local bridges usually work because they omit `Origin`; browser-based remote clients may need future configurable origin allowlisting.
- MCP remains read-only. It does not create scans, retry scans, mutate settings, or change issue triage state.

## Transport

LIME exposes MCP on the existing Shopkeeper HTTP service.

Endpoint:

```text
https://<your-lime-host>/mcp
```

Local development endpoint:

```text
http://localhost:8080/mcp
```

Use an AI client configuration that supports remote HTTP or Streamable HTTP MCP servers. For the current LIME implementation:

- Clients send JSON-RPC messages with HTTP `POST`.
- Clients should include `Accept: application/json, text/event-stream` when their MCP library does so.
- LIME currently returns JSON responses, not a long-lived Server-Sent Events stream.
- LIME negotiates protocol version `2025-11-25` during `initialize`.
- LIME does not currently issue or require `MCP-Session-Id`.

Reference:

- <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
- <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>

## Enable MCP In LIME

The settings flow is:

1. Open **Settings**.
2. Open **Integrations**.
3. Enable **MCP server**.
4. Generate an MCP key.
5. Copy the raw key immediately. LIME only shows it once.
6. Add the endpoint URL and key to the AI tool's MCP configuration.

Key storage rules:

- LIME stores only a hash of the MCP key.
- Regenerating the key immediately revokes the previous key.
- Disabling MCP rejects new MCP requests.
- MCP is read-only.

## Authentication

Clients send a bearer token on every request:

```http
Authorization: Bearer <lime-mcp-key>
```

Do not put the key in the URL query string.

Use an environment variable on the client machine:

```bash
export LIME_MCP_URL="https://lime.example.com/mcp"
export LIME_MCP_KEY="lime_mcp_xxxxxxxxxxxxxxxxx"
```

For local development:

```bash
export LIME_MCP_URL="http://localhost:8080/mcp"
export LIME_MCP_KEY="lime_mcp_xxxxxxxxxxxxxxxxx"
```

## Generic AI Tool Configuration

AI tools use different MCP config file names, but remote HTTP MCP configuration usually needs the same four values:

- server name: `lime`
- transport type: Streamable HTTP or HTTP
- URL: `https://<your-lime-host>/mcp`
- header: `Authorization: Bearer <lime-mcp-key>`

Generic JSON shape:

```json
{
  "mcpServers": {
    "lime": {
      "type": "http",
      "url": "https://lime.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${LIME_MCP_KEY}"
      }
    }
  }
}
```

If the AI tool has a UI instead of a JSON config file, enter:

```text
Name: lime
Transport: Streamable HTTP
URL: https://lime.example.com/mcp
Authorization header: Bearer <lime-mcp-key>
```

If the AI tool only supports local `stdio` MCP servers, use a local HTTP-to-stdio bridge that supports Streamable HTTP and custom headers. Configure the bridge with `LIME_MCP_URL` and `LIME_MCP_KEY`; do not expose the key in the command arguments when the tool supports environment variables.

## Example Client Configs

### Remote HTTP Client

Use this shape for clients that support remote MCP servers directly:

```json
{
  "mcpServers": {
    "lime": {
      "transport": "streamable-http",
      "url": "https://lime.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${LIME_MCP_KEY}"
      }
    }
  }
}
```

Some clients use `type: "http"` instead of `transport: "streamable-http"`:

```json
{
  "mcpServers": {
    "lime": {
      "type": "http",
      "url": "https://lime.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${LIME_MCP_KEY}"
      }
    }
  }
}
```

Use whichever field names your AI tool documents. The important part is that the client sends Streamable HTTP requests to `/mcp` with the bearer header.

### Local Bridge Client

Use this pattern for AI tools that still require `stdio` MCP server entries:

```json
{
  "mcpServers": {
    "lime": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "${LIME_MCP_URL}",
        "--header",
        "Authorization: Bearer ${LIME_MCP_KEY}"
      ],
      "env": {
        "LIME_MCP_URL": "https://lime.example.com/mcp",
        "LIME_MCP_KEY": "lime_mcp_xxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

The bridge package name is an example of the common pattern, not a hard dependency of LIME. If your organization has a preferred MCP bridge, use that instead.

## Smoke Test With Curl

After enabling MCP and generating a key, test that the endpoint rejects missing credentials on a `POST` request:

```bash
curl -i -X POST "$LIME_MCP_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "ping"
  }'
```

Expected result:

```text
HTTP/1.1 401 Unauthorized
```

Then test an initialized request with credentials:

```bash
curl -i "$LIME_MCP_URL" \
  -H "Authorization: Bearer $LIME_MCP_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-11-25",
      "capabilities": {},
      "clientInfo": {
        "name": "lime-curl-smoke-test",
        "version": "0.1.0"
      }
    }
  }'
```

Expected result:

```text
HTTP/1.1 200 OK
content-type: application/json
```

The body should contain an MCP `initialize` response.

List the available tools:

```bash
curl -s "$LIME_MCP_URL" \
  -H "Authorization: Bearer $LIME_MCP_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list"
  }'
```

## TypeScript Client Example

This example is for documentation and integration testing. Prefer the configuration UI of your AI tool when possible.

Install the MCP SDK in a separate integration project:

```bash
npm install @modelcontextprotocol/sdk
```

Create `lime-mcp-client.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.LIME_MCP_URL;
const key = process.env.LIME_MCP_KEY;

if (!url || !key) {
  throw new Error("Set LIME_MCP_URL and LIME_MCP_KEY.");
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${key}`,
    },
  },
});

const client = new Client({
  name: "lime-integration-check",
  version: "0.1.0",
});

await client.connect(transport);

const tools = await client.listTools();
console.log(JSON.stringify(tools, null, 2));

await client.close();
```

Run it:

```bash
LIME_MCP_URL="https://lime.example.com/mcp" \
LIME_MCP_KEY="lime_mcp_xxxxxxxxxxxxxxxxx" \
npx tsx lime-mcp-client.ts
```

If your installed SDK version uses a different import path for the Streamable HTTP transport, check the SDK README for the current `StreamableHTTPClientTransport` import path. The LIME-side requirements stay the same: URL, Streamable HTTP, and bearer header.

## Current Read-Only Tools

The current MCP endpoint exposes these read-only tools:

```text
list_scans
get_scan
list_scan_issues
get_issue_detail
get_report_metadata
get_settings
```

Tool arguments:

- `list_scans`: `limit`, `offset`
- `get_scan`: `scan_id`
- `list_scan_issues`: `scan_id`, `limit`, `offset`
- `get_issue_detail`: `scan_id`, `kind`, `key`, `limit`, `offset`
- `get_report_metadata`: `scan_id`
- `get_settings`: no arguments

`kind` for `get_issue_detail` must be `failed` or `needs_review`. Use the `key` returned by `list_scan_issues`.

The endpoint does not expose:

- create scans
- retry failed pages
- pause scans
- resume scans
- start full rescans
- delete scans
- mark or unmark false positives
- mutate settings
- trigger report generation automatically

Large reads are paginated with `limit` and `offset`. For example:

```json
{
  "scanId": "66386d89-8564-40bb-93b3-c4a6fe70fcd4",
  "limit": 25,
  "offset": 0
}
```

Call a tool directly with JSON-RPC:

```bash
curl -s "$LIME_MCP_URL" \
  -H "Authorization: Bearer $LIME_MCP_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "list_scan_issues",
      "arguments": {
        "scan_id": "66386d89-8564-40bb-93b3-c4a6fe70fcd4",
        "limit": 20,
        "offset": 0
      }
    }
  }'
```

## Example AI Prompts

Once connected, users should be able to ask their AI tool:

```text
List the latest LIME scans and show me which ones are partial.
```

```text
For scan 66386d89-8564-40bb-93b3-c4a6fe70fcd4, summarize the top failed accessibility issues by severity and occurrence count.
```

```text
Show me the first 20 occurrences for the highest-impact issue in this scan, including affected URLs and selectors.
```

```text
Compare needs-review items and failed items for the latest completed scan.
```

## Security Requirements

- Validate `Origin` on MCP HTTP requests to reduce DNS rebinding risk.
- Require `Authorization: Bearer <key>` on every MCP request.
- Return `401` for missing, invalid, expired, or regenerated keys.
- Return `403` for invalid request origins.
- Bind local development examples to localhost.
- Do not log raw MCP keys.
- Do not include MCP keys in URLs.
- Do not expose screenshots outside LIME's existing screenshot-serving path.
- Do not expose write/admin tools.

## Troubleshooting

### `401 Unauthorized`

Check that:

- MCP is enabled in Settings.
- The key was copied before leaving the generation screen.
- The client sends `Authorization: Bearer <key>`.
- The key was not regenerated after the client was configured.

### `404 Not Found`

Check that:

- The LIME version includes MCP support.
- The URL ends with `/mcp`.
- The reverse proxy forwards `/mcp` to Shopkeeper.
- You are using the Shopkeeper public URL, not the docs-site URL.

### `403 Forbidden`

Check that:

- The request has no `Origin` header or uses a localhost origin.
- The reverse proxy preserves the `Origin` header.
- The AI client is not a browser-based remote client sending an unapproved origin.

### Client Connects But Shows No Tools

Check that:

- The client supports remote HTTP or Streamable HTTP MCP over `POST`.
- The client sends `Accept: application/json, text/event-stream`.
- The client completed MCP initialization before listing tools.
- The server returned the negotiated protocol version successfully.
- The client does not require a `GET /mcp` SSE stream; LIME currently returns `405 Method Not Allowed` for `GET /mcp`.

### Local Bridge Cannot Connect

Check that:

- `LIME_MCP_URL` includes the full `/mcp` endpoint.
- `LIME_MCP_KEY` is set in the bridge environment.
- The bridge supports custom request headers.
- Corporate proxies or TLS inspection are not stripping the `Authorization` header.
