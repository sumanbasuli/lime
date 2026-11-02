import "server-only";

import { randomUUID } from "node:crypto";

export const REPORT_HTML_LEASE_HEADER = "x-lime-internal-report-lease";
export const REPORT_HTML_RETRY_SECONDS = 1;

// A direct HTML report can load every affected page for every issue group.
// Keep this separate from PDF admission: a PDF worker navigates this page.
// The configured PDF concurrency can be as high as ten, and every PDF worker
// must pass through this gate while its HTML page renders. A fixed cap avoids
// a database read before admission and preserves configured PDF capacity.
const MAX_HTML_REPORTS = 10;
const UNCLAIMED_HTML_REPORT_LEASE_MS = 5 * 1000;
const MAX_HTML_REPORT_LEASE_MS = 10 * 60 * 1000;

type Lease = {
  release: () => void;
  claim: () => () => void;
};

type AdmissionState = {
  leases: Map<string, Lease>;
};

const globalForReportAdmission = globalThis as typeof globalThis & {
  __limeHTMLReportAdmission?: AdmissionState;
};

const state =
  globalForReportAdmission.__limeHTMLReportAdmission ??
  { leases: new Map<string, Lease>() };

globalForReportAdmission.__limeHTMLReportAdmission = state;

export function admitHTMLReport(): string | null {
  if (state.leases.size >= MAX_HTML_REPORTS) {
    return null;
  }

  const token = randomUUID();
  let released = false;
  let claimed = false;
  let timer: ReturnType<typeof setTimeout>;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    clearTimeout(timer);
    state.leases.delete(token);
  };
  const schedule = (milliseconds: number) => {
    const next = setTimeout(release, milliseconds);
    next.unref?.();
    return next;
  };
  // A request that never reaches the page gets a short cleanup window. Once
  // claimed, the page's after() callback owns release; the longer watchdog
  // covers a broken response-close callback without permanent starvation.
  timer = schedule(UNCLAIMED_HTML_REPORT_LEASE_MS);
  const claim = () => {
    if (!claimed) {
      claimed = true;
      clearTimeout(timer);
      timer = schedule(MAX_HTML_REPORT_LEASE_MS);
    }
    return release;
  };
  state.leases.set(token, { release, claim });
  return token;
}

export function claimHTMLReport(token: string | null): (() => void) | null {
  if (!token) {
    return null;
  }
  return state.leases.get(token)?.claim() ?? null;
}

export function releaseHTMLReport(token: string): void {
  state.leases.get(token)?.release();
}
