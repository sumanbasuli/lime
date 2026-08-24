import { ScreenshotGallery } from "@/components/screenshot-gallery";
import { productScreenshots } from "@/content/screenshots";
import { SiteShell } from "@/components/site-shell";

export const metadata = {
  title: "Screenshots",
  description: "Screenshots of the LIME dashboard workflow.",
};

export default function ScreenshotsPage() {
  return (
    <SiteShell active="screenshots">
      <main className="site-container py-12 sm:py-16">
        <section className="mb-12">
          <div className="section-kicker">Product walkthrough</div>
          <h1 className="mt-5 max-w-5xl font-heading text-[clamp(2.75rem,6vw,4.4rem)] leading-[0.98] tracking-[-0.04em]">
            Screenshots
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-black/58 sm:text-lg sm:leading-8">
            Review the main screens before installing: scan creation, progress,
            issue evidence, exports, and settings. Click any image to expand it.
          </p>
        </section>
        <ScreenshotGallery screenshots={productScreenshots} />
      </main>
    </SiteShell>
  );
}
