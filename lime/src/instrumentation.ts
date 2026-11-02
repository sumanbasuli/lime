export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerMcpArtifactTransportBinding } = await import("./lib/mcp-artifact-transport");
    registerMcpArtifactTransportBinding();
  }
}
