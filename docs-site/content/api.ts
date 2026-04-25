export interface ApiEndpoint {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  title: string;
  description: string;
  auth: string;
  body?: string;
  response: string;
  notes?: string[];
}

export interface ApiGroup {
  title: string;
  description: string;
  endpoints: ApiEndpoint[];
}

export const apiGroups: ApiGroup[] = [
  {
    title: "Scans",
    description: "Create, inspect, pause, resume, retry, and delete scans.",
    endpoints: [
      {
        method: "GET",
        path: "/api/scans",
        title: "List scans",
        description: "Returns all scans, newest first. Supports optional tag filtering.",
        auth: "None in self-hosted v1.0.",
        response: "Array of scan records with URL, status, progress, viewport, tag, and timestamps.",
      },
      {
        method: "POST",
        path: "/api/scans",
        title: "Create scan",
        description: "Creates a sitemap or single-page scan and starts the async scanner.",
        auth: "None in self-hosted v1.0.",
        body: "{ sitemap_url, scan_type, tag?, viewport_preset? }",
        response: "Created scan record.",
        notes: ["Use scan_type `single` for one URL and `sitemap` for sitemap discovery."],
      },
      {
        method: "GET",
        path: "/api/scans/{id}",
        title: "Get scan",
        description: "Returns one scan record and current lifecycle state.",
        auth: "None in self-hosted v1.0.",
        response: "Scan record or 404.",
      },
      {
        method: "POST",
        path: "/api/scans/{id}/retry-failed",
        title: "Retry failed pages",
        description: "Requeues failed pages inside the same completed partial scan.",
        auth: "None in self-hosted v1.0.",
        response: "Same scan record plus retried URL count.",
        notes: ["This does not create a new scan ID and leaves completed pages intact."],
      },
      {
        method: "POST",
        path: "/api/scans/{id}/rescan",
        title: "Full rescan",
        description: "Creates a brand-new scan using the original target and viewport.",
        auth: "None in self-hosted v1.0.",
        response: "New scan record.",
      },
      {
        method: "POST",
        path: "/api/scans/{id}/pause",
        title: "Pause scan",
        description: "Requests a cooperative pause for an active scan.",
        auth: "None in self-hosted v1.0.",
        response: "Updated scan record.",
      },
      {
        method: "POST",
        path: "/api/scans/{id}/resume",
        title: "Resume paused scan",
        description: "Reopens a paused scan and continues pending pages.",
        auth: "None in self-hosted v1.0.",
        response: "Updated scan record.",
      },
      {
        method: "DELETE",
        path: "/api/scans/{id}",
        title: "Delete scan",
        description: "Deletes the scan, related database rows, and stored screenshots.",
        auth: "None in self-hosted v1.0.",
        response: "204 on success.",
      },
    ],
  },
  {
    title: "Issues And Reports",
    description: "Read issue groups and export PDF, CSV, and LLM-ready reports.",
    endpoints: [
      {
        method: "GET",
        path: "/api/scans/{id}/issues",
        title: "Legacy issue list",
        description: "Returns all failed issues and occurrences for a scan.",
        auth: "None in self-hosted v1.0.",
        response: "Array of issues with occurrences.",
      },
      {
        method: "GET",
        path: "/api/scans/{id}/issues/chunks",
        title: "Issue summary chunk",
        description: "Returns a bounded page of failed and needs-review issue cards.",
        auth: "None in self-hosted v1.0.",
        response: "Issue summaries and aggregate counts.",
        notes: ["Use this for large scans instead of loading every occurrence up front."],
      },
      {
        method: "GET",
        path: "/api/scans/{id}/issues/details",
        title: "Issue detail",
        description: "Returns one issue group with paginated occurrences.",
        auth: "None in self-hosted v1.0.",
        response: "Issue summary, detail metadata, and occurrence page.",
      },
      {
        method: "GET",
        path: "/api/scans/{id}/issues/report.pdf",
        title: "PDF report",
        description: "Generates a full scan or scoped issue PDF report.",
        auth: "None in self-hosted v1.0.",
        response: "PDF file download.",
      },
      {
        method: "GET",
        path: "/api/scans/{id}/issues/report.csv",
        title: "CSV report",
        description: "Downloads a full or small CSV report.",
        auth: "None in self-hosted v1.0.",
        response: "CSV file download.",
        notes: ["Use mode `small` for all issues with sampled occurrences and mode `full` for every occurrence."],
      },
      {
        method: "GET",
        path: "/api/scans/{id}/issues/report.llm.txt",
        title: "LLM report",
        description: "Downloads a compact text report designed for LLM review.",
        auth: "None in self-hosted v1.0.",
        response: "Plain text file download.",
      },
    ],
  },
  {
    title: "Settings And Runtime",
    description: "Read health, version, and server-wide settings.",
    endpoints: [
      {
        method: "GET",
        path: "/api/health",
        title: "Health check",
        description: "Returns Shopkeeper service health.",
        auth: "None.",
        response: "{ status, service }",
      },
      {
        method: "GET",
        path: "/api/version",
        title: "Version",
        description: "Returns build version and commit metadata.",
        auth: "None.",
        response: "{ version, commit }",
      },
      {
        method: "GET",
        path: "/api/settings",
        title: "Read settings",
        description: "Returns reporting, performance, and integration settings.",
        auth: "None in self-hosted v1.0.",
        response: "Grouped server settings.",
      },
      {
        method: "PUT",
        path: "/api/settings",
        title: "Update settings",
        description: "Updates server-wide reporting, performance, and integration settings.",
        auth: "None in self-hosted v1.0.",
        body: "{ reporting?, performance?, integrations? }",
        response: "Updated grouped server settings.",
      },
    ],
  },
];
