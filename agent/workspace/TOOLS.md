# Tool conventions

OpenClaw maps the configured `lime` server's tools to `lime__<canonical_name>`. Other MCP clients may display a different prefix; discover their catalog.

Read tools are available only when MCP is enabled and the key is valid. Actions additionally need both this client's allowlist and the operator's **Allow MCP write actions** setting in LIME. The example configuration exposes reads only. Tool availability is not authorization.

Requests use Streamable HTTP JSON POST, static bearer authentication, and a 60-second client request timeout. LIME has separate server-side deadlines. An expired client deadline does not prove a write did not commit.

The operator supplies endpoints and secrets outside this workspace. Do not inspect the host configuration to find a key. Relative dashboard/download paths use the configured dashboard origin; the MCP key does not protect ordinary dashboard/API/download routes. See the evidence skill for safe artifact handling.
