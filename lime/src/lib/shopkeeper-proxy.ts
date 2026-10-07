import { NextRequest } from "next/server";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function getShopkeeperUrl(): URL {
  const value = process.env.SHOPKEEPER_URL?.trim();
  if (!value) {
    throw new Error("SHOPKEEPER_URL is not configured");
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url;
  } catch {
    throw new Error("SHOPKEEPER_URL must be a valid HTTP(S) URL");
  }
}

export async function proxyShopkeeperRequest(
  request: NextRequest,
  options: { bodyLimit?: number; timeoutMs?: number; omitBrowserOrigin?: boolean } = {}
): Promise<Response> {
  let targetUrl: URL;

  try {
    targetUrl = new URL(request.nextUrl.pathname, getShopkeeperUrl());
    targetUrl.search = request.nextUrl.search;
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "SHOPKEEPER_URL is not configured",
      },
      { status: 500 }
    );
  }

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  // Only ordinary API routes opt in after checking the browser's Origin.
  // MCP keeps forwarding Origin to its separate bearer/Origin boundary.
  if (options.omitBrowserOrigin) {
    headers.delete("origin");
    headers.delete("sec-fetch-site");
  }

  const deadline = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  const signal = deadline ? AbortSignal.any([request.signal, deadline]) : request.signal;
  const timeoutResponse = () => Response.json(
    { error: "Shopkeeper request timed out" }, { status: 504 }
  );
  const init: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
    redirect: "manual",
    signal,
  };

  try {
    signal.throwIfAborted();
    if (request.method !== "GET" && request.method !== "HEAD") {
      if (options.bodyLimit && request.body) {
        const reader = request.body.getReader();
        // Fetch's AbortSignal cannot cancel an incoming request body. Apply the
        // same deadline while buffering, before any upstream request is made.
        const cancelReader = () => { void reader.cancel().catch(() => {}); };
        signal.addEventListener("abort", cancelReader, { once: true });
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          signal.throwIfAborted();
          while (true) {
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            size += value.byteLength;
            if (size > options.bodyLimit) {
              cancelReader();
              return Response.json({ error: "Request body too large" }, { status: 413 });
            }
            chunks.push(value);
          }
        } finally {
          signal.removeEventListener("abort", cancelReader);
          reader.releaseLock();
        }
        init.body = Buffer.concat(chunks);
      } else {
        init.body = await request.arrayBuffer();
      }
    }
  } catch {
    if (deadline?.aborted) return timeoutResponse();
    return Response.json({ error: "Unable to read request body" }, { status: 400 });
  }

  let upstream: Response;

  try {
    signal.throwIfAborted();
    upstream = await fetch(targetUrl, init);
  } catch {
    if (deadline?.aborted) return timeoutResponse();
    return Response.json(
      {
        error: "Unable to reach Shopkeeper. Retry the request.",
      },
      { status: 502 }
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const header of hopByHopHeaders) {
    responseHeaders.delete(header);
  }
  // Node fetch has already decompressed gzip/br/deflate response bodies. Forward
  // their decoded bytes, not the upstream compression/framing metadata.
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
