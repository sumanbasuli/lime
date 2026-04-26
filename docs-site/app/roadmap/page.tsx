import { Card, CardContent } from "@/components/ui/card";
import { SiteShell } from "@/components/site-shell";
import { getDocPage } from "@/lib/docs";
import { withBasePath } from "@/lib/site";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Roadmap",
  description: "LIME v1 readiness, MCP hardening, and future integration roadmap.",
};

export default function RoadmapPage() {
  const roadmap = getDocPage(["reference", "roadmap"]);

  return (
    <SiteShell>
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
      <section className="mb-8">
        <h1 className="font-heading text-[clamp(2.5rem,6vw,4.75rem)] leading-[0.95] tracking-[-0.045em]">
          V1 hardening first. MCP keeps improving.
        </h1>
        <p className="mt-5 max-w-3xl text-lg leading-8 text-muted-foreground">
          V1 focuses on open-source release readiness, predictable deployment,
          performance, caching, and large-report usability. The existing MCP
          endpoint stays read-only while compatibility, origin controls, and
          diagnostics improve after release.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild>
            <a href={withBasePath("/docs/developer/performance/")}>Performance docs</a>
          </Button>
          <Button variant="outline" asChild>
            <a href={withBasePath("/docs/reference/mcp/")}>MCP reference</a>
          </Button>
        </div>
      </section>
      {roadmap ? (
        <Card>
          <CardContent className="p-6 md:p-10">
            <div
              className="docs-prose"
              dangerouslySetInnerHTML={{ __html: roadmap.html }}
            />
          </CardContent>
        </Card>
      ) : null}
    </main>
    </SiteShell>
  );
}
