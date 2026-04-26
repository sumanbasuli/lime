import {
  ArrowRightIcon,
  BadgeCheckIcon,
  BookOpenIcon,
  CameraIcon,
  Code2Icon,
  FileDownIcon,
  GaugeIcon,
  RefreshCwIcon,
  ScanSearchIcon,
} from "lucide-react";
import { getAllDocPages } from "@/lib/docs";
import { assetPath, siteConfig, withBasePath } from "@/lib/site";
import { SiteShell } from "@/components/site-shell";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const featureCards = [
  {
    title: "Evidence-first scanning",
    copy: "Sitemap and single-page scans run in Chromium, capture focused screenshots, and keep selectors and HTML context for review.",
    icon: ScanSearchIcon,
    className: "md:col-span-3 xl:col-span-5",
  },
  {
    title: "Same-scan recovery",
    copy: "Retry only the failed pages in a partial scan while keeping the same scan ID, completed pages, and report.",
    icon: RefreshCwIcon,
    className: "md:col-span-3 xl:col-span-4",
  },
  {
    title: "Large-report performance",
    copy: "Issue summaries load first, occurrence details are paginated, and exports stay bounded for large sites.",
    icon: GaugeIcon,
    className: "md:col-span-6 xl:col-span-3",
  },
  {
    title: "Reports for every workflow",
    copy: "Use PDFs for review, CSV for analysis, and compact LLM text for AI-assisted remediation planning.",
    icon: FileDownIcon,
    className: "md:col-span-3 xl:col-span-4",
  },
  {
    title: "Clear deployment paths",
    copy: "Run locally with Docker Compose, deploy with Docker images, or use the Fly.io guide for hosted installs.",
    icon: BadgeCheckIcon,
    className: "md:col-span-3 xl:col-span-4",
  },
  {
    title: "Contributor documentation",
    copy: "Architecture notes, API docs, release steps, and contribution guidance are kept with the project.",
    icon: Code2Icon,
    className: "md:col-span-6 xl:col-span-4",
  },
];

export default function HomePage() {
  const docs = getAllDocPages().filter((page) => page.category !== "Reference");

  return (
    <SiteShell>
    <main className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8 md:py-12">
      <section className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <Card className="overflow-hidden border-black/10 bg-[#FFED00] py-0 text-black">
          <CardContent className="relative min-h-[500px] p-7 md:p-10">
            <h1 className="max-w-3xl font-heading text-[clamp(2.75rem,7vw,5.35rem)] leading-[0.92] tracking-[-0.05em]">
              Accessibility audits with evidence.
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-black/72 md:text-lg">
              LIME is a self-hosted scanner for teams that need traceable
              results: screenshots, issue grouping, same-scan retry for partial
              runs, and exports that support remediation work.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button variant="default" size="lg" asChild>
                <a href={withBasePath("/docs/user/first-scan/")}>
                  Start with user docs <ArrowRightIcon className="size-4" />
                </a>
              </Button>
              <Button variant="outline" size="lg" className="border-black/20 bg-white/70" asChild>
                <a href={siteConfig.releasesUrl}>Download latest release</a>
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card className="overflow-hidden border-black/10 bg-white py-0">
            <CardContent className="flex min-h-[360px] items-center justify-center p-8 md:min-h-[410px]">
              <img
                src={assetPath("/brand/lime.svg")}
                alt="LIME"
                className="h-auto w-full max-w-[21rem]"
              />
            </CardContent>
          </Card>
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="py-4">
              <CardContent>
                <div className="whitespace-nowrap font-heading text-base font-bold tracking-tight">Scan workflow</div>
                <p className="mt-1 text-xs text-muted-foreground">Create scans, inspect results, retry partials.</p>
              </CardContent>
            </Card>
            <Card className="py-4">
              <CardContent>
                <div className="whitespace-nowrap font-heading text-base font-bold tracking-tight">Issue evidence</div>
                <p className="mt-1 text-xs text-muted-foreground">Screenshots, selectors, HTML, and ACT links.</p>
              </CardContent>
            </Card>
            <Card className="py-4">
              <CardContent>
                <div className="whitespace-nowrap font-heading text-base font-bold tracking-tight">Exports</div>
                <p className="mt-1 text-xs text-muted-foreground">PDF, CSV, and LLM-ready text reports.</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      <section className="mt-4 bento-grid">
        {featureCards.map((feature) => {
          const Icon = feature.icon;
          return (
            <Card key={feature.title} className={feature.className}>
              <CardHeader>
                <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-[#FFED00] text-black">
                  <Icon className="size-5" />
                </div>
                <CardTitle>{feature.title}</CardTitle>
                <CardDescription>{feature.copy}</CardDescription>
              </CardHeader>
            </Card>
          );
        })}
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <Card className="bg-black text-[#fffbe6]">
          <CardHeader>
            <CardTitle className="text-3xl">Start from a local install.</CardTitle>
            <CardDescription className="text-[#fffbe6]/70">
              Use Docker Compose to evaluate LIME, then move to Docker images
              or Fly.io when you are ready to run it for a team.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5 p-4 text-sm leading-7">
{`git clone https://github.com/sumanbasuli/lime.git
cd lime
cp .env.example .env
make start-all`}
            </pre>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-3xl">Documentation sets</CardTitle>
            <CardDescription>
              User docs explain how to operate the tool. Developer docs explain
              how to contribute, extend, deploy, and integrate with it.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            <Button variant="outline" className="h-auto justify-start p-4" asChild>
              <a href={withBasePath("/docs/user/first-scan/")}>
                <BookOpenIcon className="size-5" />
                User docs
              </a>
            </Button>
            <Button variant="outline" className="h-auto justify-start p-4" asChild>
              <a href={withBasePath("/docs/developer/contributing/")}>
                <Code2Icon className="size-5" />
                Developer docs
              </a>
            </Button>
            <Button variant="outline" className="h-auto justify-start p-4" asChild>
              <a href={withBasePath("/screenshots/")}>
                <CameraIcon className="size-5" />
                Screenshots
              </a>
            </Button>
          </CardContent>
        </Card>
      </section>

      <section className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {docs.slice(0, 6).map((doc) => (
          <Card key={doc.href}>
            <CardHeader>
              <span className="mb-3 w-fit rounded-full border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {doc.category}
              </span>
              <CardTitle>{doc.title}</CardTitle>
              <CardDescription>{doc.excerpt}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="ghost" className="px-0" asChild>
                <a href={withBasePath(doc.href)}>
                  Read doc <ArrowRightIcon className="size-4" />
                </a>
              </Button>
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
    </SiteShell>
  );
}
