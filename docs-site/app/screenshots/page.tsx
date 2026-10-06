import { ScreenshotGallery } from "@/components/screenshot-gallery";
import { productScreenshots } from "@/content/screenshots";
import { SiteShell } from "@/components/site-shell";
import { withBasePath } from "@/lib/site";

export const metadata = {
  title: "Screenshots",
  description: "See LIME's accessibility scans, Link Checker, saved evidence, reports, and settings.",
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
            Take a look around LIME, from starting a scan to reviewing issues,
            checking links, and sharing reports. Select an image for a closer look.
          </p>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-black/55">
            Screenshots show example results from completed scans.
            Learn more in the <a href={withBasePath("/docs/user/link-checker/")} className="font-semibold underline">Link Checker guide</a>,
            or connect your AI assistant with the <a href={withBasePath("/docs/user/mcp/")} className="font-semibold underline">MCP guide</a>.
          </p>
        </section>
        <ScreenshotGallery screenshots={productScreenshots} />
      </main>
    </SiteShell>
  );
}
