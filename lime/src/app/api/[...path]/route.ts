import { proxyShopkeeperRequest } from "@/lib/shopkeeper-proxy";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function proxyRequest(request: NextRequest): Promise<Response> {
  return proxyShopkeeperRequest(request, { bodyLimit: 1024 * 1024 });
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
