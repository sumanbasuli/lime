import { Card, CardContent } from "@/components/ui/card";
import { SiteShell } from "@/components/site-shell";
import { getDocPage } from "@/lib/docs";
import { withBasePath } from "@/lib/site";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Roadmap",
  description: "LIME v1 readiness and v2 MCP roadmap.",
};

export default function RoadmapPage() {
  const roadmap = getDocPage(["reference", "roadmap"]);

  return (
    <SiteShell>
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
      <section className="mb-8">
        <h1 className="font-heading text-[clamp(3rem,8vw,7rem)] leading-[0.86] tracking-[-0.06em]">
          V1 hardening first. MCP after release.
        </h1>
        <p className="mt-5 max-w-3xl text-lg leading-8 text-muted-foreground">
          V1 focuses on OSS readiness, predictable deployment, performance,
          caching, and large-report usability. MCP stays in the integration
          roadmap until the core release is stable.
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
