import { ServerResponse } from "node:http";
import { MCP_ARTIFACT_LEASE_HEADER, mcpArtifactTransportLeases } from "./mcp-artifact-delivery";

const globalForTransportBinding = globalThis as typeof globalThis & {
  __limeMcpArtifactTransportBinding?: () => void;
};

export function registerMcpArtifactTransportBinding(): () => void {
  if (globalForTransportBinding.__limeMcpArtifactTransportBinding) {
    return globalForTransportBinding.__limeMcpArtifactTransportBinding;
  }
  const writeHead = ServerResponse.prototype.writeHead;
  const boundWriteHead: typeof writeHead = function (this: ServerResponse, ...args: unknown[]) {
    let token = this.getHeader(MCP_ARTIFACT_LEASE_HEADER);
    const headerIndex = typeof args[1] === "string" ? 2 : 1;
    const supplied = args[headerIndex];
    if (Array.isArray(supplied)) {
      const clean = [];
      for (let index = 0; index < supplied.length; index += 2) {
        if (String(supplied[index]).toLowerCase() === MCP_ARTIFACT_LEASE_HEADER) token = supplied[index + 1];
        else clean.push(supplied[index], supplied[index + 1]);
      }
      if (clean.length !== supplied.length) args[headerIndex] = clean;
    } else if (supplied && typeof supplied === "object") {
      const clean: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(supplied)) {
        if (name.toLowerCase() === MCP_ARTIFACT_LEASE_HEADER) token = value;
        else clean[name] = value;
      }
      if (Object.keys(clean).length !== Object.keys(supplied).length) args[headerIndex] = clean;
    }
    if (token === undefined) return Reflect.apply(writeHead, this, args);
    this.removeHeader(MCP_ARTIFACT_LEASE_HEADER);
    const value = Array.isArray(token) && token.length === 1 ? token[0] : token;
    const lease = typeof value === "string" ? mcpArtifactTransportLeases.get(value) : undefined;
    const socket = this.req.socket;
    if (lease) lease.bind(this, socket);
    else {
      socket.destroy();
      this.destroy();
    }
    if (this.destroyed) return this;
    return Reflect.apply(writeHead, this, args);
  };
  // Prototype binding also covers responses created while Next was preparing.
  ServerResponse.prototype.writeHead = boundWriteHead;
  const unregister = () => {
    if (ServerResponse.prototype.writeHead === boundWriteHead) ServerResponse.prototype.writeHead = writeHead;
    if (globalForTransportBinding.__limeMcpArtifactTransportBinding === unregister) {
      delete globalForTransportBinding.__limeMcpArtifactTransportBinding;
    }
  };
  globalForTransportBinding.__limeMcpArtifactTransportBinding = unregister;
  return unregister;
}
