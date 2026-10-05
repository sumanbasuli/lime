import { SiteShell } from "@/components/site-shell";
import { cn } from "@/lib/utils";

export const metadata = {
  title: "Roadmap",
  description:
    "LIME's shipped 1.x features, validation priorities, and proposed future work.",
};

const milestones = [
  {
    tag: "Shipped",
    tone: "green",
    title: "Current baseline",
    items: [
      "Sitemap and single-page scans with viewport-aware axe-core execution",
      "Focused screenshots, issue grouping, ACT guidance, and false-positive triage",
      "Partial-scan failed-page retry inside the same scan",
      "Cooperative pause, same-scan resume, and startup recovery",
      "Full-scan and per-issue PDF, CSV, and LLM exports",
      "Read-only MCP endpoint with generated bearer-key auth",
      "Reporting, performance, and integration settings",
      "Docker, Fly.io, GHCR images, release bundles, and update scripts",
    ],
  },
  {
    tag: "Next priorities",
    tone: "yellow",
    title: "Validation and hardening",
    items: [
      "Repeatable large-site benchmarks and report-memory measurements",
      "Real deployment, update, backup, and restore validation per target",
      "Dependency and security review before broader production claims",
      "MCP client feedback and interoperability beyond the tested setup",
    ],
  },
  {
    tag: "Planned",
    tone: "outline",
    title: "Future product work",
    items: [
      "Link Checker backend validation and saved results — the current screen is a preview",
      "MCP diagnostics, origin policies, or session support when client needs justify them",
      "Deferred: OAuth, scoped keys, write tools, and multi-user authentication",
    ],
  },
] as const;

const toneClasses = {
  green: "bg-[#1E7A4E] text-white",
  yellow: "border border-black bg-[#FFED00] text-black",
  outline: "border border-black/25 bg-white text-black",
} as const;

export default function RoadmapPage() {
  return (
    <SiteShell active="roadmap">
      <main className="site-container py-16">
        <div className="mx-auto max-w-[860px]">
          <span className="inline-flex rounded-full border border-black/15 bg-white px-3.5 py-[5px] text-[11px] font-bold tracking-[0.1em] uppercase">
            Where LIME is going
          </span>
          <h1 className="mt-[18px] font-heading text-[clamp(2.25rem,5vw,3.25rem)] leading-none font-semibold tracking-[-0.035em]">
            Roadmap
          </h1>
          <p className="mt-4 max-w-[600px] text-base leading-[1.6] text-black/65">
            What is available in the current 1.x codebase, what still needs
            validation, and what we may build next. Planned items are not
            available features or release-date promises.
          </p>

          <div className="mt-11 flex flex-col gap-4">
            {milestones.map((milestone) => (
              <section
                key={milestone.tag}
                className="rounded-[20px] border border-black/10 bg-white px-5 py-6 sm:px-7 sm:py-[26px]"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={cn(
                      "inline-flex rounded-full px-[13px] py-1 text-[10.5px] font-bold tracking-[0.1em] uppercase",
                      toneClasses[milestone.tone]
                    )}
                  >
                    {milestone.tag}
                  </span>
                  <h2 className="m-0 font-heading text-2xl font-semibold tracking-[-0.02em]">
                    {milestone.title}
                  </h2>
                </div>

                <ul className="mt-4 flex list-none flex-col gap-[9px] p-0">
                  {milestone.items.map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-2.5 text-sm leading-[1.5] text-black/70"
                    >
                      <span
                        aria-hidden="true"
                        className="mt-[5px] size-2 shrink-0 rounded-full border-[1.5px] border-black bg-[#FFED00]"
                      />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </main>
    </SiteShell>
  );
}
