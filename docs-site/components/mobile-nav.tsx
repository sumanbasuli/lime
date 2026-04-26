"use client";

import { MenuIcon } from "lucide-react";
import { useState } from "react";
import { navigationGroups } from "@/content/navigation";
import { assetPath, siteConfig, withBasePath } from "@/lib/site";
import { Button } from "@/components/ui/button";

const primaryLinks = [
  { title: "Docs", href: "/docs/" },
  { title: "Screenshots", href: "/screenshots/" },
  { title: "API", href: "/api/" },
  { title: "Roadmap", href: "/roadmap/" },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label="Open navigation"
        onClick={() => setOpen(true)}
      >
        <MenuIcon className="size-4" />
      </Button>
      {open ? (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm">
          <div className="h-full w-[min(90vw,360px)] overflow-y-auto border-r bg-background p-4 shadow-xl">
            <div className="mb-5 flex items-center justify-between">
              <a href={withBasePath("/")} className="flex items-center no-underline">
                <img src={assetPath("/brand/lime.svg")} alt="LIME" className="h-9 w-auto" />
              </a>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
            <nav className="space-y-6">
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Site
                </div>
                <div className="grid gap-1">
                  {primaryLinks.map((item) => (
                    <a
                      key={item.href}
                      href={withBasePath(item.href)}
                      className="block rounded-xl px-3 py-2.5 text-sm font-medium no-underline hover:bg-accent hover:text-accent-foreground"
                      onClick={() => setOpen(false)}
                    >
                      {item.title}
                    </a>
                  ))}
                  <a
                    href={siteConfig.releasesUrl}
                    className="mt-1 block rounded-xl border border-black/10 bg-[#FFED00] px-3 py-2.5 text-sm font-semibold text-black no-underline"
                    onClick={() => setOpen(false)}
                  >
                    Download latest release
                  </a>
                </div>
              </div>
              {navigationGroups.map((group) => (
                <div key={group.title}>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {group.title}
                  </div>
                  <div className="space-y-1">
                    <a
                      href={withBasePath(group.href)}
                      className="block rounded-xl px-3 py-2 text-sm font-medium no-underline hover:bg-accent hover:text-accent-foreground"
                      onClick={() => setOpen(false)}
                    >
                      {group.title} overview
                    </a>
                    {group.items.map((item) => (
                      <a
                        key={item.href}
                        href={withBasePath(item.href)}
                        className="block rounded-xl px-3 py-2 text-sm text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground"
                        onClick={() => setOpen(false)}
                      >
                        {item.title}
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </div>
        </div>
      ) : null}
    </div>
  );
}
