// Download names identify the site, never the target's path or query. Invalid
// and hostless targets can exist in older saved scans, so use a fixed fallback.
export function sanitizeReportHost(rawUrl: string): string {
  let host: string;
  try {
    host = new URL(rawUrl).host;
  } catch {
    return "scan";
  }

  return host
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/[^a-z0-9-]/g, "") || "scan";
}
