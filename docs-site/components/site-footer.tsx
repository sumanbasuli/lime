import Image from "next/image";
import { siteConfig, withBasePath } from "@/lib/site";

const footerLinks = [
  { title: "GitHub", href: siteConfig.repoUrl },
  { title: "Releases", href: siteConfig.releasesUrl },
  { title: "Docs", href: withBasePath("/docs/") },
  { title: "API", href: withBasePath("/api/") },
  { title: "Roadmap", href: withBasePath("/roadmap/") },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-black/8 bg-[#fdfcf8]">
      <div className="site-container flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <a href={withBasePath("/")} aria-label="LIME home">
            <Image
              src={withBasePath("/brand/lime.svg")}
              alt="LIME"
              width={92}
              height={40}
              className="h-7 w-auto"
            />
          </a>
          <span className="text-[11px] text-black/45">
            Self-hosted accessibility scanner · GPL-2.0
          </span>
        </div>
        <nav className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Footer navigation">
          {footerLinks.map((item) => (
            <a
              key={item.title}
              href={item.href}
              className="text-[11px] text-black/55 no-underline transition-colors hover:text-black"
            >
              {item.title}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
