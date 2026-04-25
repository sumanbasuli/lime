import {
  BookOpenIcon,
  Code2Icon,
  GithubIcon,
  HomeIcon,
  ImagesIcon,
  RocketIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { navigationGroups } from "@/content/navigation";
import { assetPath, siteConfig, withBasePath } from "@/lib/site";
import { Separator } from "@/components/ui/separator";

const iconByTitle: Record<string, ReactNode> = {
  Overview: <HomeIcon className="size-4" />,
  "Docs Home": <BookOpenIcon className="size-4" />,
  Screenshots: <ImagesIcon className="size-4" />,
  "API Reference": <Code2Icon className="size-4" />,
};

export function DocsSidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 flex-col bg-sidebar p-2 text-sidebar-foreground lg:flex">
      <div className="flex h-full flex-col rounded-2xl border bg-background/70 shadow-sm">
        <a
          href={withBasePath("/")}
          className="flex items-center px-4 py-4 no-underline"
        >
          <img src={assetPath("/brand/lime.svg")} alt="LIME" className="h-12 w-auto" />
        </a>
        <Separator />
        <nav className="flex-1 space-y-5 overflow-y-auto p-3">
          {navigationGroups.map((group) => (
            <div key={group.title}>
              <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {group.title}
              </div>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <a
                    key={item.href}
                    href={withBasePath(item.href)}
                    className="group flex items-start gap-2 rounded-xl px-2 py-2 text-sm text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <span className="mt-0.5 text-foreground/80">
                      {iconByTitle[item.title] ?? <span className="block size-4 rounded-full border" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium leading-5">{item.title}</span>
                      {item.description ? (
                        <span className="mt-0.5 line-clamp-2 block text-xs leading-4 text-muted-foreground">
                          {item.description}
                        </span>
                      ) : null}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="space-y-1 p-3">
          <a
            href={siteConfig.repoUrl}
            className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground"
          >
            <GithubIcon className="size-4" />
            GitHub repository
          </a>
          <a
            href={siteConfig.releasesUrl}
            className="flex items-center gap-2 rounded-xl px-2 py-2 text-sm text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground"
          >
            <RocketIcon className="size-4" />
            Latest release
          </a>
        </div>
      </div>
    </aside>
  );
}
