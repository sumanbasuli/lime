import { MaterialSymbol } from "@/components/material-symbol";
import { SiteShell } from "@/components/site-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { siteConfig, withBasePath } from "@/lib/site";

export const metadata = {
  title: "Get Started",
  description: "Install LIME 2.0, run your first accessibility scan, check links, and connect your AI assistant.",
};

export default function GetStartedPage() {
  return (
    <SiteShell>
    <main className="site-container py-12 sm:py-16">
      <section className="mb-12">
        <div className="section-kicker">Get started</div>
        <h1 className="mt-5 max-w-5xl font-heading text-[clamp(2.75rem,6vw,4.4rem)] leading-[0.98] tracking-[-0.04em]">
          Get LIME 2.0 up and running.
        </h1>
        <p className="mt-5 max-w-3xl text-base leading-7 text-black/58 sm:text-lg sm:leading-8">
          Try LIME locally with Docker Compose, or host it on your own server.
          Choose a setup below, then run your first accessibility scan.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="min-w-0 border-black bg-[#FFED00] text-black">
          <CardHeader>
            <CardTitle className="text-3xl sm:text-4xl">Local Docker</CardTitle>
            <CardDescription className="text-black/70">
              Run the dashboard, backend, and database together.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm leading-6 text-black/70">
              Install Git, Make, and Docker with Compose, start Docker, then run:
            </p>
            <pre className="overflow-x-auto rounded-2xl border border-black/10 bg-white/70 p-4 text-xs leading-6 sm:text-sm sm:leading-7">
{`git clone https://github.com/sumanbasuli/lime.git
cd lime
make init-env
make start-all`}
            </pre>
            <p className="mt-4 text-sm leading-6 text-black/70">
              This manual setup publishes the dashboard and backend ports on
              the host. If other people can reach it, restrict both ports at
              the firewall. For remote use, expose the dashboard through an
              authenticated proxy or trusted private network, and keep direct
              backend access private. The dashboard and ordinary API have no
              built-in login; an MCP key
              protects only the MCP endpoint.
            </p>
            <p className="mt-4 text-sm leading-6 text-black/70">
              Open the dashboard at <code>http://localhost:3000</code> once
              the services are ready. The backend defaults to port 8080;
              change <code>LIME_API_PORT</code> in <code>.env</code> if needed.
              See the <a href={withBasePath("/docs/reference/setup/")} className="font-semibold underline">setup guide</a> for
              startup help and development options.
            </p>
            <Button className="mt-5 w-full justify-center sm:w-auto" asChild>
              <a href={withBasePath("/docs/user/first-scan/")}>
                Run your first scan <MaterialSymbol name="arrow_forward" size={18} />
              </a>
            </Button>
            <p className="mt-4 text-sm leading-6 text-black/70">
              In LIME 2.0, select <strong>Include link check</strong> when
              creating a scan, or use <strong>Link checker</strong> to check a page or explore links across your site.
              Read the <a href={withBasePath("/docs/user/link-checker/")} className="font-semibold underline">link checker guide</a> for
              setup options and help interpreting results. Link results stay separate from
              accessibility scoring and reports.
            </p>
            <p className="mt-4 text-sm leading-6 text-black/70">
              Connect Codex, Claude Code, or OpenCode using the examples in
              Settings. Your assistant can read results and reports by default.
              Enable write access to let it run scans, check links, and manage findings.
              Follow the <a href={withBasePath("/docs/user/mcp/")} className="font-semibold underline">MCP guide</a> to get connected.
            </p>
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Host LIME on your server</CardTitle>
            <CardDescription>
              Choose a guide for your environment. Use a release tag for
              predictable updates and back up your database and screenshots.
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
              <a href={withBasePath("/docs/reference/deployment/backup-restore/")}>Backup and restore</a>
            </Button>
            <Button variant="outline" className="justify-start text-left" asChild>
              <a href={siteConfig.releasesUrl}>GitHub releases</a>
            </Button>
            <p className="text-sm leading-6 text-black/60">
              After setup, check that scans, reports, and backups work on your
              server. The <a href={withBasePath("/docs/reference/verification/")} className="font-semibold underline">testing guide</a> explains
              how to check the main features.
            </p>
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
          Run the LIME application separately to use scans and MCP.
        </p>
        <a href={withBasePath("/docs/reference/docs-site/")} className="mt-3 inline-block text-sm font-semibold underline">Docs preview and publishing guide</a>
      </section>
    </main>
    </SiteShell>
  );
}
