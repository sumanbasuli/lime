import { MaterialSymbol } from "@/components/material-symbol";
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
    <main className="site-container py-12 sm:py-16">
      <section className="mb-12">
        <div className="section-kicker">Get started</div>
        <h1 className="mt-5 max-w-5xl font-heading text-[clamp(2.75rem,6vw,4.4rem)] leading-[0.98] tracking-[-0.04em]">
          Run LIME locally, then deploy a pinned release.
        </h1>
        <p className="mt-5 max-w-3xl text-base leading-7 text-black/58 sm:text-lg sm:leading-8">
          Use Docker Compose for evaluation and development. Production
          operators should pin a release tag, keep PostgreSQL persistent, and
          follow the Docker, Debian, or Fly.io deployment guide.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="min-w-0 border-black bg-[#FFED00] text-black">
          <CardHeader>
            <CardTitle className="text-3xl sm:text-4xl">Local Docker</CardTitle>
            <CardDescription className="text-black/70">
              Starts PostgreSQL, Shopkeeper, and the dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm leading-6 text-black/70">
              Install Git, Make, and Docker with Compose first. These commands
              start the application, not the documentation website.
            </p>
            <pre className="overflow-x-auto rounded-2xl border border-black/10 bg-white/70 p-4 text-xs leading-6 sm:text-sm sm:leading-7">
{`git clone https://github.com/sumanbasuli/lime.git
cd lime
cp .env.example .env
make start-all`}
            </pre>
            <p className="mt-4 text-sm leading-6 text-black/70">
              Open the dashboard at <code>http://localhost:3000</code> once
              the services are ready. The backend defaults to port 8080;
              change <code>LIME_API_PORT</code> in <code>.env</code> if needed.
              See the <a href={withBasePath("/docs/reference/setup/")} className="font-semibold underline">setup guide</a> for
              readiness checks and hot reload.
            </p>
            <Button className="mt-5 w-full justify-center sm:w-auto" asChild>
              <a href={withBasePath("/docs/user/first-scan/")}>
                Create first scan <MaterialSymbol name="arrow_forward" size={18} />
              </a>
            </Button>
            <p className="mt-4 text-sm leading-6 text-black/70">
              In source versions with link checking, select <strong>Include link check</strong> when
              creating a scan, or use <strong>Link checker</strong> for a separate page or crawl.
              Read the <a href={withBasePath("/docs/user/link-checker/")} className="font-semibold underline">link checker guide</a> for
              scope, saved results, and limits. Unreleased source features may not exist in a published image yet.
            </p>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Production paths</CardTitle>
            <CardDescription>
              Read your deployment guide before running an install or update.
              Keep backups of both PostgreSQL and screenshots.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Button variant="outline" className="justify-start text-left" asChild>
              <a href={withBasePath("/docs/reference/deployment/docker/")}>Docker guide</a>
            </Button>
            <Button variant="outline" className="justify-start text-left" asChild>
              <a href={withBasePath("/docs/reference/deployment/debian/")}>Debian guide</a>
            </Button>
            <Button variant="outline" className="justify-start text-left" asChild>
              <a href={withBasePath("/docs/reference/deployment/fly/")}>Fly.io guide</a>
            </Button>
            <Button variant="outline" className="justify-start text-left" asChild>
              <a href={withBasePath("/docs/reference/deployment/backup-restore/")}>Backup and restore</a>
            </Button>
            <Button variant="outline" className="justify-start text-left" asChild>
              <a href={siteConfig.releasesUrl}>GitHub releases</a>
            </Button>
          </CardContent>
        </Card>
      </div>
      <section className="mt-10 max-w-3xl rounded-xl border border-black/10 bg-white p-5">
        <h2 className="text-2xl">Preview the website and docs locally</h2>
        <p className="mt-3 text-sm leading-7 text-black/65">
          From the repository root, run <code>npm --prefix docs-site ci</code>,
          then <code>make docs-run</code>. Open <code>http://localhost:3001/</code>
          for the full website or <code>http://localhost:3001/docs/</code> for
          the guides. Use <code>make docs-dev</code> instead for hot reload.
          This static site does not run scans or expose MCP.
        </p>
        <a href={withBasePath("/docs/reference/docs-site/")} className="mt-3 inline-block text-sm font-semibold underline">Docs preview and publishing guide</a>
      </section>
    </main>
    </SiteShell>
  );
}
