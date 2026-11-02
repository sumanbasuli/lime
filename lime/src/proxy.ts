import { NextRequest, NextResponse } from "next/server";
import { rejectUntrustedHost } from "@/lib/allowed-hosts";
import {
  admitHTMLReport,
  releaseHTMLReport,
  REPORT_HTML_LEASE_HEADER,
  REPORT_HTML_RETRY_SECONDS,
} from "@/lib/report-html-admission";

export function proxy(request: NextRequest) {
  const rejected = rejectUntrustedHost(request);
  if (rejected) return rejected;

  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    !/^\/reports\/scans\/[^/]+\/issues\/?$/.test(request.nextUrl.pathname)
  ) {
    return NextResponse.next();
  }

  const token = admitHTMLReport();
  if (!token) {
    return new Response(
      request.method === "HEAD"
        ? null
        : '<!doctype html><html><body><main data-report-busy="true">This report is busy. Please retry shortly.</main></body></html>',
      {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
          "Retry-After": String(REPORT_HTML_RETRY_SECONDS),
        },
      }
    );
  }

  const headers = new Headers(request.headers);
  // Never accept a caller-supplied lease. Only the proxy can pass one to the
  // page, and the page releases it after the response closes.
  headers.set(REPORT_HTML_LEASE_HEADER, token);
  try {
    return NextResponse.next({ request: { headers } });
  } catch (error) {
    releaseHTMLReport(token);
    throw error;
  }
}

export const config = {
  matcher: "/:path*",
};
