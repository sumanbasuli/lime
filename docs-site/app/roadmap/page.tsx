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
    <SiteShell active="roadmap">
    <main className="site-container py-12 sm:py-16">
      <section className="mb-12">
        <div className="section-kicker">What comes next</div>
        <h1 className="mt-5 max-w-5xl font-heading text-[clamp(2.75rem,6vw,4.4rem)] leading-[0.98] tracking-[-0.04em]">
          V1 hardening first. MCP keeps improving.
        </h1>
        <p className="mt-5 max-w-3xl text-base leading-7 text-black/58 sm:text-lg sm:leading-8">
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
        <Card className="py-0">
          <CardContent className="p-5 sm:p-8 md:p-12">
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
