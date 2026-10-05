import { MaterialSymbol } from "@/components/material-symbol";
import { SiteShell } from "@/components/site-shell";
import { siteConfig, withBasePath } from "@/lib/site";

const pipeline = [
  {
    number: "1",
    label: "Profiler",
    title: "Point it at a sitemap",
    copy: "Sitemaps and sitemap indexes expand into a validated, deduplicated URL set — or scan a single page with your chosen viewport.",
  },
  {
    number: "2",
    label: "Juicer",
    title: "Chromium renders and audits",
    copy: "Headless workers run the full axe-core ruleset on every page and capture a focused, spotlighted screenshot of each violation.",
  },
  {
    number: "3",
    label: "Sweetner",
    title: "Issues, grouped with guidance",
    copy: "Results dedupe into reviewable issue groups with ACT rules, WCAG references, suggested changes, and a Lighthouse-style score.",
  },
];

const features = [
  {
    icon: "screen_search_desktop",
    title: "Evidence-first scanning",
    copy: "Sitemap and single-page scans run in Chromium, capture focused screenshots, and keep selectors and HTML context for review.",
  },
  {
    icon: "replay",
    title: "Same-scan recovery",
    copy: "Retry only failed pages in a partial scan while keeping the same scan ID, completed pages, and report.",
  },
  {
    icon: "speed",
    title: "Large-report performance",
    copy: "Issue summaries load first, occurrence details are paginated, and exports stay bounded for large sites.",
  },
  {
    icon: "file_save",
    title: "Reports for every workflow",
    copy: "PDFs for review, CSV for analysis, and compact LLM text for AI-assisted remediation planning.",
  },
  {
    icon: "dns",
    title: "Clear deployment paths",
    copy: "Run locally with Docker Compose, deploy with Docker images, or use the Fly.io guide for hosted installs.",
  },
  {
    icon: "link",
    title: "Find broken destinations",
    copy: "Check one page, crawl same-origin pages, or include a companion link check with an accessibility scan. Review saved destinations and export CSV.",
    badge: "New · unreleased",
  },
  {
    icon: "smart_toy",
    title: "MCP for AI tools",
    copy: "A read-only MCP endpoint lets AI clients inspect scans, issues, saved link checks and source references, gated by a generated key.",
  },
];

function DashboardPreview() {
  return (
    <div className="mx-auto mt-14 w-full max-w-[1120px] overflow-hidden rounded-t-[22px] border border-black/10 bg-white shadow-[0_30px_80px_rgba(10,10,10,0.12)]">
      <div className="flex h-10 items-center gap-2 border-b border-black/8 bg-[#f8f7f3] px-4">
        <div className="flex gap-1.5">
          <span className="size-2 rounded-full bg-black/10" />
          <span className="size-2 rounded-full bg-black/10" />
          <span className="size-2 rounded-full bg-black/10" />
        </div>
        <div className="mx-auto hidden w-[42%] rounded-full border border-black/8 bg-white px-3 py-1 text-center font-mono text-[9px] text-black/35 sm:block">
          lime.internal/scans/fake-university
        </div>
      </div>
      <div className="grid min-h-[250px] grid-cols-1 sm:grid-cols-[170px_1fr]">
        <aside className="hidden border-r border-black/8 bg-[#fbfaf6] p-4 sm:block">
          <div className="mb-5 font-heading text-lg font-semibold">
            <span className="bg-[#FFED00] px-1">Lime</span>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-black px-3 py-2 text-[10px] font-semibold text-[#FFED00]">
            <MaterialSymbol name="dashboard" size={15} /> Dashboard
          </div>
          <div className="mt-1 flex items-center gap-2 px-3 py-2 text-[10px] text-black/55">
            <MaterialSymbol name="screen_search_desktop" size={15} /> Scans
          </div>
          <div className="flex items-center gap-2 px-3 py-2 text-[10px] text-black/55">
            <MaterialSymbol name="link" size={15} /> Link checker
          </div>
        </aside>
        <div className="p-5 sm:p-7">
          <h2 className="font-heading text-xl font-semibold sm:text-2xl">Accessibility score</h2>
          <div className="mt-5 grid gap-4 lg:grid-cols-[190px_1fr]">
            <div className="flex items-center gap-4 rounded-xl border border-black/8 p-4">
              <div className="grid size-[86px] place-items-center rounded-full border-[9px] border-[#1E7A4E] border-r-black/10">
                <div className="text-center">
                  <div className="font-heading text-3xl font-semibold leading-none">87</div>
                  <div className="font-mono text-[7px] text-black/45">OUT OF 100</div>
                </div>
              </div>
              <span className="rounded-full border border-[#1E7A4E]/35 px-2 py-1 text-[8px] font-bold uppercase tracking-wider text-[#1E7A4E]">
                Good
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {[
                ["Passed", "47", "bg-[#1E7A4E] text-white"],
                ["Failed", "6", "bg-[#8F2D31] text-white"],
                ["Review", "4", "border border-black bg-[#FFED00] text-black"],
                ["Excluded", "2", "border border-black/20 bg-white text-black"],
              ].map(([label, value, tone]) => (
                <div key={label} className="rounded-xl border border-black/8 p-3">
                  <span className={["inline-flex rounded-full px-2 py-0.5 text-[7px] font-bold uppercase tracking-wider", tone].join(" ")}>
                    {label}
                  </span>
                  <div className="mt-3 font-heading text-2xl font-semibold">{value}</div>
                </div>
              ))}
              <div className="col-span-2 mt-1 h-1 rounded-full bg-black/8 md:col-span-4">
                <div className="h-1 w-[87%] rounded-full bg-[#FFED00]" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <SiteShell active="product">
      <main>
        <section className="overflow-hidden border-b border-black/8">
          <div className="site-container pt-14 text-center sm:pt-20 lg:pt-24">
            <a
              href={siteConfig.releasesUrl}
              className="inline-flex items-center gap-2 rounded-full border border-black/12 bg-white px-3 py-1.5 font-mono text-[10px] font-semibold text-black/60 no-underline hover:border-black/25"
            >
              <span className="size-1.5 rounded-full bg-[#FFED00] ring-1 ring-black" />
              v1.0.5 — redesigned workflows and faster scans
              <MaterialSymbol name="arrow_forward" size={13} className="text-black/40" />
            </a>
            <h1 className="mx-auto mt-7 max-w-[1000px] font-heading text-[clamp(3.25rem,8vw,6.8rem)] leading-[0.9] font-semibold tracking-[-0.052em]">
              Accessibility audits
              <br />
              with <span className="lime-mark">evidence</span>.
            </h1>
            <p className="mx-auto mt-7 max-w-[720px] text-[15px] leading-7 text-black/58 sm:text-lg">
              LIME is a self-hosted scanner for teams that need traceable results — focused screenshots,
              grouped issues, same-scan retry, and exports built for remediation work.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a href={withBasePath("/docs/user/first-scan/")} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-black px-7 text-sm font-semibold text-white no-underline transition-colors hover:bg-[#FFED00] hover:text-black sm:w-auto">
                Run your first scan <MaterialSymbol name="arrow_forward" size={18} />
              </a>
              <a href={siteConfig.releasesUrl} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border border-black/18 bg-white px-7 text-sm font-semibold text-black no-underline hover:bg-black/[0.035] sm:w-auto">
                <MaterialSymbol name="download" size={18} /> Download latest release
              </a>
            </div>
            <p className="mt-5 font-mono text-[10px] tracking-wide text-black/38">
              Self-hosted · GPL-2.0 · Full axe-core ruleset · WCAG A / AA
            </p>
            <DashboardPreview />
          </div>
        </section>

        <section className="border-b border-black/8 bg-[#f6f5f0] py-16 sm:py-20">
          <div className="site-container">
            <div className="section-kicker">How it works</div>
            <h2 className="mt-5 max-w-[680px] font-heading text-[clamp(2.3rem,5vw,3.6rem)] leading-[1.02] tracking-[-0.035em]">
              One pipeline, from sitemap to remediation plan.
            </h2>
            <div className="mt-9 grid gap-3 lg:grid-cols-3">
              {pipeline.map((step) => (
                <article key={step.number} className="rounded-[18px] border border-black/10 bg-white p-6">
                  <div className="flex items-center justify-between gap-4">
                    <span className="grid size-9 place-items-center rounded-full border border-black bg-[#FFED00] font-heading text-sm font-bold">{step.number}</span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-black/35">{step.label}</span>
                  </div>
                  <h3 className="mt-5 text-xl font-semibold">{step.title}</h3>
                  <p className="mt-2 text-[13px] leading-6 text-black/58">{step.copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-black/8 py-16 sm:py-24">
          <div className="site-container grid items-center gap-12 lg:grid-cols-[1fr_0.95fr]">
            <div>
              <div className="section-kicker">Evidence first</div>
              <h2 className="mt-5 max-w-[620px] font-heading text-[clamp(2.35rem,5vw,3.65rem)] leading-[1.02] tracking-[-0.035em]">
                Every issue arrives with proof attached.
              </h2>
              <p className="mt-5 max-w-[620px] text-[15px] leading-7 text-black/58">
                No more “couldn’t reproduce”. Each occurrence keeps its page URL, CSS selector,
                formatted HTML snippet, and a spotlighted screenshot of the exact element.
              </p>
              <div className="mt-7 space-y-3">
                {["Focused captures with a spotlight overlay", "ACT rule guidance and WCAG mappings, bundled locally", "False-positive triage that updates the score"].map((item) => (
                  <div key={item} className="flex items-center gap-2.5 text-sm font-medium">
                    <MaterialSymbol name="check_circle" size={19} className="text-[#1E7A4E]" />{item}
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-[20px] border border-black/10 bg-[#f5efe3] p-3 shadow-[0_22px_60px_rgba(10,10,10,0.1)]">
              <div className="relative aspect-[16/10] overflow-hidden rounded-xl bg-[#979690]">
                <div className="absolute top-[18%] left-[8%] h-3 w-[22%] rounded-sm bg-black/20" />
                <div className="absolute top-[35%] right-[36%] bottom-[18%] left-[8%] border-2 border-[#FFED00] bg-white/30" />
                <div className="absolute top-[35%] right-[6%] space-y-3">
                  <div className="h-2.5 w-24 rounded-sm bg-black/18" />
                  <div className="h-2.5 w-20 rounded-sm bg-black/12" />
                  <div className="h-2.5 w-24 rounded-sm bg-black/12" />
                  <div className="mt-5 h-5 w-14 rounded-full bg-black" />
                </div>
                <span className="absolute bottom-[13%] left-[10%] rounded-md bg-black px-3 py-1.5 font-mono text-[9px] text-[#FFED00]">
                  image-alt · .hero-media &gt; img
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 px-1 pt-3 font-mono text-[9px] text-black/45">
                <span>fake-university.com/admissions</span>
                <span className="rounded-full border border-black bg-[#FFED00] px-2 py-1 font-sans font-bold text-black">CRITICAL · 24s</span>
              </div>
            </div>
          </div>
        </section>

        <section className="border-b border-black/8 bg-[#f6f5f0] py-16 sm:py-20">
          <div className="site-container">
            <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
              <h2 className="font-heading text-[clamp(2.35rem,5vw,3.65rem)] leading-none tracking-[-0.035em]">Built to be left running.</h2>
              <p className="max-w-[390px] text-sm leading-6 text-black/55">Migrations apply on boot, interrupted scans recover on restart, and updates are one command.</p>
            </div>
            <div className="mt-9 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {features.map((feature) => (
                <article key={feature.title} className="rounded-[18px] border border-black/10 bg-white p-6">
                  <div className="flex items-start justify-between gap-3">
                    <span className="grid size-10 place-items-center rounded-[10px] border border-black bg-[#FFED00]"><MaterialSymbol name={feature.icon} size={22} /></span>
                    {feature.badge ? <span className="rounded-full border border-black/15 px-2 py-1 font-mono text-[8px] font-semibold uppercase tracking-wider text-black/50">{feature.badge}</span> : null}
                  </div>
                  <h3 className="mt-5 text-lg font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-[13px] leading-6 text-black/58">{feature.copy}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="py-16 sm:py-20">
          <div className="site-container grid gap-4 lg:grid-cols-2">
            <article className="min-w-0 overflow-hidden rounded-[20px] bg-black p-6 text-[#fffbe6] sm:p-8">
              <h2 className="text-3xl tracking-[-0.02em]">Start from a local install.</h2>
              <p className="mt-3 text-sm leading-6 text-white/55">Use Docker Compose to evaluate LIME, then move to Docker images or Fly.io when you are ready to run it for a team.</p>
              <pre className="mt-6 max-w-full overflow-x-auto rounded-xl border border-white/10 bg-white/[0.055] p-4 font-mono text-xs leading-7 text-white/75">
                {["$ git clone https://github.com/sumanbasuli/lime.git", "$ cd lime && cp .env.example .env", "$ make start-all", "UI on :3000 · API on :8080"].join("\\n")}
              </pre>
              <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[10px] text-white/50">
                {["Fly.io", "Docker", "Debian systemd"].map((item) => <span key={item} className="inline-flex items-center gap-1"><MaterialSymbol name="check" size={14} />{item}</span>)}
              </div>
            </article>
            <article className="min-w-0 rounded-[20px] border border-black bg-[#FFED00] p-6 sm:p-8">
              <h2 className="text-3xl tracking-[-0.02em]">Documentation for both sides.</h2>
              <p className="mt-3 text-sm leading-6 text-black/60">User docs explain how to operate the tool. Developer docs explain how to contribute, extend, deploy, and integrate with it.</p>
              <div className="mt-10 grid gap-3 sm:grid-cols-3">
                {[
                  ["menu_book", "User docs", "First scan to reports", "/docs/user/"],
                  ["code", "Developer docs", "Architecture & API", "/docs/developer/"],
                  ["photo_camera", "Screenshots", "Product walkthrough", "/screenshots/"],
                ].map(([icon, title, copy, href]) => (
                  <a key={title} href={withBasePath(href)} className="rounded-xl border border-black/15 bg-white/85 p-4 text-black no-underline transition-transform hover:-translate-y-0.5">
                    <MaterialSymbol name={icon} size={20} />
                    <span className="mt-4 block text-sm font-semibold">{title}</span>
                    <span className="mt-1 block text-[10px] text-black/55">{copy}</span>
                  </a>
                ))}
              </div>
            </article>
          </div>
        </section>

        <section className="border-t border-black/8 bg-[#f6f5f0] py-20 text-center sm:py-24">
          <div className="site-container">
            <h2 className="mx-auto max-w-[760px] font-heading text-[clamp(2.5rem,5vw,4.25rem)] leading-[0.98] tracking-[-0.04em]">Your accessibility audits, on your own server.</h2>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a href={withBasePath("/get-started/")} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-black px-7 text-sm font-semibold text-white no-underline hover:bg-[#FFED00] hover:text-black sm:w-auto">Get started free <MaterialSymbol name="arrow_forward" size={18} /></a>
              <a href={siteConfig.repoUrl} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border border-black/15 bg-white px-7 text-sm font-semibold text-black no-underline hover:bg-black/[0.035] sm:w-auto"><MaterialSymbol name="star" size={18} /> Star on GitHub</a>
            </div>
          </div>
        </section>
      </main>
    </SiteShell>
  );
}
