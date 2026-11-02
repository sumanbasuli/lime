import { MaterialSymbol } from "@/components/material-symbol";
import { SiteShell } from "@/components/site-shell";
import { withBasePath } from "@/lib/site";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "Roadmap",
  description:
    "See what’s available in LIME 2.0, what we plan to improve next, and ideas for the future.",
};

const stages = [
  {
    id: "shipped",
    number: "01",
    status: "Available · Accessibility",
    legend: "Accessibility",
    countLabel: "features",
    icon: "check_circle",
    tone: "paper",
    title: "From scan to shared report",
    description:
      "Scan your site, understand the findings, and give your team the details they need to start fixing accessibility issues.",
    items: [
      {
        icon: "screen_search_desktop",
        title: "Scan your way",
        copy: "Check a single page or a sitemap with axe-core in Chromium. Choose a screen size to see how your pages behave on different devices.",
      },
      {
        icon: "image_search",
        title: "Evidence you can inspect",
        copy: "Review grouped findings with guidance, CSS selectors, and screenshots that highlight the affected element. Mark confirmed false positives as you review.",
      },
      {
        icon: "replay",
        title: "Recover without starting over",
        copy: "Pause and resume a scan, or retry only the pages that failed. Completed results stay together in the same scan.",
      },
      {
        icon: "file_save",
        title: "Reports for every audience",
        copy: "Share a whole scan or a single issue as PDF, CSV, or text for an AI assistant. Choose the level of detail your audience needs.",
      },
      {
        icon: "smart_toy",
        title: "Connect your AI assistant",
        copy: "Use MCP to let a compatible assistant review saved results and reports. Enable write access separately when you want it to make changes.",
      },
      {
        icon: "dns",
        title: "Host it yourself",
        copy: "Run LIME with Docker or follow the Debian guide. Keep your scans, database, and screenshots on infrastructure you control.",
      },
    ],
    href: "/docs/user/first-scan/",
    linkLabel: "Run your first scan",
    footer: "Available in LIME 2.0. The first-scan guide walks you through the full process.",
  },
  {
    id: "current",
    number: "02",
    status: "Available · LIME 2.0",
    legend: "LIME 2.0",
    countLabel: "features",
    icon: "check_circle",
    tone: "yellow",
    title: "New in LIME 2.0",
    description:
      "Check links alongside accessibility, work through your AI assistant, and get started with a simpler installation.",
    items: [
      {
        icon: "link",
        title: "Link Checker",
        copy: "Check a page or follow links across your site, on its own or with an accessibility scan. See where each link appears and export the results as CSV. Link checks do not affect accessibility scores.",
      },
      {
        icon: "smart_toy",
        title: "More you can do with MCP",
        copy: "Ask your assistant to review findings, download reports, run scans, or check links. Connections start read-only; enable write access to manage scans, findings, and settings.",
      },
      {
        icon: "terminal",
        title: "Simpler setup",
        copy: "Install LIME on macOS or Linux with one terminal command. Connect Codex, Claude Code, or OpenCode using the setup examples in Settings.",
      },
      {
        icon: "tune",
        title: "A refreshed dashboard",
        copy: "Find your way around with a new dashboard design, clearer link results, and filters that help you focus. Screenshot previews still open to show the highlighted element in context.",
      },
    ],
    href: "/docs/user/link-checker/",
    linkLabel: "Read the Link Checker guide",
    footer: "Available now. Start with a link check to see which destinations need attention.",
  },
  {
    id: "validation",
    number: "03",
    status: "Next priorities",
    legend: "Up next",
    countLabel: "priorities",
    icon: "fact_check",
    tone: "paper",
    title: "Make LIME easier to run",
    description:
      "Our next priorities focus on installation, reliable backups, larger sites, and compatibility with more AI clients.",
    items: [
      {
        icon: "computer",
        title: "Smoother first-time setup",
        copy: "Test installation on more fresh macOS and Linux systems, including Docker setup, and improve guidance wherever people get stuck.",
      },
      {
        icon: "settings_backup_restore",
        title: "Reliable backup and restore",
        copy: "Test recovery across supported hosting options and make it easier to restore both the database and saved screenshots.",
      },
      {
        icon: "cloud_upload",
        title: "More hosting checks",
        copy: "Expand testing of published Docker images and native Debian deployments so the guides cover more real installation scenarios.",
      },
      {
        icon: "speed",
        title: "Larger sites and more AI clients",
        copy: "Improve performance testing for large scans and reports, keep dependencies current, and use feedback from real MCP integrations to improve compatibility.",
      },
    ],
    href: "/docs/reference/verification/",
    linkLabel: "Read the testing guide",
    footer: "These are ongoing priorities. Test a new deployment with your own site before depending on it for regular audits.",
  },
  {
    id: "future",
    number: "04",
    status: "Future ideas",
    legend: "Future ideas",
    countLabel: "possible directions",
    icon: "lightbulb",
    tone: "outline",
    title: "Help shape what comes next",
    description:
      "We’re exploring these ideas based on feedback. They are not available yet and do not have release dates.",
    items: [
      {
        icon: "travel_explore",
        title: "Broader link coverage",
        copy: "Scheduled checks and support for links added by JavaScript could help teams monitor more of their sites.",
      },
      {
        icon: "hub",
        title: "Easier AI connections",
        copy: "Clearer connection diagnostics and broader client support could make it easier to connect the assistant you already use.",
      },
      {
        icon: "verified_user",
        title: "Access for teams",
        copy: "Explore OAuth, individual accounts, and keys with different permissions. Today, an MCP key and its write setting apply to the whole LIME installation.",
      },
    ],
    href: "/docs/user/mcp/",
    linkLabel: "See how MCP works today",
    footer: "Plans may change as we learn what helps teams most.",
  },
] as const;

const cardTones = {
  paper: "border-black/12 bg-white",
  yellow: "border-black bg-[#FFED00]/12 shadow-[0_18px_45px_rgba(10,10,10,0.06)]",
  outline: "border-dashed border-black/25 bg-[#FBFAF6]",
} as const;

export default function RoadmapPage() {
  return (
    <SiteShell active="roadmap">
      <main>
        <section className="border-b border-black/10 bg-[#f6f5f0]">
          <div className="site-container py-14 sm:py-20 lg:py-24">
            <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
              <div className="min-w-0">
                <div className="section-kicker">Built in the open</div>
                <h1 className="mt-6 font-heading text-[clamp(3.5rem,8vw,6.5rem)] leading-[0.95] font-semibold tracking-[-0.055em]">
                  Road<span className="lime-mark">map</span>
                </h1>
                <p className="mt-7 max-w-[640px] text-lg leading-8 text-black/65 sm:text-xl sm:leading-9">
                  See what’s available today, what we plan to improve next,
                  and where LIME could go from here.
                </p>
                <p className="mt-4 max-w-[600px] text-sm leading-7 text-black/55">
                  LIME 2.0 adds link checking, more ways to work with AI,
                  and a refreshed dashboard. Here’s what comes next.
                </p>
                <a href={withBasePath("/docs/")} className="mt-7 inline-flex items-center gap-2 rounded-full border border-black/18 bg-white px-5 py-3 text-sm font-semibold no-underline transition-colors hover:bg-[#FFED00] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black">
                  Explore the documentation
                  <MaterialSymbol name="arrow_forward" size={18} />
                </a>
              </div>

              <aside className="min-w-0 rounded-[26px] bg-[#0a0a0a] p-6 text-white shadow-[0_24px_65px_rgba(10,10,10,0.13)] sm:p-8" aria-label="Available features">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="font-mono text-[10px] font-semibold tracking-[0.12em] text-white/55 uppercase">Available now</span>
                  <span className="rounded-full bg-[#FFED00] px-3 py-1.5 font-mono text-[10px] font-bold text-black">LIME 2.0 · CURRENT</span>
                </div>
                <div className="mt-9 grid size-12 place-items-center rounded-2xl border border-white/20 text-[#FFED00]">
                  <MaterialSymbol name="route" size={27} />
                </div>
                <h2 className="mt-5 font-heading text-[clamp(1.9rem,3.5vw,2.8rem)] leading-[1.08] tracking-[-0.025em]">
                  Accessibility and links.<br />Together in LIME 2.0.
                </h2>
                <p className="mt-4 text-sm leading-7 text-white/65">
                  Check your site, review the findings, and work with your
                  AI assistant from the first scan to the next fix.
                </p>
                <div className="mt-6 flex flex-wrap gap-2">
                  {["Link Checker", "MCP integration", "One-line installation"].map((label) => (
                    <span key={label} className="rounded-full border border-white/20 px-3 py-1.5 text-[11px] font-medium text-white/80">{label}</span>
                  ))}
                </div>
                <a href="#current" className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-[#FFED00] no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#FFED00]">
                  Explore LIME 2.0
                  <MaterialSymbol name="arrow_downward" size={18} />
                </a>
              </aside>
            </div>
          </div>
        </section>

        <div className="site-container py-10 sm:py-14 lg:py-16">
          <nav aria-label="Roadmap status legend" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {stages.map((stage) => (
              <a key={stage.id} href={`#${stage.id}`} className="group flex min-w-0 items-center gap-4 rounded-2xl border border-black/12 bg-white p-4 no-underline transition-colors hover:border-black/30 hover:bg-[#FFED00]/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black sm:p-5">
                <span className={cn("grid size-10 shrink-0 place-items-center rounded-full", stage.id === "current" ? "bg-[#FFED00] text-black" : "bg-black/[0.045] text-black/70")}>
                  <MaterialSymbol name={stage.icon} size={21} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{stage.legend}</span>
                  <span className="mt-1 block text-xs leading-5 text-black/55">{stage.items.length} {stage.countLabel}</span>
                </span>
                <MaterialSymbol name="arrow_downward" size={16} className="text-black/35 group-hover:text-black" />
              </a>
            ))}
          </nav>

          <div className="mt-10 grid items-start gap-5 lg:mt-14 lg:grid-cols-2 lg:gap-x-7 lg:gap-y-10">
            {stages.map((stage, index) => (
              <section key={stage.id} id={stage.id} aria-labelledby={`${stage.id}-title`} className={cn("min-w-0 scroll-mt-36 overflow-hidden rounded-[24px] border", cardTones[stage.tone], index % 2 === 0 && "lg:mt-10")}>
                <div className="border-b border-black/10 p-6 sm:p-8">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className={cn("inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[10px] font-bold tracking-[0.06em] uppercase", stage.id === "current" ? "bg-black text-[#FFED00]" : "border border-black/15 bg-white text-black/65")}>
                      <MaterialSymbol name={stage.icon} size={15} />
                      {stage.status}
                    </span>
                    <span aria-hidden="true" className="font-mono text-xs text-black/30">{stage.number}</span>
                  </div>
                  <h2 id={`${stage.id}-title`} className="mt-6 font-heading text-[clamp(1.75rem,3vw,2.35rem)] leading-[1.12] font-semibold tracking-[-0.025em]">{stage.title}</h2>
                  <p className="mt-3 text-sm leading-7 text-black/60">{stage.description}</p>
                </div>

                <ul className="m-0 list-none space-y-6 p-6 sm:p-8">
                  {stage.items.map((item) => (
                    <li key={item.title} className="flex min-w-0 items-start gap-3.5 sm:gap-4">
                      <span className={cn("mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl", stage.id === "current" ? "border border-black/15 bg-[#FFED00]/60" : "bg-black/[0.045]")}>
                        <MaterialSymbol name={item.icon} size={19} />
                      </span>
                      <div className="min-w-0">
                        <h3 className="font-sans text-sm font-semibold leading-6">{item.title}</h3>
                        <p className="mt-1 text-[13px] leading-6 text-black/60">{item.copy}</p>
                      </div>
                    </li>
                  ))}
                </ul>

                <div className="border-t border-black/10 px-6 py-5 sm:px-8 sm:py-6">
                  <p className="text-xs leading-6 text-black/55">{stage.footer}</p>
                  <a href={withBasePath(stage.href)} className="mt-3 inline-flex items-center gap-2 text-sm font-semibold no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black">
                    {stage.linkLabel}
                    <MaterialSymbol name="arrow_forward" size={17} />
                  </a>
                </div>
              </section>
            ))}
          </div>

          <aside className="mt-10 flex flex-col gap-5 rounded-[20px] border border-black/12 bg-white p-6 sm:p-8 lg:mt-14 lg:flex-row lg:items-center lg:justify-between" aria-label="Reading the roadmap">
            <div className="flex min-w-0 items-start gap-4">
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[#FFED00]">
                <MaterialSymbol name="info" size={21} />
              </span>
              <div className="max-w-[760px]">
                <h2 className="font-heading text-xl tracking-[-0.02em]">Try LIME in your environment.</h2>
                <p className="mt-2 text-sm leading-7 text-black/60">
                  Before using a new deployment for regular audits, run a small scan,
                  open its reports, and check your backup process. The testing guide
                  covers the checks you can run yourself.
                </p>
              </div>
            </div>
            <a href={withBasePath("/docs/reference/verification/")} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-black px-5 py-3 text-sm font-semibold text-white no-underline transition-colors hover:bg-[#FFED00] hover:text-black focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-black">
              Open the testing guide
              <MaterialSymbol name="arrow_forward" size={18} />
            </a>
          </aside>
        </div>
      </main>
    </SiteShell>
  );
}
