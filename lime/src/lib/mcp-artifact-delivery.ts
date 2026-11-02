import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";

const MCP_ARTIFACT_RESPONSES = 2;
const DELIVERY_TIMEOUT_MS = 30_000;
const DELIVERY_CHUNK_BYTES = 64 * 1024;
export const MCP_ARTIFACT_LEASE_HEADER = "x-lime-mcp-artifact-lease";

type ArtifactTransportLease = { bind: (response: ServerResponse, socket: Socket) => void };

export class McpArtifactDeliveryLimiter {
  private active = 0;

  tryAcquire(): (() => void) | undefined {
    if (this.active >= MCP_ARTIFACT_RESPONSES) return;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

const globalForArtifactDelivery = globalThis as typeof globalThis & {
  __limeMcpArtifactDeliveryLimiter?: McpArtifactDeliveryLimiter;
  __limeMcpResponseInspectionLimiter?: McpArtifactDeliveryLimiter;
  __limeMcpArtifactTransportLeases?: Map<string, ArtifactTransportLease>;
  __limeMcpArtifactTransportBinding?: () => void;
};

export const mcpArtifactDeliveryLimiter =
  globalForArtifactDelivery.__limeMcpArtifactDeliveryLimiter ?? new McpArtifactDeliveryLimiter();
globalForArtifactDelivery.__limeMcpArtifactDeliveryLimiter = mcpArtifactDeliveryLimiter;
// Inspecting legacy/transformed JSON is a separate bounded stage from artifact generation.
export const mcpResponseInspectionLimiter =
  globalForArtifactDelivery.__limeMcpResponseInspectionLimiter ?? new McpArtifactDeliveryLimiter();
globalForArtifactDelivery.__limeMcpResponseInspectionLimiter = mcpResponseInspectionLimiter;
export const mcpArtifactTransportLeases =
  globalForArtifactDelivery.__limeMcpArtifactTransportLeases ?? new Map<string, ArtifactTransportLease>();
globalForArtifactDelivery.__limeMcpArtifactTransportLeases = mcpArtifactTransportLeases;

export function isMcpArtifactTransportRegistered(): boolean {
  return !!globalForArtifactDelivery.__limeMcpArtifactTransportBinding;
}

export function retainMcpArtifactDelivery(
  response: Response,
  release: () => void,
  signal: AbortSignal,
): Response {
  const reader = response.body?.getReader();
  if (!reader) {
    release();
    return response;
  }

  const token = crypto.randomUUID();
  let streamDone = false;
  let released = false;
  let chunk: Uint8Array | undefined;
  let offset = 0;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let transport: { response: ServerResponse; socket: Socket; cleanup: () => void } | undefined;
  const releasePermit = () => {
    if (released) return;
    released = true;
    mcpArtifactTransportLeases.delete(token);
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    transport?.cleanup();
    transport = undefined;
    release();
  };
  const finishStream = (cancel = false) => {
    if (streamDone) return;
    streamDone = true;
    chunk = undefined;
    if (cancel) void reader.cancel().catch(() => {});
    reader.releaseLock();
  };
  const destroyTransport = () => {
    const current = transport;
    if (!current) return releasePermit();
    // Queued HTTP/1 responses may not have response.socket yet.
    current.socket.destroy();
    current.response.destroy();
  };
  const abort = () => {
    if (released) return;
    if (!streamDone) {
      finishStream(true);
      controller.error(new Error("MCP response delivery timed out or caller disconnected. Check saved state before retrying; reuse the original request_id where required."));
    }
    destroyTransport();
  };

  try {
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      async pull(value) {
        try {
          if (!chunk) {
            const next = await reader.read();
            if (streamDone) return;
            if (next.done) {
              finishStream();
              if (!transport) releasePermit();
              value.close();
              return;
            }
            chunk = next.value;
            offset = 0;
          }
          const end = Math.min(offset + DELIVERY_CHUNK_BYTES, chunk.byteLength);
          // Copy so a blocked socket cannot retain the entire serialized artifact.
          value.enqueue(new Uint8Array(chunk.subarray(offset, end)));
          offset = end;
          if (offset === chunk.byteLength) chunk = undefined;
        } catch {
          if (streamDone) return;
          finishStream(true);
          value.error(new Error("Unable to deliver MCP response. Check saved state before retrying; reuse the original request_id where required."));
          destroyTransport();
        }
      },
      cancel() { finishStream(true); destroyTransport(); },
    }, { highWaterMark: 0 });
    mcpArtifactTransportLeases.set(token, {
      bind(response, socket) {
        if (released || transport) {
          socket.destroy();
          response.destroy();
          return;
        }
        const onFinish = () => {
          if (!streamDone) {
            finishStream(true);
            controller.error(new Error("MCP response ended before delivery completed. Check saved state before retrying; reuse the original request_id where required."));
          }
          releasePermit();
        };
        const onClose = () => {
          if (response.writableFinished) releasePermit();
          else abort();
        };
        const onSocketClose = () => {
          if (!streamDone) {
            finishStream(true);
            controller.error(new Error("MCP response caller disconnected. Check saved state before retrying; reuse the original request_id where required."));
          }
          releasePermit();
        };
        transport = { response, socket, cleanup() {
          response.off("finish", onFinish);
          response.off("close", onClose);
          socket.off("close", onSocketClose);
        } };
        response.once("finish", onFinish);
        response.once("close", onClose);
        socket.once("close", onSocketClose);
        if (socket.closed) onSocketClose();
        else if (response.writableFinished) releasePermit();
      },
    });
    timer = setTimeout(abort, DELIVERY_TIMEOUT_MS);
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const headers = new Headers(response.headers);
    headers.set(MCP_ARTIFACT_LEASE_HEADER, token);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    finishStream(true);
    destroyTransport();
    throw error;
  }
}
