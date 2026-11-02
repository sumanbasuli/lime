import type { NextRequest } from "next/server";
import { proxyShopkeeperRequest } from "@/lib/shopkeeper-proxy";
import { getScanScoreSummaries } from "@/lib/scan-score-data";
import type { ScanScoreSummary } from "@/lib/scan-scoring";
import { runDashboardMcpTool } from "@/lib/mcp-dashboard-tools";
import { McpReadPreparationBusyError, withMcpReportRead } from "@/lib/mcp-report-read";
import { isMcpArtifactTransportRegistered, mcpArtifactDeliveryLimiter, mcpResponseInspectionLimiter, retainMcpArtifactDelivery } from "@/lib/mcp-artifact-delivery";
import { readBoundedBody } from "@/lib/bounded-json-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Covers current 1 MiB scan metadata plus a separate 1 MiB JSON-RPC ID, even
// after Go's two JSON representations and HTML escaping. Legacy data may exceed it.
const MAX_INSPECTED_RESPONSE_BYTES = 32 * 1024 * 1024;
const UNKNOWN_OUTCOME = "The operation may have completed. Check its state before retrying; for actions with request_id, reuse the original request_id.";

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
  // Shopkeeper labels the result using the exact tool name it dispatched.
  // This avoids a second JSON parser disagreeing about duplicate/cased keys.
  // An absent label can come from an older backend during an upgrade, so keep
  // the previous transformation behavior for that case.
  if (request.method !== "POST" || upstream.status !== 200 || upstream.headers.get("X-Lime-MCP-Transform") === "none") {
    return upstream;
  }

  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("Cache-Control", "no-store");
  const transportError = (status: number, message: string) => Response.json(
    { error: `${message} ${UNKNOWN_OUTCOME}` }, { status, headers },
  );
  if (!isMcpArtifactTransportRegistered()) {
    void upstream.body?.cancel().catch(() => {});
    return transportError(503, "MCP response delivery is unavailable. Restart the dashboard.");
  }
  const releaseInspection = mcpResponseInspectionLimiter.tryAcquire();
  if (!releaseInspection) {
    void upstream.body?.cancel().catch(() => {});
    headers.set("Retry-After", "1");
    return transportError(503, "MCP response inspection is busy. Wait at least 1 second.");
  }
  let handedOff = false;
  const retainBuffered = (response: Response) => {
    const retained = retainMcpArtifactDelivery(response, releaseInspection, request.signal);
    handedOff = true;
    return retained;
  };
  try {
    const body = await readBoundedBody({ body: upstream.body, signal: scoreReadSignal }, {
      maxBytes: MAX_INSPECTED_RESPONSE_BYTES, timeoutMs: 30_000,
    });
    if (body.kind !== "ok") {
      if (body.kind === "too_large") return transportError(413, "MCP response exceeds the 32 MiB inspection limit. Request a smaller page or use the dashboard.");
      return transportError(body.kind === "timed_out" || scoreReadSignal.aborted ? 504 : 502,
        "Unable to read the MCP response within its deadline.");
    }
    const text = Buffer.from(body.bytes.buffer, body.bytes.byteOffset, body.bytes.byteLength).toString("utf8").replace(/^\uFEFF/, "");
    let response;
    try {
      response = JSON.parse(text,
        (key, value, context?: { source?: string }) => {
          // JSON-RPC IDs may exceed Number's safe integer range. Node 23+ can
          // retain their original JSON token while we enrich the tool result.
          if (key === "id" && typeof value === "number" && context?.source) {
            return (JSON as typeof JSON & { rawJSON(source: string): unknown }).rawJSON(context.source);
          }
          return value;
        },
      );
    } catch { /* Preserve invalid/unrecognized legacy responses byte-for-byte. */ }
    const result = response?.result;
    const marker = result?.structuredContent;
    if (result?.isError === true && marker?.requires_dashboard === true && typeof marker.operation === "string" && marker.arguments && typeof marker.arguments === "object" && !Array.isArray(marker.arguments)) {
      const isArtifact = ["get_report", "get_screenshot", "get_link_check_export"].includes(marker.operation);
      const release = isArtifact ? mcpArtifactDeliveryLimiter.tryAcquire() : undefined;
      if (isArtifact && !release) {
        response.result = {
          isError: true,
          content: [{ type: "text", text: "MCP artifact capacity is busy. Retry this tool after 1 second." }],
          structuredContent: { operation: marker.operation, http_status: 503, retry_after_seconds: 1 },
        };
        headers.set("Retry-After", "1");
        return retainBuffered(Response.json(response, { headers }));
      }
      // Transfer the memory bound to the artifact lease before its separate work.
      if (release) releaseInspection();
      let artifactHandedOff = false;
      try {
        request.signal.throwIfAborted();
        response.result = await runDashboardMcpTool(request, marker.operation, marker.arguments);
        request.signal.throwIfAborted();
        const serialized = Response.json(response, { headers });
        if (!release) return retainBuffered(serialized);
        const delivery = retainMcpArtifactDelivery(serialized, release, request.signal);
        artifactHandedOff = true;
        return delivery;
      } finally {
        if (!artifactHandedOff) release?.();
      }
    }
    const scan = result?.structuredContent?.scan;
    if (!scan?.id || result.isError || !("score_summary" in result.structuredContent)) {
      return retainBuffered(new Response(body.bytes, {
        status: upstream.status, statusText: upstream.statusText, headers,
      }));
    }

    try {
      // Reuse the dashboard's scorer and cache freshness rules. MCP clients must
      // not need to visit a dashboard page to compute a new scan's score.
      const summaries = await boundedScoreRead(
        withMcpReportRead(scoreReadSignal, (context) =>
          getScanScoreSummaries([{ id: scan.id, status: scan.status }], context),
          { scoreCacheScanId: scan.id }),
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
    } catch (error) {
      response.result = {
        isError: true,
        content: [{
          type: "text", text: error instanceof McpReadPreparationBusyError
            ? "MCP database read capacity is busy. Retry get_scan after 1 second."
            : "Unable to read the scan score. Retry get_scan."
        }],
        ...(error instanceof McpReadPreparationBusyError
          ? { structuredContent: { http_status: 503, retry_after_seconds: 1 } } : {}),
      };
    }

    return retainBuffered(Response.json(response, { headers }));
  } finally {
    if (!handedOff) releaseInspection();
  }
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
