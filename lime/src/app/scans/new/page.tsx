import { NewScanForm } from "@/components/new-scan-form";

export default function NewScanPage() {
  return (
    <div className="mx-auto w-full max-w-[680px] space-y-5">
      <div>
        <h1 className="lime-page-title">New scan</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          Point LIME at a sitemap or a single page. Pages are rendered in
          headless Chromium and audited against the full axe-core ruleset — WCAG
          A and AA, Lighthouse-aligned.
        </p>
      </div>

      <section className="lime-card p-6 sm:p-7">
        <NewScanForm />
      </section>
    </div>
  );
}
