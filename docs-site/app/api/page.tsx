import { ApiCodePanel } from "@/components/api-code-panel";
import { MaterialSymbol } from "@/components/material-symbol";
import { SiteShell } from "@/components/site-shell";
import { apiGroups, type ApiEndpoint } from "@/content/api";
import { withBasePath } from "@/lib/site";

export const metadata = {
  title: "API Reference",
  description: "Endpoints, request examples, and responses for integrating with the LIME HTTP API.",
};

const methodTone: Record<string, string> = {
  GET: "border-[#1E7A4E]/20 bg-[#e4f4ea] text-[#1E7A4E]",
  POST: "border-[#2554a3]/20 bg-[#eaf0ff] text-[#2554a3]",
  PUT: "border-[#746000]/20 bg-[#fff7cd] text-[#746000]",
  DELETE: "border-[#8F2D31]/20 bg-[#fae9e9] text-[#8F2D31]",
};

const methodDetails = {
  GET: { icon: "download", action: "Read saved evidence", description: "Scans, link checks, issue groups, report files, and runtime details." },
  POST: { icon: "add_circle", action: "Create & manage", description: "Start scans and link checks, manage active jobs, generate keys, and connect MCP clients." },
  PUT: { icon: "tune", action: "Configure your instance", description: "Update server-wide reporting, performance, and integration settings." },
  DELETE: { icon: "delete", action: "Remove & restore", description: "Delete saved runs and evidence, or restore an excluded issue." },
} as const;

const methodOrder = ["GET", "POST", "PUT", "DELETE"] as const;

function curlForEndpoint(endpoint: ApiEndpoint) {
  const endpointPath = endpoint.path
    .replaceAll("{id}", endpoint.path.startsWith("/api/link-checks/") ? "$LINK_CHECK_ID" : "$SCAN_ID")
    .replaceAll("{scanId}", "$SCAN_ID")
    .replaceAll("{issueId}", "$ISSUE_ID")
    .replaceAll("{resultId}", "$RESULT_ID")
    .replaceAll("{filename}", "$SCREENSHOT_FILENAME");
  const query = endpoint.exampleQuery ? `?${endpoint.exampleQuery}` : "";
  const lines = [`curl -fSs -X ${endpoint.method} "http://localhost:3000${endpointPath}${query}"`];
  if (endpoint.bearerKey) {
    lines.push('  -H "Authorization: Bearer $LIME_MCP_KEY"');
    lines.push('  -H "Accept: application/json, text/event-stream"');
  }
  if (endpoint.body) {
    lines.push('  -H "Content-Type: application/json"');
    lines.push(`  --data '${endpoint.body}'`);
  }
  if (endpoint.path.endsWith(".pdf")) lines.push("  --output lime-report.pdf");
  else if (endpoint.path.endsWith(".csv")) lines.push("  --output lime-report.csv");
  else if (endpoint.path.endsWith(".llm.txt")) lines.push("  --output lime-report.llm.txt");
  else if (endpoint.path.startsWith("/api/screenshots/")) lines.push('  --output "$SCREENSHOT_FILENAME"');
  return lines.join(" \\\n");
}

// The catalog documents field names, not fabricated example response values.
function responseFields(response: string) {
  const shapes = [...response.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1].split(",").map((field) => field.trim()))
    .filter((fields) => fields.every((field) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field)));
  return shapes.map((fields, index) => [
    ...(shapes.length > 1 ? [`// Documented shape ${index + 1}`] : []),
    "{", ...fields.map((field, position) => `  ${field}${position < fields.length - 1 ? "," : ""}`), "}",
  ].join("\n")).join("\n\n");
}

function responseFormat(endpoint: ApiEndpoint) {
  if (endpoint.path.endsWith(".pdf")) return { label: "PDF download", icon: "picture_as_pdf" };
  if (endpoint.path.endsWith(".csv")) return { label: "CSV download", icon: "table_view" };
  if (endpoint.path.endsWith(".llm.txt")) return { label: "Text download", icon: "description" };
  if (endpoint.path.startsWith("/api/screenshots/")) return { label: "Image file", icon: "image" };
  if (endpoint.path === "/mcp") return { label: "JSON-RPC", icon: "hub" };
  if (/\b204\b/.test(endpoint.response)) return { label: "No content on success", icon: "task_alt" };
  return { label: "JSON response", icon: "data_object" };
}

function endpointAnchor(endpoint: ApiEndpoint) {
  return `endpoint-${endpoint.method.toLowerCase()}-${endpoint.path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

export default function ApiReferencePage() {
  const endpointsByMethod = methodOrder.map((method) => ({
    method,
    endpoints: apiGroups.flatMap((group) => group.endpoints.filter((endpoint) => endpoint.method === method)
      .map((endpoint) => ({ ...endpoint, surface: group.title }))),
  })).filter((group) => group.endpoints.length > 0);
  const endpointCount = endpointsByMethod.reduce((count, group) => count + group.endpoints.length, 0);

  return (
    <SiteShell active="api">
      <main className="site-container py-12 sm:py-16">
        <section className="grid min-w-0 gap-8 border-b border-black/10 pb-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:gap-12">
          <div className="min-w-0">
            <div className="section-kicker">Developer reference</div>
            <h1 className="mt-5 font-heading text-[clamp(2.75rem,6vw,4.4rem)] leading-[0.98] tracking-[-0.04em]">API Reference</h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-black/60 sm:text-lg sm:leading-8">
              Create scans, inspect findings, and export reports with the LIME HTTP API. Find request examples, response fields, and guidance for each endpoint below.
            </p>
            <div className="mt-6 flex flex-wrap gap-2 text-xs">
              <span className="inline-flex items-center gap-2 rounded-full border border-black/12 bg-white px-3 py-2"><MaterialSymbol name="route" size={16} />{endpointCount} endpoints</span>
              <span className="inline-flex items-center gap-2 rounded-full border border-black/12 bg-white px-3 py-2"><MaterialSymbol name="code" size={16} />HTTP + JSON</span>
              <span className="inline-flex items-center gap-2 rounded-full border border-black bg-[#FFED00] px-3 py-2"><MaterialSymbol name="hub" size={16} />Operator-controlled MCP</span>
            </div>
          </div>
          <div className="min-w-0 rounded-[22px] border border-black/12 bg-white p-4 sm:p-5">
            <div className="mb-4 flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-black/10 bg-[#FFED00]"><MaterialSymbol name="terminal" size={20} /></span>
              <div><h2 className="font-sans text-sm font-semibold">Start with a health check</h2><p className="mt-1 text-xs leading-5 text-black/55">Check that your LIME instance is reachable.</p></div>
            </div>
            <ApiCodePanel label="Quick start" code={'curl -fSs "http://localhost:3000/api/health"'} language="bash" />
            <p className="mt-3 text-xs leading-5 text-black/55">Examples use the dashboard on <code className="rounded bg-black/5 px-1 font-mono">localhost:3000</code>. Replace the host with your instance URL.</p>
          </div>
        </section>

        <aside className="my-8 flex min-w-0 items-start gap-3 rounded-2xl border border-[#c3ad00]/25 bg-[#FFED00]/12 p-4 sm:p-5" aria-label="API access and safety">
          <MaterialSymbol name="shield" size={22} className="mt-0.5 text-[#746000]" />
          <div className="min-w-0 text-sm leading-6 text-black/65">
            <p><strong className="text-black">Try write requests on a test instance.</strong> REST endpoints have no built-in user authentication, so protect remote access with your own controls. Scans contact target websites, and deletion removes saved evidence. A rescan preserves the original. MCP bearer authentication protects only the MCP endpoint.</p>
            <a href={withBasePath("/docs/reference/mcp/")} className="mt-2 inline-flex items-center gap-1.5 font-semibold text-black underline">MCP setup, initialization, and transport reference<MaterialSymbol name="arrow_forward" size={15} /></a>
          </div>
        </aside>

        <div className="grid min-w-0 gap-8 lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-10">
          <aside className="min-w-0">
            <div className="lg:sticky lg:top-28">
              <p className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-black/60">Explore the API</p>
              <nav className="grid grid-cols-2 gap-2 lg:grid-cols-1" aria-label="API methods">
                {endpointsByMethod.map((group) => (
                  <a key={group.method} href={`#${group.method.toLowerCase()}`} className="flex min-w-0 items-center gap-2 rounded-xl border border-black/10 bg-white px-3 py-3 no-underline transition-colors hover:border-black/25 hover:bg-[#FFED00]/15 focus-visible:outline-2 focus-visible:outline-offset-2">
                    <span className={`rounded-md border px-1.5 py-1 font-mono text-[10px] font-bold ${methodTone[group.method]}`}>{group.method}</span>
                    <span className="hidden text-xs font-medium lg:block">{group.method === "GET" ? "Read" : group.method === "POST" ? "Create" : group.method === "PUT" ? "Configure" : "Remove"}</span>
                    <span className="ml-auto font-mono text-[11px] text-black/60">{group.endpoints.length}</span>
                  </a>
                ))}
              </nav>
              <div className="mt-5 rounded-xl border border-black/10 bg-[#f6f5f0] p-4 text-xs leading-6 text-black/55">
                <p className="font-semibold text-black">Your request variables</p>
                <p className="mt-2">Use saved IDs for <code className="break-all font-mono text-[11px] text-black">SCAN_ID</code>, <code className="break-all font-mono text-[11px] text-black">LINK_CHECK_ID</code>, <code className="break-all font-mono text-[11px] text-black">RESULT_ID</code>, and <code className="break-all font-mono text-[11px] text-black">ISSUE_ID</code>.</p>
                <p className="mt-2">Screenshot filenames come from an occurrence. MCP uses <code className="break-all font-mono text-[11px] text-black">LIME_MCP_KEY</code>, generated in Settings.</p>
              </div>
            </div>
          </aside>

          <div className="min-w-0 space-y-12">
            {endpointsByMethod.map((group) => (
              <section key={group.method} id={group.method.toLowerCase()} className="min-w-0 scroll-mt-28">
                <div className="mb-5 flex items-start gap-3">
                  <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl border ${methodTone[group.method]}`}><MaterialSymbol name={methodDetails[group.method].icon} size={21} /></span>
                  <div><p className="font-mono text-[10px] uppercase tracking-[0.14em] text-black/60">{methodDetails[group.method].action}</p><h2 className="mt-1 font-heading text-3xl tracking-[-0.025em]">{group.method} endpoints</h2><p className="mt-2 text-sm leading-6 text-black/55">{methodDetails[group.method].description}</p></div>
                </div>
                <div className="grid min-w-0 gap-5">
                  {group.endpoints.map((endpoint) => {
                    const anchor = endpointAnchor(endpoint);
                    const fields = responseFields(endpoint.response);
                    const format = responseFormat(endpoint);
                    const statuses = [...new Set(endpoint.response.match(/\b[1-5]\d{2}\b/g) ?? [])];
                    return (
                      <article key={anchor} id={anchor} aria-labelledby={`${anchor}-title`} className="min-w-0 scroll-mt-28 overflow-hidden rounded-[20px] border border-black/12 bg-white">
                        <header className="min-w-0 border-b border-black/8 px-4 py-5 sm:px-6">
                          <div className="flex min-w-0 items-start gap-2">
                            <span className={`mt-0.5 shrink-0 rounded-md border px-2 py-1 font-mono text-[10px] font-bold ${methodTone[endpoint.method]}`}>{endpoint.method}</span>
                            <code className="min-w-0 break-all font-mono text-xs leading-6 sm:text-sm">{endpoint.path}</code>
                            <a href={`#${anchor}`} aria-label={`Link to ${endpoint.title}`} className="ml-auto shrink-0 rounded-md p-1 text-black/60 no-underline hover:bg-black/5 hover:text-black"><MaterialSymbol name="link" size={17} /></a>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-2"><span className="rounded-full bg-[#f3f2ed] px-2.5 py-1 text-[10px] font-medium text-black/55">{endpoint.surface}</span><span className="inline-flex items-center gap-1 text-[10px] text-black/60"><MaterialSymbol name="dns" size={13} />{endpoint.owner}</span></div>
                          <h3 id={`${anchor}-title`} className="mt-3 font-sans text-lg font-semibold tracking-[-0.02em] sm:text-xl">{endpoint.title}</h3>
                          <p className="mt-2 max-w-3xl text-sm leading-6 text-black/60">{endpoint.description}</p>
                        </header>

                        <div className="grid min-w-0 xl:grid-cols-2">
                          <div className="min-w-0 space-y-5 p-4 sm:p-6 xl:border-r xl:border-black/8">
                            <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-black/60"><MaterialSymbol name="north_east" size={16} />Request</div>
                            <div className="rounded-xl border border-black/8 bg-[#faf9f5] p-3.5"><div className="flex items-center gap-1.5 text-xs font-semibold"><MaterialSymbol name="key" size={15} />Authentication</div><p className="mt-2 break-words text-xs leading-6 text-black/60">{endpoint.auth}</p></div>
                            {endpoint.query ? <div><h4 className="flex items-center gap-1.5 font-sans text-xs font-semibold"><MaterialSymbol name="tune" size={15} />Query parameters</h4><p className="mt-2 break-words text-xs leading-6 text-black/60">{endpoint.query}</p></div> : null}
                            <ApiCodePanel label={`cURL · ${endpoint.title}`} code={curlForEndpoint(endpoint)} language="bash" />
                            {endpoint.body ? <ApiCodePanel label={`Request body · ${endpoint.title}`} code={endpoint.body} language="json" /> : null}
                          </div>

                          <div className="min-w-0 border-t border-black/8 bg-[#fcfbf7] p-4 sm:p-6 xl:border-t-0">
                            <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-black/60"><MaterialSymbol name="south_west" size={16} />Response contract</div>
                            <div className="mt-4 flex items-center gap-2.5"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-black/10 bg-white"><MaterialSymbol name={format.icon} size={19} /></span><span className="text-sm font-semibold">{format.label}</span></div>
                            <p className="mt-4 break-words text-sm leading-7 text-black/65">{endpoint.response}</p>
                            {statuses.length ? (
                              <div className="mt-4">
                                <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-black/60">HTTP status codes</p>
                                <div className="flex flex-wrap gap-2">
                                  {statuses.map((status) => (
                                    <span key={status} className={`rounded-md border px-2 py-1 font-mono text-[11px] ${Number(status) < 300 ? "border-[#1E7A4E]/20 bg-[#e4f4ea] text-[#1E7A4E]" : "border-[#8F2D31]/15 bg-[#fae9e9] text-[#8F2D31]"}`}>
                                      HTTP {status}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            {fields ? (
                              <div className="mt-5">
                                <ApiCodePanel label={`Response fields · ${endpoint.title}`} code={fields} language="fields" />
                                <p className="mt-2 text-[11px] leading-5 text-black/60">Field names are shown without values. See the response description and usage notes for availability and error conditions.</p>
                              </div>
                            ) : null}
                          </div>
                        </div>

                        {endpoint.notes?.length ? (
                          <details className="group border-t border-black/8 bg-white">
                            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-4 text-xs font-semibold marker:content-none focus-visible:outline-2 focus-visible:outline-offset-[-4px] sm:px-6">
                              <MaterialSymbol name="info" size={17} className="text-black/45" />
                              Usage notes
                              <span className="rounded-full bg-black/5 px-2 py-0.5 font-mono text-[10px] text-black/60">{endpoint.notes.length}</span>
                              <MaterialSymbol name="expand_more" size={18} className="ml-auto text-black/45 transition-transform group-open:rotate-180" />
                            </summary>
                            <ul className="space-y-3 px-4 pb-5 sm:px-6">
                              {endpoint.notes.map((note) => (
                                <li key={note} className="flex items-start gap-2.5 text-xs leading-6 text-black/60">
                                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-black/35" />
                                  <span className="min-w-0 break-words">{note}</span>
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>
    </SiteShell>
  );
}
