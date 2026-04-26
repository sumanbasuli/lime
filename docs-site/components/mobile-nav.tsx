"use client";

import { MenuIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
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
  const menu =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-[120] bg-background text-foreground"
            role="dialog"
            aria-modal="true"
            aria-label="Mobile navigation"
          >
            <div className="flex h-dvh flex-col overflow-hidden">
              <div className="flex h-16 shrink-0 items-center justify-between border-b px-4">
                <a
                  href={withBasePath("/")}
                  className="flex items-center no-underline"
                  onClick={() => setOpen(false)}
                >
                  <img src={assetPath("/brand/lime.svg")} alt="LIME" className="h-9 w-auto" />
                </a>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation"
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
              <nav className="flex-1 overflow-y-auto px-4 py-5">
                <div className="space-y-7 pb-8">
                  <div>
                    <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      Site
                    </div>
                    <div className="grid gap-1">
                      {primaryLinks.map((item) => (
                        <a
                          key={item.href}
                          href={withBasePath(item.href)}
                          className="block rounded-2xl px-4 py-3 text-lg font-semibold no-underline hover:bg-accent hover:text-accent-foreground"
                          onClick={() => setOpen(false)}
                        >
                          {item.title}
                        </a>
                      ))}
                      <a
                        href={siteConfig.releasesUrl}
                        className="mt-2 block rounded-2xl border border-black/10 bg-[#FFED00] px-4 py-3 text-lg font-semibold text-black no-underline"
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
                      <div className="grid gap-1">
                        <a
                          href={withBasePath(group.href)}
                          className="block rounded-2xl px-4 py-3 text-base font-semibold no-underline hover:bg-accent hover:text-accent-foreground"
                          onClick={() => setOpen(false)}
                        >
                          {group.title} overview
                        </a>
                        {group.items.map((item) => (
                          <a
                            key={item.href}
                            href={withBasePath(item.href)}
                            className="block rounded-2xl px-4 py-2.5 text-sm text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground"
                            onClick={() => setOpen(false)}
                          >
                            {item.title}
                          </a>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </nav>
            </div>
          </div>,
          document.body
        )
      : null;

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
      {menu}
    </div>
  );
}
