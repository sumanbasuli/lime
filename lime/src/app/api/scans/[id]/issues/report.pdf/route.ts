import { NextRequest } from "next/server";
import { getSystemSettings } from "@/lib/report-settings";
import { measureServerAction } from "@/lib/performance-logging";
import {
  ReportGenerationQueueFullError,
  reportGenerationLimiter,
} from "@/lib/report-generation-limiter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_PDF_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_PDF_HEADER_WAIT_MS = 10 * 60 * 1000;
const MAX_PDF_TRANSFER_MS = 10 * 60 * 1000;

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

function leaseResponseBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  release: () => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let completed = false;
  let bytesRead = 0;
  let responseController: ReadableStreamDefaultController<Uint8Array>;

  const finish = () => {
    if (completed) {
      return false;
    }
    completed = true;
    signal.removeEventListener("abort", onAbort);
    release();
    return true;
  };
  const onAbort = () => {
    if (!finish()) {
      return;
    }
    void reader.cancel(signal.reason).catch(() => {});
    responseController.error(
      new DOMException("PDF report request was cancelled", "AbortError")
    );
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        responseController = controller;
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      },
      async pull(controller) {
        if (completed) {
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (completed) {
            return;
          }
          if (done) {
            finish();
            controller.close();
            return;
          }
          if (value.byteLength > MAX_PDF_RESPONSE_BYTES - bytesRead) {
            finish();
            void reader
              .cancel("PDF report exceeded the response size limit")
              .catch(() => {});
            controller.error(
              new Error("PDF report exceeded the response size limit")
            );
            return;
          }
          bytesRead += value.byteLength;
          controller.enqueue(value);
        } catch (error) {
          if (finish()) {
            controller.error(error);
          }
        }
      },
      cancel(reason) {
        if (!finish()) {
          return;
        }
        return reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 }
  );
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
  let release: (() => void) | undefined;
  let headerDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    release = await reportGenerationLimiter.acquire(
      settings.performance.reportGenerationConcurrency,
      request.signal
    );
    const headerTimeout = new AbortController();
    headerDeadline = setTimeout(
      () => headerTimeout.abort(new DOMException("PDF upstream timed out", "TimeoutError")),
      MAX_PDF_HEADER_WAIT_MS
    );
    const upstreamSignal = AbortSignal.any([
      request.signal,
      headerTimeout.signal,
    ]);
    upstream = await measureServerAction(
      `pdf report proxy ${id}`,
      () =>
        fetch(targetUrl, {
          method: "GET",
          headers,
          cache: "no-store",
          redirect: "manual",
          signal: upstreamSignal,
        }),
      1000
    );
    if (upstreamSignal.aborted) {
      void upstream.body?.cancel(upstreamSignal.reason).catch(() => {});
      throw upstreamSignal.reason;
    }
  } catch (error) {
    release?.();
    if (error instanceof ReportGenerationQueueFullError) {
      return Response.json(
        { error: "PDF report generation is busy. Please retry shortly." },
        { status: 503, headers: { "Retry-After": "30" } }
      );
    }
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    return Response.json(
      { error: "PDF report service is unavailable. Please retry shortly." },
      { status: 502 }
    );
  } finally {
    if (headerDeadline !== undefined) {
      clearTimeout(headerDeadline);
    }
  }

  const responseHeaders = new Headers(upstream.headers);
  for (const header of hopByHopHeaders) {
    responseHeaders.delete(header);
  }

  if (request.signal.aborted) {
    void upstream.body?.cancel(request.signal.reason).catch(() => {});
    release();
    return new Response(null, { status: 499 });
  }

  const contentLength = responseHeaders.get("content-length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_PDF_RESPONSE_BYTES
  ) {
    void upstream.body
      ?.cancel("PDF report exceeded the response size limit")
      .catch(() => {});
    release();
    return Response.json(
      { error: "PDF report exceeded the response size limit." },
      { status: 502 }
    );
  }

  if (!upstream.body) {
    release();
  }
  const body =
    upstream.body &&
    leaseResponseBody(
      upstream.body,
      AbortSignal.any([request.signal, AbortSignal.timeout(MAX_PDF_TRANSFER_MS)]),
      release
    );
  try {
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    void body?.cancel(error).catch(() => {});
    release();
    throw error;
  }
}
