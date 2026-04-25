"use client";

import { MenuIcon } from "lucide-react";
import { useState } from "react";
import { navigationGroups } from "@/content/navigation";
import { assetPath, withBasePath } from "@/lib/site";
import { Button } from "@/components/ui/button";

export function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <div className="lg:hidden">
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Open navigation"
        onClick={() => setOpen(true)}
      >
        <MenuIcon className="size-4" />
      </Button>
      {open ? (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm">
          <div className="h-full w-[min(86vw,340px)] overflow-y-auto border-r bg-background p-4 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <a href={withBasePath("/")} className="flex items-center no-underline">
                <img src={assetPath("/brand/lime.svg")} alt="LIME" className="h-10 w-auto" />
              </a>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
            <nav className="space-y-5">
              {navigationGroups.map((group) => (
                <div key={group.title}>
                  <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {group.title}
                  </div>
                  <div className="space-y-1">
                    {group.items.map((item) => (
                      <a
                        key={item.href}
                        href={withBasePath(item.href)}
                        className="block rounded-xl px-3 py-2 text-sm text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground"
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
