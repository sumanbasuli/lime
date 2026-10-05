"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MaterialSymbol } from "@/components/material-symbol";
import { SidebarTrigger } from "@/components/ui/sidebar";

function getBreadcrumb(pathname: string): string {
  if (pathname === "/") return "Overview";
  if (pathname === "/scans") return "All scans";
  if (pathname === "/scans/new") return "New scan";
  if (/^\/scans\/[^/]+\/issues$/.test(pathname)) return "Scans · Issues";
  if (/^\/scans\/[^/]+$/.test(pathname)) return "Scans · Scan details";
  if (pathname === "/links") return "Link checker";
  if (pathname === "/settings") return "Settings";
  return "Workspace";
}

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = query.trim();
    router.push(value ? `/scans?q=${encodeURIComponent(value)}` : "/scans");
  };

  return (
    <header className="sticky top-0 z-20 flex min-h-16 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-black/8 bg-[#F4F3EE]/90 px-4 py-3 backdrop-blur-md sm:px-6 lg:px-7">
      <SidebarTrigger className="size-8 rounded-lg md:hidden" />

      <div className="flex min-w-0 items-center gap-1.5 text-xs text-black/50 sm:text-[13px]">
        <Link href="/" className="font-semibold text-black hover:text-[#1E7A4E]">
          LIME
        </Link>
        <MaterialSymbol name="chevron_right" size={15} className="text-black/30" />
        <span className="truncate">{getBreadcrumb(pathname)}</span>
      </div>

      <div className="flex-1" />

      <form onSubmit={handleSubmit} className="relative order-last w-full lg:order-none lg:w-60">
        <label htmlFor="app-search" className="sr-only">
          Search scans
        </label>
        <MaterialSymbol name="search" size={17} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-black/35" />
        <input
          ref={searchRef}
          id="app-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search scans…"
          className="h-9 w-full rounded-full border border-black/10 bg-white pr-11 pl-10 text-xs outline-none transition focus:border-black/30 focus:ring-2 focus:ring-black/10 lg:pr-12"
        />
        <button
          type="submit"
          aria-label="Search scans"
          className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-black/50 transition-colors hover:bg-black/5 hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black lg:hidden"
        >
          <MaterialSymbol name="arrow_forward" size={17} />
        </button>
        <span className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded bg-black/5 px-1.5 py-0.5 text-[10px] font-semibold text-black/45 lg:block">
          ⌘K
        </span>
      </form>

      <Link href="/scans/new" className="lime-pill-button h-9 px-4 text-xs sm:text-[13px]">
        <MaterialSymbol name="add" size={18} />
        <span className="hidden sm:inline">New scan</span>
        <span className="sm:hidden">New</span>
      </Link>
    </header>
  );
}
