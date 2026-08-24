"use client";

import { usePathname } from "next/navigation";
import { navigationGroups } from "@/content/navigation";
import { withBasePath } from "@/lib/site";
import { cn } from "@/lib/utils";

function normalizePath(path: string) {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function DocsSidebar() {
  const pathname = normalizePath(usePathname());
  const groups = navigationGroups.filter((group) => group.title !== "Product" && group.title !== "API");

  return (
    <aside className="sticky top-[68px] hidden h-[calc(100vh-68px)] overflow-y-auto border-r border-black/8 px-8 py-8 lg:block">
      <nav className="space-y-8" aria-label="Documentation navigation">
        {groups.map((group) => (
          <section key={group.title}>
            <a href={withBasePath(group.href)} className="font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-black/42 no-underline transition-colors hover:text-black">
              {group.title}
            </a>
            <div className="mt-3 space-y-0.5">
              {group.items.map((item) => {
                const href = normalizePath(withBasePath(item.href));
                const isActive = pathname === href;
                return (
                  <a
                    key={item.href}
                    href={withBasePath(item.href)}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "relative block rounded-lg py-2 pr-2 text-[13px] leading-5 text-black/60 no-underline transition-colors hover:text-black",
                      isActive && "font-semibold text-black before:absolute before:top-1/2 before:-left-3 before:size-1.5 before:-translate-y-1/2 before:bg-[#FFED00] before:ring-1 before:ring-black"
                    )}
                  >
                    {item.title}
                  </a>
                );
              })}
            </div>
          </section>
        ))}
      </nav>
    </aside>
  );
}
