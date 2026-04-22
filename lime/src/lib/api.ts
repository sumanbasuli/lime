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
