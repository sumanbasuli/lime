import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

function getShopkeeperUrl(): string {
  const value = process.env.SHOPKEEPER_URL?.trim();
  if (!value) {
    throw new Error("SHOPKEEPER_URL is not configured");
  }

  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function proxyRequest(request: NextRequest): Promise<Response> {
  let shopkeeperUrl: string;

  try {
    shopkeeperUrl = getShopkeeperUrl();
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

  const targetUrl = new URL(request.nextUrl.pathname, shopkeeperUrl);
  targetUrl.search = request.nextUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");

  const init: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  let upstream: Response;

  try {
    upstream = await fetch(targetUrl, init);
  } catch {
    return Response.json(
      {
        error: `Failed to reach Shopkeeper at ${shopkeeperUrl}`,
      },
      { status: 502 }
    );
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const header of hopByHopHeaders) {
    responseHeaders.delete(header);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export {
  proxyRequest as DELETE,
  proxyRequest as GET,
  proxyRequest as HEAD,
  proxyRequest as OPTIONS,
  proxyRequest as PATCH,
  proxyRequest as POST,
  proxyRequest as PUT,
};
