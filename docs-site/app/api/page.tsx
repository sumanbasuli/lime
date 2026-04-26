import { TerminalIcon } from "lucide-react";
import { apiGroups } from "@/content/api";
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
  GET: "bg-emerald-100 text-emerald-900 border-emerald-200",
  POST: "bg-blue-100 text-blue-900 border-blue-200",
  PUT: "bg-amber-100 text-amber-900 border-amber-200",
  DELETE: "bg-red-100 text-red-900 border-red-200",
};

const methodDescriptions: Record<string, string> = {
  GET: "Read scans, issue groups, report files, health, version, and settings.",
  POST: "Create scans or trigger scan lifecycle actions.",
  PUT: "Update server-wide settings.",
  DELETE: "Remove scan data and stored screenshots.",
};

const methodOrder = ["GET", "POST", "PUT", "DELETE"] as const;

function curlForEndpoint(path: string, method: string, body?: string) {
  const url = `http://localhost:8080${path.replace("{id}", "$SCAN_ID")}`;
  const lines = [`curl -s -X ${method} "${url}"`];
  if (body) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  --data '${body}'`);
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
    <SiteShell>
    <main className="mx-auto w-full max-w-[96rem] px-3 py-8 md:px-6">
      <section className="mb-8">
        <h1 className="font-heading text-[clamp(2rem,4vw,3.5rem)] leading-[1.02] tracking-[-0.035em]">
          API reference for scans, issues, reports, and settings.
        </h1>
        <p className="mt-5 max-w-3xl text-lg leading-8 text-muted-foreground">
          Use these examples against Shopkeeper on port <code>8080</code> or
          through the dashboard proxy where applicable. Endpoints are grouped
          by method so reads, lifecycle actions, settings updates, and deletes
          stay easy to scan.
        </p>
      </section>

      <div className="space-y-8">
        {endpointsByMethod.map((group) => (
          <section key={group.method}>
            <div className="mb-4">
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`rounded-full border px-3 py-1.5 font-mono text-sm font-bold ${
                    methodTone[group.method] ?? "bg-muted"
                  }`}
                >
                  {group.method}
                </span>
                <h2 className="font-heading text-3xl tracking-tight">
                  {group.method} endpoints
                </h2>
              </div>
              <p className="mt-2 text-muted-foreground">
                {methodDescriptions[group.method]}
              </p>
            </div>
            <div className="grid gap-4">
              {group.endpoints.map((endpoint) => (
                <Card key={`${endpoint.method}-${endpoint.path}`}>
                  <CardHeader>
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2.5 py-1 font-mono text-xs font-bold ${
                          methodTone[endpoint.method] ?? "bg-muted"
                        }`}
                      >
                        {endpoint.method}
                      </span>
                      <code className="rounded-lg bg-muted px-2 py-1 font-mono text-sm">
                        {endpoint.path}
                      </code>
                      <span className="rounded-full border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground">
                        {endpoint.surface}
                      </span>
                    </div>
                    <CardTitle>{endpoint.title}</CardTitle>
                    <CardDescription>{endpoint.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-3 text-sm md:grid-cols-2">
                      <div>
                        <div className="font-semibold">Auth</div>
                        <p className="mt-1 text-muted-foreground">{endpoint.auth}</p>
                      </div>
                      <div>
                        <div className="font-semibold">Response</div>
                        <p className="mt-1 text-muted-foreground">{endpoint.response}</p>
                      </div>
                    </div>
                    {endpoint.body ? (
                      <div>
                        <div className="font-semibold">Body</div>
                        <code className="mt-1 block rounded-lg bg-muted p-3 text-sm">
                          {endpoint.body}
                        </code>
                      </div>
                    ) : null}
                    <div className="rounded-2xl border bg-black p-4 text-[#fffbe6]">
                      <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[#fffbe6]/60">
                        <TerminalIcon className="size-4" />
                        Example
                      </div>
                      <pre className="overflow-x-auto text-sm leading-6">
                        {curlForEndpoint(endpoint.path, endpoint.method, endpoint.body)}
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
