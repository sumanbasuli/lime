import { LinkCheckerPreview } from "@/components/link-checker-preview";

export default function LinkCheckerPage() {
  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="lime-page-title">Link checker</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            Crawl every page and verify internal, external, document, and media
            links. Broken targets will be grouped with every page that references
            them once the checker is connected.
          </p>
        </div>
        <p className="text-xs text-muted-foreground sm:pb-1">0 sites monitored</p>
      </div>

      <section aria-label="Link checker summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article className="rounded-[20px] border border-black bg-black p-5 text-white">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-white/55">
            Broken links
          </p>
          <p className="mt-3 font-heading text-[44px] font-semibold leading-none text-[#FFED00]">—</p>
          <p className="mt-3 text-[11px] text-white/55">No completed checks yet</p>
        </article>
        <article className="lime-card p-5">
          <p className="lime-eyebrow">Links checked</p>
          <p className="mt-3 font-heading text-[42px] font-semibold leading-none">—</p>
          <p className="mt-3 text-[11px] text-muted-foreground">Across all sites</p>
        </article>
        <article className="lime-card p-5">
          <p className="lime-eyebrow">Redirect chains</p>
          <p className="mt-3 font-heading text-[42px] font-semibold leading-none">—</p>
          <p className="mt-3 text-[11px] text-muted-foreground">Worth flattening to a single hop</p>
        </article>
        <article className="lime-card p-5">
          <p className="lime-eyebrow">Timeouts</p>
          <p className="mt-3 font-heading text-[42px] font-semibold leading-none">—</p>
          <p className="mt-3 text-[11px] text-muted-foreground">Hosts that never responded</p>
        </article>
      </section>

      <LinkCheckerPreview />

      <section>
        <h2 className="lime-section-title">All checks</h2>
        <div className="lime-card mt-3 flex min-h-40 items-center justify-center p-8 text-center">
          <div>
            <p className="font-heading text-xl font-semibold">No link checks yet</p>
            <p className="mt-2 max-w-md text-xs leading-5 text-muted-foreground">
              Check history, progress, broken targets, redirects, and CSV exports
              will appear here after the feature is connected.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
