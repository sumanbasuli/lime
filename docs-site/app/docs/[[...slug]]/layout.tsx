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
        <div className="min-h-screen p-2">
          <div className="min-h-[calc(100vh-1rem)] rounded-3xl border bg-background shadow-sm">
            <header className="sticky top-2 z-20 flex h-16 items-center justify-between gap-3 rounded-t-3xl border-b bg-background/85 px-4 backdrop-blur-xl md:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <SidebarTrigger />
                <Separator
                  orientation="vertical"
                  className="data-vertical:h-4"
                />
                <DocsBreadcrumb />
              </div>
              <div className="flex items-center gap-2">
                <DocsSearch entries={searchEntries} />
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
      </SidebarInset>
    </SidebarProvider>
  );
}
