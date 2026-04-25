import { ArrowRightIcon } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { siteConfig, withBasePath } from "@/lib/site";

export const metadata = {
  title: "Get Started",
  description: "Install and run LIME locally or deploy a release.",
};

export default function GetStartedPage() {
  return (
    <SiteShell>
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
      <section className="mb-8">
        <h1 className="font-heading text-[clamp(3rem,8vw,7rem)] leading-[0.86] tracking-[-0.06em]">
          Run LIME locally, then deploy a pinned release.
        </h1>
        <p className="mt-5 max-w-3xl text-lg leading-8 text-muted-foreground">
          Use Docker Compose for evaluation and development. Production
          operators should pin a release tag, keep PostgreSQL persistent, and
          follow the Docker or Fly.io deployment guide.
        </p>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="bg-[#FFED00] text-black">
          <CardHeader>
            <CardTitle className="text-4xl">Local Docker</CardTitle>
            <CardDescription className="text-black/70">
              Starts PostgreSQL, Shopkeeper, and the dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-2xl border border-black/10 bg-white/70 p-4 text-sm leading-7">
{`git clone https://github.com/sumanbasuli/lime.git
cd lime
cp .env.example .env
make start-all`}
            </pre>
            <Button className="mt-5" asChild>
              <a href={withBasePath("/docs/user/first-scan/")}>
                Create first scan <ArrowRightIcon className="size-4" />
              </a>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Production paths</CardTitle>
            <CardDescription>
              LIME publishes GHCR images and release bundles from main.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Button variant="outline" className="justify-start" asChild>
              <a href={withBasePath("/docs/reference/deployment/docker/")}>Docker guide</a>
            </Button>
            <Button variant="outline" className="justify-start" asChild>
              <a href={withBasePath("/docs/reference/deployment/fly/")}>Fly.io guide</a>
            </Button>
            <Button variant="outline" className="justify-start" asChild>
              <a href={siteConfig.releasesUrl}>GitHub releases</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
    </SiteShell>
  );
}
