"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { navigationGroups } from "@/content/navigation";
import { MaterialSymbol } from "@/components/material-symbol";
import { siteConfig, withBasePath } from "@/lib/site";
import Image from "next/image";

const primaryLinks = [
  { title: "Product", href: "/" },
  { title: "Docs", href: "/docs/" },
  { title: "API", href: "/api/" },
  { title: "Screenshots", href: "/screenshots/" },
  { title: "Roadmap", href: "/roadmap/" },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      } else if (event.key === "Tab") {
        const controls = panelRef.current?.querySelectorAll<HTMLElement>("a[href], button");
        const first = controls?.[0];
        const last = controls?.[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [open]);
  const menu =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            className="fixed inset-0 z-[120] bg-[#fdfcf8] text-black"
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
                  <Image src={withBasePath("/brand/lime.svg")} alt="LIME" width={108} height={48} className="h-9 w-auto" />
                </a>
                <button
                  ref={closeRef}
                  type="button"
                  className="grid size-10 place-items-center rounded-full border border-black/15 bg-white"
                  onClick={() => setOpen(false)}
                  aria-label="Close navigation"
                >
                  <MaterialSymbol name="close" size={20} />
                </button>
              </div>
              <nav className="flex-1 overflow-y-auto px-4 py-5">
                <div className="space-y-7 pb-8">
                  <div>
                    <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-black/45">
                      Site
                    </div>
                    <div className="grid gap-1">
                      {primaryLinks.map((item) => (
                        <a
                          key={item.href}
                          href={withBasePath(item.href)}
                          className="block rounded-xl px-4 py-3 text-lg font-semibold no-underline hover:bg-black/[0.045]"
                          onClick={() => setOpen(false)}
                        >
                          {item.title}
                        </a>
                      ))}
                      <a
                        href={siteConfig.releasesUrl}
                        className="mt-2 block rounded-xl bg-black px-4 py-3 text-lg font-semibold text-white no-underline"
                        onClick={() => setOpen(false)}
                      >
                        Download latest release
                      </a>
                    </div>
                  </div>
                  {navigationGroups.map((group) => (
                    <div key={group.title}>
                      <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-black/45">
                        {group.title}
                      </div>
                      <div className="grid gap-1">
                        <a
                          href={withBasePath(group.href)}
                          className="block rounded-xl px-4 py-3 text-base font-semibold no-underline hover:bg-black/[0.045]"
                          onClick={() => setOpen(false)}
                        >
                          {group.title} overview
                        </a>
                        {group.items.map((item) => (
                          <a
                            key={item.href}
                            href={withBasePath(item.href)}
                            className="block rounded-xl px-4 py-2.5 text-sm text-black/55 no-underline hover:bg-black/[0.045] hover:text-black"
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
    <div>
      <button
        type="button"
        className="grid size-10 place-items-center rounded-full border border-black/15 bg-white"
        aria-label="Open navigation"
        onClick={() => setOpen(true)}
      >
        <MaterialSymbol name="menu" size={20} />
      </button>
      {menu}
    </div>
  );
}
