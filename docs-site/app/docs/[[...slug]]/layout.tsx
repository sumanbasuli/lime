import type { ReactNode } from "react";
import { DocsBreadcrumb } from "@/components/docs-breadcrumb";
import { DocsSearch } from "@/components/docs-search";
import { DocsSidebar } from "@/components/docs-sidebar";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getDocsSearchEntries } from "@/lib/docs-search";

export default function DocsLayout({ children }: { children: ReactNode }) {
  const searchEntries = getDocsSearchEntries();

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader active="docs" />
      <div className="grid flex-1 lg:grid-cols-[280px_minmax(0,1fr)]">
        <DocsSidebar />
        <div className="min-w-0">
          <div className="sticky top-[68px] z-30 flex h-14 items-center justify-between gap-3 border-b border-black/8 bg-[#fdfcf8]/94 px-5 backdrop-blur-xl sm:px-7 lg:px-10">
            <DocsBreadcrumb />
            <DocsSearch entries={searchEntries} />
          </div>
          {children}
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}
