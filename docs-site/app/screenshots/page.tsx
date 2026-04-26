import { ScreenshotGallery } from "@/components/screenshot-gallery";
import { productScreenshots } from "@/content/screenshots";
import { SiteShell } from "@/components/site-shell";

export const metadata = {
  title: "Screenshots",
  description: "Screenshots of the LIME dashboard workflow.",
};

export default function ScreenshotsPage() {
  return (
    <SiteShell>
      <main className="mx-auto w-full max-w-[96rem] px-2.5 py-6 sm:px-4 md:px-6 md:py-8">
        <section className="mb-8">
          <h1 className="max-w-5xl font-heading text-[clamp(2.25rem,12vw,4.75rem)] leading-[0.95] tracking-[-0.045em]">
            See the dashboard workflow.
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
            Review the main screens before installing: scan creation, progress,
            issue evidence, exports, and settings. Click any image to expand it.
          </p>
        </section>
        <ScreenshotGallery screenshots={productScreenshots} />
      </main>
    </SiteShell>
  );
}
