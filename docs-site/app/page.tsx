import { MaterialSymbol } from "@/components/material-symbol";
import { InstallCommand } from "@/components/install-command";
import { SiteShell } from "@/components/site-shell";
import { siteConfig, withBasePath } from "@/lib/site";

const pipeline = [
  {
    number: "1",
    label: "Choose",
    title: "Start with a page or sitemap",
    copy: "Enter one page or a sitemap, then choose the screen size to check. LIME collects the pages and removes duplicate URLs.",
  },
  {
    number: "2",
    label: "Scan",
    title: "Check pages in a real browser",
    copy: "LIME opens pages in Chromium, runs axe-core accessibility checks, and saves screenshots when available.",
  },
  {
    number: "3",
    label: "Review",
    title: "See what needs attention",
    copy: "Review grouped issues, affected pages, and guidance for each finding. See which pages were checked and which findings need a closer look.",
  },
];

const features = [
  {
    icon: "screen_search_desktop",
    title: "See the issue in context",
    copy: "Find affected elements with screenshots, CSS selectors, and the surrounding HTML. Review the page as it appeared during the scan.",
    href: "/docs/user/issues/",
    linkLabel: "Review issue evidence",
  },
  {
    icon: "replay",
    title: "Retry failed pages",
    copy: "Pick up an incomplete scan without starting over. Retry failed pages while keeping completed results and screenshots.",
    href: "/docs/user/scan-detail/",
    linkLabel: "Manage a scan",
  },
  {
    icon: "speed",
    title: "Review large reports",
    copy: "Start with a summary, then open individual findings as you need them. Adjust report limits to keep large reports manageable.",
    href: "/docs/user/settings/",
    linkLabel: "Adjust report settings",
  },
  {
    icon: "file_save",
    title: "Share your findings",
    copy: "Download a PDF for review, a CSV for analysis, or a text report to help an AI assistant plan fixes.",
    href: "/docs/user/reports/",
    linkLabel: "Choose a report format",
  },
  {
    icon: "dns",
    title: "Run LIME your way",
    copy: "Run LIME locally with Docker or host it on your own server. Follow the setup guide for Docker, Debian, or Fly.io.",
    href: "/get-started/",
    linkLabel: "Choose your setup",
  },
  {
    icon: "link",
    title: "Link Checker",
    copy: "Check a page or follow links across your site. Add link checking to an accessibility scan, review the results, and export them as CSV.",
    badge: "Available now",
    href: "/docs/user/link-checker/",
    linkLabel: "Explore Link Checker",
  },
  {
    icon: "smart_toy",
    title: "MCP for AI tools",
    copy: "Connect your AI assistant to review results and reports. Enable write access when you want it to run scans, check links, or manage findings and settings.",
    href: "/docs/user/mcp/",
    linkLabel: "Connect an AI client",
  },
  {
    icon: "fact_check",
    title: "Make informed decisions",
    copy: "Investigate findings that need human review and mark confirmed false positives. Keep the evidence your team needs to decide what to fix.",
    href: "/docs/user/dashboard/",
    linkLabel: "Read score and coverage",
  },
];

function DashboardPreview() {
  return (
    <div role="img" aria-label="Illustrative LIME dashboard with sample scores and counts" className="mx-auto mt-14 w-full max-w-[1120px] overflow-hidden rounded-t-[22px] border border-black/10 bg-white shadow-[0_30px_80px_rgba(10,10,10,0.12)]">
      <div className="flex h-10 items-center gap-2 border-b border-black/8 bg-[#f8f7f3] px-4">
        <div className="flex gap-1.5">
          <span className="size-2 rounded-full bg-black/10" />
          <span className="size-2 rounded-full bg-black/10" />
          <span className="size-2 rounded-full bg-black/10" />
        </div>
        <div className="mx-auto hidden w-[42%] rounded-full border border-black/8 bg-white px-3 py-1 text-center font-mono text-[9px] text-black/60 sm:block">
          lime.internal/scans/example-scan
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
                  <div className="font-mono text-[7px] text-black/60">OUT OF 100</div>
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
                ["Excluded", "0", "border border-black/20 bg-white text-black"],
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
            <h1 className="mx-auto max-w-[1000px] font-heading text-[clamp(3.25rem,8vw,6.8rem)] leading-[0.9] font-semibold tracking-[-0.052em]">
              Accessibility audits
              <br />
              with <span className="lime-mark">evidence</span>.
            </h1>
            <p className="mx-auto mt-7 max-w-[720px] text-[15px] leading-7 text-black/58 sm:text-lg">
              Find accessibility issues and broken links on your own server.
              Give your team clear findings, useful screenshots, and reports that help them make fixes.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a href={withBasePath("/docs/user/first-scan/")} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-black px-7 text-sm font-semibold text-white no-underline transition-colors hover:bg-[#FFED00] hover:text-black sm:w-auto">
                Run your first scan <MaterialSymbol name="arrow_forward" size={18} />
              </a>
              <a href={siteConfig.releasesUrl} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border border-black/18 bg-white px-7 text-sm font-semibold text-black no-underline hover:bg-black/[0.035] sm:w-auto">
                <MaterialSymbol name="download" size={18} /> Download latest release
              </a>
            </div>
            <p className="mt-5 font-mono text-[10px] tracking-wide text-black/60">
              Self-hosted · Open source · axe-core · MCP integration
            </p>
            <p className="mx-auto mt-3 max-w-2xl text-xs leading-6 text-black/60">Use automated checks alongside manual accessibility testing. A scan score does not certify compliance.</p>
            <p className="mx-auto mt-6 max-w-2xl text-xs leading-6 text-black/60">Dashboard preview with example results.</p>
            <DashboardPreview />
          </div>
        </section>

        <section className="border-b border-black/8 bg-[#f6f5f0] py-16 sm:py-20">
          <div className="site-container">
            <div className="section-kicker">How it works</div>
            <h2 className="mt-5 max-w-[680px] font-heading text-[clamp(2.3rem,5vw,3.6rem)] leading-[1.02] tracking-[-0.035em]">
              From your first scan to your next fix.
            </h2>
            <div className="mt-9 grid gap-3 lg:grid-cols-3">
              {pipeline.map((step) => (
                <article key={step.number} className="rounded-[18px] border border-black/10 bg-white p-6">
                  <div className="flex items-center justify-between gap-4">
                    <span className="grid size-9 place-items-center rounded-full border border-black bg-[#FFED00] font-heading text-sm font-bold">{step.number}</span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-black/60">{step.label}</span>
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
                Find the element. Understand the issue.
              </h2>
              <p className="mt-5 max-w-[620px] text-[15px] leading-7 text-black/58">
                Each finding includes its page URL, CSS selector, and HTML context.
                Open the screenshot to see the affected element highlighted in yellow,
                with the rest of the page around it. Screenshots show the page at the time of the scan.
              </p>
              <div className="mt-7 space-y-3">
                {["Focused previews and full screenshots, where available", "Accessibility guidance with links to WCAG requirements", "Mark false positives to exclude them from scores and scan reports"].map((item) => (
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
              <div className="flex flex-wrap items-center justify-between gap-3 px-1 pt-3 font-mono text-[9px] text-black/60">
                <span>example.com/admissions</span>
                <span className="rounded-full border border-black bg-[#FFED00] px-2 py-1 font-sans font-bold text-black">EXAMPLE FINDING</span>
              </div>
            </div>
          </div>
        </section>

        <section className="border-b border-black/8 bg-[#f6f5f0] py-16 sm:py-20">
          <div className="site-container">
            <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
              <h2 className="font-heading text-[clamp(2.35rem,5vw,3.65rem)] leading-none tracking-[-0.035em]">Scan, review, and share.</h2>
              <p className="max-w-[390px] text-sm leading-6 text-black/60">Check accessibility and links in one place, investigate the findings, and give your team a clear starting point.</p>
            </div>
            <div className="mt-9 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {features.map((feature) => (
                <article key={feature.title} className="rounded-[18px] border border-black/10 bg-white p-6">
                  <div className="flex items-start justify-between gap-3">
                    <span className="grid size-10 place-items-center rounded-[10px] border border-black bg-[#FFED00]"><MaterialSymbol name={feature.icon} size={22} /></span>
                    {feature.badge ? <span className="rounded-full border border-black/15 bg-[#FFED00]/15 px-2 py-1 font-mono text-[8px] font-semibold uppercase tracking-wider text-black/60">{feature.badge}</span> : null}
                  </div>
                  <h3 className="mt-5 text-lg font-semibold">{feature.title}</h3>
                  <p className="mt-2 text-[13px] leading-6 text-black/58">{feature.copy}</p>
                  <a href={withBasePath(feature.href)} className="mt-4 inline-flex min-h-9 items-center gap-1.5 text-xs font-semibold text-black no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-4">
                    {feature.linkLabel}<MaterialSymbol name="arrow_forward" size={15} />
                  </a>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-black/8 py-12 sm:py-16">
          <div className="site-container grid gap-6 md:grid-cols-2">
            <div>
              <div className="section-kicker">Before you scan</div>
              <h2 className="mt-4 font-heading text-3xl tracking-[-0.025em]">Understand your results.</h2>
            </div>
            <div className="space-y-3 text-sm leading-7 text-black/60">
              <p>Link Checker reads links from page HTML within the limits you set. It does not run JavaScript or check links to sections within a page. A timeout or blocked request may need a manual check before you call the link broken.</p>
              <p>Link results do not affect accessibility scores. AI connections start with read-only access; enable writes in Settings when you want your assistant to make changes. Deleting data still requires confirmation.</p>
              <a href={withBasePath("/docs/user/troubleshooting/")} className="inline-flex min-h-9 items-center gap-1.5 font-semibold text-black no-underline hover:underline">Get help with results<MaterialSymbol name="arrow_forward" size={16} /></a>
            </div>
          </div>
        </section>

        <section className="py-16 sm:py-20">
          <div className="site-container grid gap-4 lg:grid-cols-2">
            <article className="min-w-0 overflow-hidden rounded-[20px] bg-black p-6 text-[#fffbe6] sm:p-8">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#FFED00]/25 bg-[#FFED00]/10 px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-wider text-[#FFED00]"><MaterialSymbol name="terminal" size={13} />One-line install</span>
              <h2 className="mt-4 text-3xl tracking-[-0.02em]">Your next audit starts here.</h2>
              <p className="mt-3 text-sm leading-6 text-white/55">Install LIME from your terminal on macOS or Linux. The script checks what you need and guides you through setup.</p>
              <InstallCommand />
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[11px] leading-5">
                <span className="inline-flex items-center gap-1.5 text-white/65"><MaterialSymbol name="check_circle" size={15} className="text-[#FFED00]" />macOS + Linux</span>
                <a href={withBasePath("/install.sh")} className="inline-flex min-h-9 items-center gap-1.5 font-semibold text-[#FFED00] underline decoration-[#FFED00]/35 underline-offset-4 hover:decoration-[#FFED00]">View install script<MaterialSymbol name="arrow_outward" size={14} /></a>
                <a href={withBasePath("/docs/reference/setup/")} className="inline-flex min-h-9 items-center gap-1.5 font-semibold text-[#FFED00] underline decoration-[#FFED00]/35 underline-offset-4 hover:decoration-[#FFED00]">Setup and help<MaterialSymbol name="arrow_forward" size={14} /></a>
              </div>
              <p className="mt-2 text-[10px] leading-5 text-white/65">The script installs Docker on macOS, Ubuntu, and Debian if needed. On other Linux distributions, install Docker first. LIME runs with Docker Compose; setup may ask for administrator access.</p>
              <p className="mt-2 text-[10px] leading-5 text-white/65">See supported platforms and options without installing: <code className="select-all font-mono [overflow-wrap:anywhere]">curl -fsSL https://lime.heysuman.com/install.sh | bash -s -- --help</code></p>
              <p className="mt-2 text-[10px] leading-5 text-white/65">By default, the installer uses the latest code from the main branch. Set <code>LIME_REF</code> to choose a release tag or branch.</p>
              <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[10px] text-white/50">
                {["Docker Compose", "macOS", "Linux / VPS"].map((item) => <span key={item} className="inline-flex items-center gap-1"><MaterialSymbol name="check" size={14} />{item}</span>)}
              </div>
            </article>
            <article className="min-w-0 rounded-[20px] border border-black bg-[#FFED00] p-6 sm:p-8">
              <h2 className="text-3xl tracking-[-0.02em]">Help at every step.</h2>
              <p className="mt-3 text-sm leading-6 text-black/60">Learn how to run scans and review results, or explore the developer guides to host, integrate, and contribute to LIME.</p>
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
