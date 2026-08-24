import Image from "next/image";
import { MaterialSymbol } from "@/components/material-symbol";
import { MobileNav } from "@/components/mobile-nav";
import { siteConfig, withBasePath } from "@/lib/site";
import { cn } from "@/lib/utils";

export type SiteSection = "product" | "docs" | "api" | "screenshots" | "roadmap";

const primaryLinks: Array<{ title: string; href: string; section: SiteSection }> = [
  { title: "Product", href: "/", section: "product" },
  { title: "Docs", href: "/docs/", section: "docs" },
  { title: "API", href: "/api/", section: "api" },
  { title: "Screenshots", href: "/screenshots/", section: "screenshots" },
  { title: "Roadmap", href: "/roadmap/", section: "roadmap" },
];

export function SiteHeader({ active = "product" }: { active?: SiteSection }) {
  return (
    <header className="sticky top-0 z-50 border-b border-black/8 bg-[#fdfcf8]/92 backdrop-blur-xl">
      <div className="site-container flex h-[68px] items-center gap-7">
        <a href={withBasePath("/")} className="flex shrink-0 items-center no-underline" aria-label="LIME home">
          <Image
            src={withBasePath("/brand/lime.svg")}
            alt="LIME"
            width={120}
            height={52}
            priority
            className="h-[34px] w-auto"
          />
        </a>

        <nav className="hidden h-full items-center gap-6 md:flex" aria-label="Primary navigation">
          {primaryLinks.map((item) => (
            <a
              key={item.href}
              href={withBasePath(item.href)}
              aria-current={active === item.section ? "page" : undefined}
              className={cn(
                "relative flex h-full items-center text-[13px] font-medium text-black/55 no-underline transition-colors hover:text-black",
                active === item.section && "font-semibold text-black after:absolute after:right-0 after:bottom-0 after:left-0 after:h-0.5 after:bg-[#FFED00]"
              )}
            >
              {item.title}
            </a>
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-2 sm:flex">
          <a
            href={siteConfig.repoUrl}
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-black/15 bg-white px-4 text-[12px] font-semibold text-black no-underline transition-colors hover:bg-black/[0.035]"
          >
            <MaterialSymbol name="star" size={16} />
            GitHub
          </a>
          <a
            href={withBasePath("/get-started/")}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-black px-4 text-[12px] font-semibold text-white no-underline transition-colors hover:bg-[#FFED00] hover:text-black"
          >
            Get started
            <MaterialSymbol name="arrow_forward" size={16} />
          </a>
        </div>

        <div className="ml-auto md:hidden">
          <MobileNav />
        </div>
      </div>
    </header>
  );
}

export { primaryLinks };
