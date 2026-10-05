import { MaterialSymbol } from "@/components/material-symbol";
import { apiGroups, type ApiEndpoint } from "@/content/api";
import { SiteShell } from "@/components/site-shell";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = {
  title: "API Reference",
  description: "Typed API reference for LIME v1 endpoints.",
};

const methodTone: Record<string, string> = {
  GET: "bg-[#dff3e8] text-[#1E7A4E] border-[#1E7A4E]/25",
  POST: "bg-[#e4edff] text-[#2554a3] border-[#2554a3]/20",
  PUT: "bg-[#fff6c7] text-[#6d5e00] border-[#6d5e00]/20",
  DELETE: "bg-[#f5e1e1] text-[#8F2D31] border-[#8F2D31]/20",
};

const methodDescriptions: Record<string, string> = {
  GET: "Read scans, issue groups, report files, health, version, and settings.",
  POST: "Create scans, trigger lifecycle actions, generate MCP keys, or call read-only MCP tools.",
  PUT: "Update server-wide settings.",
  DELETE: "Remove scan data and stored screenshots, or restore an excluded issue.",
};

const methodOrder = ["GET", "POST", "PUT", "DELETE"] as const;

function curlForEndpoint(endpoint: ApiEndpoint) {
  const port = endpoint.path === "/mcp" ? 8080 : 3000;
  const endpointPath = endpoint.path
    .replaceAll("{id}", "$SCAN_ID")
    .replaceAll("{scanId}", "$SCAN_ID")
    .replaceAll("{issueId}", "$ISSUE_ID")
    .replaceAll("{filename}", "$SCREENSHOT_FILENAME");
  const query = endpoint.exampleQuery ? `?${endpoint.exampleQuery}` : "";
  const url = `http://localhost:${port}${endpointPath}${query}`;
  const lines = [`curl -fSs -X ${endpoint.method} "${url}"`];
  if (endpoint.bearerKey) {
    lines.push('  -H "Authorization: Bearer $LIME_MCP_KEY"');
  }
  if (endpoint.body) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  --data '${endpoint.body}'`);
  }
  if (endpoint.path.endsWith(".pdf")) {
    lines.push("  --output lime-report.pdf");
  } else if (endpoint.path.endsWith(".csv")) {
    lines.push("  --output lime-report.csv");
  } else if (endpoint.path.endsWith(".llm.txt")) {
    lines.push("  --output lime-report.llm.txt");
  } else if (endpoint.path.startsWith("/api/screenshots/")) {
    lines.push('  --output "$SCREENSHOT_FILENAME"');
  }
  return lines.join(" \\\n");
}

export default function ApiReferencePage() {
  const endpointsByMethod = methodOrder
    .map((method) => ({
      method,
      endpoints: apiGroups.flatMap((group) =>
        group.endpoints
          .filter((endpoint) => endpoint.method === method)
          .map((endpoint) => ({
            ...endpoint,
            surface: group.title,
          }))
      ),
    }))
    .filter((group) => group.endpoints.length > 0);

  return (
    <SiteShell active="api">
    <main className="site-container py-12 sm:py-16">
      <section className="mb-12 max-w-4xl">
        <div className="section-kicker">Developer reference</div>
        <h1 className="mt-5 font-heading text-[clamp(2.75rem,6vw,4.4rem)] leading-[0.98] tracking-[-0.04em]">
          API Reference
        </h1>
        <p className="mt-5 max-w-3xl text-base leading-7 text-black/58 sm:text-lg sm:leading-8">
          Run REST examples against the dashboard on port <code>3000</code>.
          It serves its own endpoints and proxies Shopkeeper routes. Each card
          identifies the owning service; only the MCP transport uses Shopkeeper
          directly on port <code>8080</code>.
        </p>
        <p className="mt-3 text-sm leading-6 text-black/55">
          Set <code>SCAN_ID</code> and <code>ISSUE_ID</code> to saved result IDs.
          Screenshot examples also use <code>SCREENSHOT_FILENAME</code> from an
          occurrence. MCP requests use <code>LIME_MCP_KEY</code>, returned when
          generating a key in Settings.
        </p>
      </section>

      <div className="space-y-14">
        {endpointsByMethod.map((group) => (
          <section key={group.method}>
            <div className="mb-5">
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`rounded-full border px-3 py-1.5 font-mono text-sm font-bold ${
                    methodTone[group.method] ?? "bg-muted"
                  }`}
                >
                  {group.method}
                </span>
                <h2 className="font-heading text-3xl tracking-[-0.025em]">
                  {group.method} endpoints
                </h2>
              </div>
              <p className="mt-2 text-sm text-black/55">
                {methodDescriptions[group.method]}
              </p>
            </div>
            <div className="grid gap-4">
              {group.endpoints.map((endpoint) => (
                <Card key={`${endpoint.method}-${endpoint.path}`} className="min-w-0 overflow-hidden py-0">
                  <CardHeader className="min-w-0 border-b border-black/8 px-5 py-5 sm:px-6">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2.5 py-1 font-mono text-xs font-bold ${
                          methodTone[endpoint.method] ?? "bg-muted"
                        }`}
                      >
                        {endpoint.method}
                      </span>
                      <code className="max-w-full min-w-0 overflow-x-auto whitespace-nowrap rounded-md bg-black/[0.045] px-2 py-1 font-mono text-xs sm:text-sm">
                        {endpoint.path}
                      </code>
                      <span className="max-w-full rounded-full border border-black/10 bg-white px-2.5 py-1 text-xs font-medium text-black/50">
                        {endpoint.surface}
                      </span>
                      <span className="max-w-full rounded-full border border-black/10 bg-white px-2.5 py-1 text-xs font-medium text-black/50">
                        {endpoint.owner}
                      </span>
                    </div>
                    <CardTitle className="mt-2 break-words text-xl sm:text-2xl">{endpoint.title}</CardTitle>
                    <CardDescription className="break-words">{endpoint.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="min-w-0 space-y-5 px-5 py-5 sm:px-6">
                    <div className="grid min-w-0 gap-3 text-sm md:grid-cols-2">
                      <div className="min-w-0">
                        <div className="font-semibold">Auth</div>
                        <p className="mt-1 break-words text-black/55">{endpoint.auth}</p>
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold">Response</div>
                        <p className="mt-1 break-words text-black/55">{endpoint.response}</p>
                      </div>
                    </div>
                    {endpoint.body ? (
                      <div className="min-w-0">
                        <div className="font-semibold">Body</div>
                        <code className="mt-1 block max-w-full overflow-x-auto rounded-lg bg-muted p-3 text-xs sm:text-sm">
                          {endpoint.body}
                        </code>
                      </div>
                    ) : null}
                    {endpoint.query ? (
                      <div className="min-w-0 text-sm">
                        <div className="font-semibold">Query parameters</div>
                        <p className="mt-1 break-words leading-6 text-black/55">
                          {endpoint.query}
                        </p>
                      </div>
                    ) : null}
                    <div className="min-w-0 rounded-xl border border-white/10 bg-black p-4 text-[#fffbe6]">
                      <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#fffbe6]/60">
                        <MaterialSymbol name="terminal" size={16} />
                        Example
                      </div>
                      <pre className="max-w-full overflow-x-auto whitespace-pre text-xs leading-6 sm:text-sm">
                        {curlForEndpoint(endpoint)}
                      </pre>
                    </div>
                    {endpoint.notes?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {endpoint.notes.map((note) => (
                          <span
                            key={note}
                            className="rounded-full border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground"
                          >
                            {note}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
    </SiteShell>
  );
}
