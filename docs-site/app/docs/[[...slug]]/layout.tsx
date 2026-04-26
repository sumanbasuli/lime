import type { ReactNode } from "react";
import { DocsBreadcrumb } from "@/components/docs-breadcrumb";
import { DocsSearch } from "@/components/docs-search";
import { DocsSidebar } from "@/components/docs-sidebar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { getDocsSearchEntries } from "@/lib/docs-search";
import { siteConfig, withBasePath } from "@/lib/site";

export default function DocsLayout({ children }: { children: ReactNode }) {
  const searchEntries = getDocsSearchEntries();

  return (
    <SidebarProvider>
      <DocsSidebar />
      <SidebarInset>
        <div className="min-h-screen p-1 sm:p-2">
          <div className="min-h-[calc(100vh-0.5rem)] rounded-2xl border bg-background shadow-sm sm:min-h-[calc(100vh-1rem)] sm:rounded-3xl">
            <header className="sticky top-1 z-20 flex h-14 items-center justify-between gap-2 rounded-t-2xl border-b bg-background/90 px-2.5 backdrop-blur-xl sm:top-2 sm:h-16 sm:rounded-t-3xl sm:px-4 md:px-6">
              <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
                <SidebarTrigger />
                <Separator
                  orientation="vertical"
                  className="hidden data-vertical:h-4 sm:block"
                />
                <DocsBreadcrumb />
              </div>
              <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                <DocsSearch entries={searchEntries} />
                <Button variant="ghost" size="sm" className="hidden sm:inline-flex" asChild>
                  <a href={withBasePath("/")}>Product</a>
                </Button>
                <Button variant="lime" size="sm" className="hidden md:inline-flex" asChild>
                  <a href={siteConfig.releasesUrl}>Download</a>
                </Button>
              </div>
            </header>
            {children}
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
