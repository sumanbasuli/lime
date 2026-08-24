import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader, type SiteSection } from "@/components/site-header";

export function SiteShell({
  children,
  active = "product",
}: {
  children: ReactNode;
  active?: SiteSection;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader active={active} />
      <div className="flex-1">{children}</div>
      <SiteFooter />
    </div>
  );
}
