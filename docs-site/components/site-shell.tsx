import type { ReactNode } from "react";
import { assetPath, siteConfig, withBasePath } from "@/lib/site";
import { Button } from "@/components/ui/button";

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen p-2">
      <div className="min-h-[calc(100vh-1rem)] rounded-3xl border bg-background shadow-sm">
        <header className="sticky top-2 z-20 flex h-16 items-center justify-between gap-3 rounded-t-3xl border-b bg-background/85 px-4 backdrop-blur-xl md:px-6">
          <a href={withBasePath("/")} className="flex items-center no-underline">
            <img src={assetPath("/brand/lime.svg")} alt="LIME" className="h-10 w-auto" />
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
          <Button variant="lime" size="sm" asChild>
            <a href={siteConfig.releasesUrl}>Download</a>
          </Button>
        </header>
        {children}
      </div>
    </div>
  );
}
