import { NextRequest } from "next/server";
import { getSystemSettings } from "@/lib/report-settings";
import { measureServerAction } from "@/lib/performance-logging";
import { reportGenerationLimiter } from "@/lib/report-generation-limiter";

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

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const settings = await getSystemSettings();
  if (!settings.reporting.pdfReportsEnabled) {
    return Response.json(
      { error: "PDF exports are disabled in settings." },
      { status: 403 }
    );
  }

  const { id } = await context.params;

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

  const targetUrl = new URL(
    `/api/scans/${id}/issues/report.pdf`,
    shopkeeperUrl
  );
  targetUrl.search = request.nextUrl.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");

  let upstream: Response;
  try {
    upstream = await reportGenerationLimiter.run(
      settings.performance.reportGenerationConcurrency,
      () =>
        measureServerAction(
          `pdf report proxy ${id}`,
          () =>
            fetch(targetUrl, {
              method: "GET",
              headers,
              cache: "no-store",
              redirect: "manual",
            }),
          1000
        )
    );
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
