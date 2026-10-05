import type { ViewportPreset } from "@/lib/viewport-presets";

// API client for the Shopkeeper backend

const API_BASE = "";

// Types matching Go backend response models

export interface Scan {
  id: string;
  sitemap_url: string;
  status:
    | "pending"
    | "profiling"
    | "scanning"
    | "processing"
    | "paused"
    | "completed"
    | "failed";
  pause_requested: boolean;
  scan_type: "sitemap" | "single";
  tag: string | null;
  viewport_preset: ViewportPreset;
  viewport_width: number;
  viewport_height: number;
  total_urls: number;
  scanned_urls: number;
  created_at: string;
  updated_at: string;
  include_link_check?: boolean;
}

export interface Issue {
  id: string;
  scan_id: string;
  violation_type: string;
  description: string;
  help_url: string | null;
  severity: "critical" | "serious" | "moderate" | "minor";
  is_false_positive: boolean;
  created_at: string;
  occurrence_count: number;
  act_rules: ACTRule[];
  suggested_fixes: string[];
}

export interface IssueOccurrence {
  id: string;
  issue_id: string;
  url_id: string;
  html_snippet: string | null;
  screenshot_path: string | null;
  element_screenshot_path: string | null;
  css_selector: string | null;
  created_at: string;
  page_url: string;
}

export interface IssueWithOccurrences {
  issue: Issue;
  occurrences: IssueOccurrence[];
}

export interface ACTAccessibilityRequirement {
  id: string;
  title: string;
  for_conformance: boolean;
  failed: string;
  passed: string;
  inapplicable: string;
}

export interface ACTRule {
  act_rule_id: string;
  title: string;
  status: "approved" | "proposed" | "deprecated";
  rule_url: string;
  accessibility_requirements: ACTAccessibilityRequirement[];
  summary: string;
  suggested_fixes: string[];
}

export interface Stats {
  total_scans: number;
  total_issues: number;
  total_pages: number;
}

export interface CreateScanOptions {
  url: string;
  scanType: "sitemap" | "single";
  viewportPreset: ViewportPreset;
  tag?: string;
  includeLinkCheck?: boolean;
}

export interface RetryFailedPagesResponse {
  scan: Scan;
  retried_url_count: number;
}

export function isTerminalScanStatus(status: Scan["status"]): boolean {
  return status === "completed" || status === "paused" || status === "failed";
}

// API functions

export async function createScan(options: CreateScanOptions): Promise<Scan> {
  const res = await fetch(`${API_BASE}/api/scans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sitemap_url: options.url,
      scan_type: options.scanType,
      viewport_preset: options.viewportPreset,
      tag: options.tag || undefined,
      include_link_check: options.includeLinkCheck ?? false,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to create scan (${res.status})`);
  }
  return res.json();
}

export async function getScans(tag?: string): Promise<Scan[]> {
  const params = tag ? `?tag=${encodeURIComponent(tag)}` : "";
  const res = await fetch(`${API_BASE}/api/scans${params}`);
  if (!res.ok) throw new Error(`Failed to fetch scans (${res.status})`);
  return res.json();
}

export async function getScan(id: string): Promise<Scan> {
  const res = await fetch(`${API_BASE}/api/scans/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch scan (${res.status})`);
  return res.json();
}

export async function rescanScan(id: string): Promise<Scan> {
  const res = await fetch(`${API_BASE}/api/scans/${id}/rescan`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to rescan (${res.status})`);
  }
  return res.json();
}

export async function retryFailedPages(
  id: string
): Promise<RetryFailedPagesResponse> {
  const res = await fetch(`${API_BASE}/api/scans/${id}/retry-failed`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to retry failed pages (${res.status})`);
  }
  return res.json();
}

export async function pauseScan(id: string): Promise<Scan> {
  const res = await fetch(`${API_BASE}/api/scans/${id}/pause`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to pause scan (${res.status})`);
  }
  return res.json();
}

export async function resumeScan(id: string): Promise<Scan> {
  const res = await fetch(`${API_BASE}/api/scans/${id}/resume`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to resume scan (${res.status})`);
  }
  return res.json();
}

export async function deleteScan(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/scans/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Failed to delete scan (${res.status})`);
  }
}

export async function getScanIssues(
  id: string
): Promise<IssueWithOccurrences[]> {
  const res = await fetch(`${API_BASE}/api/scans/${id}/issues`);
  if (!res.ok) throw new Error(`Failed to fetch scan issues (${res.status})`);
  return res.json();
}

export async function markIssueFalsePositive(
  scanId: string,
  issueId: string
): Promise<Issue> {
  const res = await fetch(
    `${API_BASE}/api/scans/${scanId}/issues/${issueId}/false-positive`,
    {
      method: "POST",
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err.error || `Failed to mark false positive (${res.status})`
    );
  }
  return res.json();
}

export async function unmarkIssueFalsePositive(
  scanId: string,
  issueId: string
): Promise<Issue> {
  const res = await fetch(
    `${API_BASE}/api/scans/${scanId}/issues/${issueId}/false-positive`,
    {
      method: "DELETE",
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err.error || `Failed to unmark false positive (${res.status})`
    );
  }
  return res.json();
}

export async function getStats(): Promise<Stats> {
  const res = await fetch(`${API_BASE}/api/stats`);
  if (!res.ok) throw new Error(`Failed to fetch stats (${res.status})`);
  return res.json();
}

export type LinkCheckStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type LinkTargetStatus = "healthy" | "redirected" | "broken" | "error" | "blocked" | "unchecked";

export interface LinkCheckSummary {
  healthy: number;
  redirected: number;
  broken: number;
  error: number;
  blocked: number;
  unchecked: number;
  timeout: number;
}

export interface LinkCheckStats {
  total_checks: number;
  active_checks: number;
  pages_checked: number;
  links_checked: number;
  broken_links: number;
  redirected_links: number;
  timeouts: number;
}

export interface LinkCheck {
  id: string;
  scan_id: string | null;
  url: string;
  check_type: "single" | "crawl" | "scan";
  status: LinkCheckStatus;
  max_pages: number;
  pages_checked: number;
  pages_failed: number;
  links_checked: number;
  total_links: number;
  truncated: boolean;
  error: string | null;
  summary: LinkCheckSummary;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface LinkSource {
  page_url: string;
  element: string;
  attribute: string;
  text: string;
}

export interface LinkTarget {
  id: string;
  target_url: string;
  status: LinkTargetStatus;
  status_code: number | null;
  final_url: string | null;
  redirect_count: number;
  link_type: "internal" | "external" | "document" | "media";
  occurrence_count: number;
  sources: LinkSource[];
  error: string | null;
  error_kind: "timeout" | "network" | "redirect_loop" | "invalid_url" | "blocked" | null;
}

export interface LinkCheckPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export function isActiveLinkCheck(status: LinkCheckStatus): boolean {
  return status === "queued" || status === "running";
}

// All new checker requests have a deadline, including polls. An aborted poll does
// not change the saved job; it can be retried after navigating back or refreshing.
async function linkCheckRequest<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal
): Promise<T> {
  const deadline = AbortSignal.timeout(20_000);
  const res = await fetch(`${API_BASE}/api/${path}`, {
    ...init,
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || `Link checker request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function createLinkCheck(options: {
  url: string;
  checkType: "single" | "crawl";
  maxPages?: number;
}): Promise<LinkCheck> {
  return linkCheckRequest("link-checks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: options.url, check_type: options.checkType, max_pages: options.maxPages }),
  });
}

export function getLinkChecks(limit = 10, offset = 0, signal?: AbortSignal): Promise<LinkCheckPage<LinkCheck>> {
  return linkCheckRequest(`link-checks?limit=${limit}&offset=${offset}`, {}, signal);
}

export function getLinkCheckStats(signal?: AbortSignal): Promise<LinkCheckStats> {
  return linkCheckRequest("link-checks/stats", {}, signal);
}

export function getLinkCheck(id: string, signal?: AbortSignal): Promise<LinkCheck> {
  return linkCheckRequest(`link-checks/${encodeURIComponent(id)}`, {}, signal);
}

export function getScanLinkCheck(scanId: string, signal?: AbortSignal): Promise<LinkCheck | null> {
  return linkCheckRequest(`scans/${encodeURIComponent(scanId)}/link-check`, {}, signal);
}

export function getLinkCheckResults(
  id: string,
  options: { status?: LinkTargetStatus; limit?: number; offset?: number } = {},
  signal?: AbortSignal
): Promise<LinkCheckPage<LinkTarget>> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 20), offset: String(options.offset ?? 0) });
  if (options.status) query.set("status", options.status);
  return linkCheckRequest(`link-checks/${encodeURIComponent(id)}/results?${query}`, {}, signal);
}

export function getLinkCheckSources(
  id: string,
  targetId: string,
  limit = 20,
  offset = 0,
  signal?: AbortSignal
): Promise<LinkCheckPage<LinkSource>> {
  return linkCheckRequest(`link-checks/${encodeURIComponent(id)}/results/${encodeURIComponent(targetId)}/sources?limit=${limit}&offset=${offset}`, {}, signal);
}

export function cancelLinkCheck(id: string): Promise<LinkCheck> {
  return linkCheckRequest(`link-checks/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function recheckLinks(id: string): Promise<LinkCheck> {
  return linkCheckRequest(`link-checks/${encodeURIComponent(id)}/recheck`, { method: "POST" });
}

export async function deleteLinkCheck(id: string): Promise<void> {
  await linkCheckRequest<unknown>(`link-checks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function downloadLinkCheckCsv(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/link-checks/${encodeURIComponent(id)}/export.csv`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `Failed to export CSV (${response.status})`);
  }
  const blobUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = `lime-link-check-${id}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
