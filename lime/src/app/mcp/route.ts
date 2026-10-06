import type { NextRequest } from "next/server";
import { proxyShopkeeperRequest } from "@/lib/shopkeeper-proxy";
import { getScanScoreSummaries } from "@/lib/scan-score-data";
import type { ScanScoreSummary } from "@/lib/scan-scoring";
import { runDashboardMcpTool } from "@/lib/mcp-dashboard-tools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function mcpScoreSummary(summary: ScanScoreSummary) {
  return {
    score: summary.score,
    has_score: summary.hasScore,
    has_audit_data: summary.hasAuditData,
    completed_url_count: summary.completedUrlCount,
    failed_url_count: summary.failedUrlCount,
    total_url_count: summary.totalUrlCount,
    has_full_coverage: summary.hasFullCoverage,
    is_partial_scan: summary.isPartialScan,
    passed_count: summary.passedCount,
    failed_count: summary.failedCount,
    not_applicable_count: summary.notApplicableCount,
    needs_review_count: summary.needsReviewCount,
    excluded_count: summary.excludedCount,
    weighted_passed: summary.weightedPassed,
    weighted_failed: summary.weightedFailed,
    weighted_total: summary.weightedTotal,
    scored_audit_count: summary.scoredAuditCount,
    updated_at: new Date().toISOString(),
  };
}

async function boundedScoreRead<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  try {
    const value = await new Promise<T>((resolve, reject) => {
      abort = () => reject(new Error("MCP score read timed out or caller disconnected"));
      signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject);
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function handleMcp(request: NextRequest): Promise<Response> {
  const scoreReadSignal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
  const upstream = await proxyShopkeeperRequest(request, {
    bodyLimit: 1024 * 1024,
    timeoutMs: 30_000,
  });
  // Only inspect an authenticated, successful tool response. Credentials,
  // Origin and protocol validation remain owned by Shopkeeper, including errors.
  if (request.method !== "POST" || upstream.status !== 200) return upstream;

  const response = await upstream.clone().text().then((text) => JSON.parse(
    text,
    (key, value, context?: { source?: string }) => {
      // JSON-RPC IDs may exceed Number's safe integer range. Node 23+ can
      // retain their original JSON token while we enrich the tool result.
      if (key === "id" && typeof value === "number" && context?.source) {
        return (JSON as typeof JSON & { rawJSON(source: string): unknown }).rawJSON(context.source);
      }
      return value;
    },
  )).catch(() => null);
  const result = response?.result;
  const marker = result?.structuredContent;
  if (result?.isError === true && marker?.requires_dashboard === true && typeof marker.operation === "string" && marker.arguments && typeof marker.arguments === "object" && !Array.isArray(marker.arguments)) {
    response.result = await runDashboardMcpTool(request, marker.operation, marker.arguments);
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("Cache-Control", "no-store");
    return Response.json(response, { headers });
  }
  const scan = result?.structuredContent?.scan;
  if (!scan?.id || result.isError || !("score_summary" in result.structuredContent)) {
    return upstream;
  }

  try {
    // Reuse the dashboard's scorer and cache freshness rules. MCP clients must
    // not need to visit a dashboard page to compute a new scan's score.
    const summaries = await boundedScoreRead(
      getScanScoreSummaries([{ id: scan.id, status: scan.status }]),
      scoreReadSignal,
    );
    const summary = summaries[scan.id];
    if (!summary) throw new Error("Scan no longer exists");
    const data = { ...result.structuredContent, score_summary: mcpScoreSummary(summary) };
    response.result = {
      ...result,
      structuredContent: data,
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  } catch {
    response.result = {
      isError: true,
      content: [{ type: "text", text: "Unable to read the scan score. Retry get_scan." }],
    };
  }

  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("Cache-Control", "no-store");
  return Response.json(response, { headers });
}

export {
  handleMcp as DELETE,
  handleMcp as GET,
  handleMcp as HEAD,
  handleMcp as OPTIONS,
  handleMcp as PATCH,
  handleMcp as POST,
  handleMcp as PUT,
};
