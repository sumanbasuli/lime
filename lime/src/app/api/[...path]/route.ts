import { proxyShopkeeperRequest } from "@/lib/shopkeeper-proxy";
import { rejectCrossOriginWrite } from "@/lib/ordinary-api-origin";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function proxyRequest(request: NextRequest): Promise<Response> {
  const rejected = rejectCrossOriginWrite(request);
  if (rejected) return rejected;
  return proxyShopkeeperRequest(request, {
    bodyLimit: 1024 * 1024,
    omitBrowserOrigin: !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase()),
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
