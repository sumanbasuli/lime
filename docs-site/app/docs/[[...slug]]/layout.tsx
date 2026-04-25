import type { ReactNode } from "react";
import { DocsSidebar } from "@/components/docs-sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { Button } from "@/components/ui/button";
import { assetPath, siteConfig, withBasePath } from "@/lib/site";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <DocsSidebar />
      <div className="min-h-screen lg:pl-72">
        <div className="min-h-screen p-2">
          <div className="min-h-[calc(100vh-1rem)] rounded-3xl border bg-background shadow-sm">
            <header className="sticky top-2 z-20 flex h-16 items-center justify-between gap-3 rounded-t-3xl border-b bg-background/85 px-4 backdrop-blur-xl md:px-6">
              <div className="flex items-center gap-3">
                <MobileNav />
                <a
                  href={withBasePath("/docs/")}
                  className="hidden items-center no-underline sm:inline-flex"
                >
                  <img src={assetPath("/brand/lime.svg")} alt="LIME" className="h-9 w-auto" />
                </a>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" asChild>
                  <a href={withBasePath("/")}>Product</a>
                </Button>
                <Button variant="lime" size="sm" asChild>
                  <a href={siteConfig.releasesUrl}>Download</a>
                </Button>
              </div>
            </header>
            {children}
          </div>
        </div>
      </div>
    </>
  );
}
