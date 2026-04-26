import type { ReactNode } from "react";
import { MobileNav } from "@/components/mobile-nav";
import { assetPath, siteConfig, withBasePath } from "@/lib/site";
import { Button } from "@/components/ui/button";

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen p-1 sm:p-2">
      <div className="min-h-[calc(100vh-0.5rem)] rounded-2xl border bg-background shadow-sm sm:min-h-[calc(100vh-1rem)] sm:rounded-3xl">
        <header className="sticky top-1 z-20 flex h-14 items-center justify-between gap-2 rounded-t-2xl border-b bg-background/90 px-3 backdrop-blur-xl sm:top-2 sm:h-16 sm:rounded-t-3xl sm:px-4 md:px-6">
          <a href={withBasePath("/")} className="flex items-center no-underline">
            <img src={assetPath("/brand/lime.svg")} alt="LIME" className="h-8 w-auto sm:h-10" />
          </a>
          <nav className="hidden items-center gap-1 md:flex">
            <Button variant="ghost" size="sm" asChild>
              <a href={withBasePath("/docs/")}>Docs</a>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <a href={withBasePath("/screenshots/")}>Screenshots</a>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <a href={withBasePath("/api/")}>API</a>
            </Button>
          </nav>
          <div className="flex items-center gap-2">
            <MobileNav />
            <Button variant="lime" size="sm" className="hidden sm:inline-flex" asChild>
              <a href={siteConfig.releasesUrl}>Download</a>
            </Button>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
