"use client";

import type { ComponentProps } from "react";
import { useState } from "react";
import {
  ChevronRightIcon,
  GithubIcon,
  RocketIcon,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { navigationGroups } from "@/content/navigation";
import { assetPath, siteConfig, withBasePath } from "@/lib/site";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";

function normalizePath(path: string) {
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }

  return path;
}

function isCurrentPath(pathname: string, href: string) {
  const current = normalizePath(pathname);
  const target = normalizePath(href);

  if (target === "/") {
    return current === "/";
  }

  return current === target || current.startsWith(`${target}/`);
}

export function DocsSidebar(props: ComponentProps<typeof Sidebar>) {
  const pathname = usePathname();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(navigationGroups.map((group) => [group.title, true]))
  );

  function toggleGroup(title: string) {
    setOpenGroups((current) => ({
      ...current,
      [title]: !(current[title] ?? true),
    }));
  }

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="h-auto py-2 hover:bg-transparent active:bg-transparent"
              render={<a href={withBasePath("/")} />}
            >
              <img
                src={assetPath("/brand/lime.svg")}
                alt="LIME"
                className="h-10 w-auto"
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {navigationGroups.map((group) => {
              const isOpen = openGroups[group.title] ?? true;
              const isActive =
                isCurrentPath(pathname, group.href) ||
                group.items.some((item) => isCurrentPath(pathname, item.href));

              return (
              <SidebarMenuItem key={group.title}>
                <SidebarMenuButton
                  isActive={isActive}
                  render={
                    <a
                      href={withBasePath(group.href)}
                      className="font-medium"
                    />
                  }
                >
                  <span>{group.title}</span>
                </SidebarMenuButton>
                <SidebarMenuAction
                  type="button"
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? "Collapse" : "Expand"} ${group.title}`}
                  onClick={() => toggleGroup(group.title)}
                >
                  <ChevronRightIcon
                    className={`transition-transform ${
                      isOpen ? "rotate-90" : ""
                    }`}
                  />
                </SidebarMenuAction>
                {isOpen && group.items.length ? (
                  <SidebarMenuSub>
                    {group.items.map((item) => (
                      <SidebarMenuSubItem key={item.href}>
                        <SidebarMenuSubButton
                          isActive={isCurrentPath(pathname, item.href)}
                          render={<a href={withBasePath(item.href)} />}
                        >
                          <span>{item.title}</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                ) : null}
              </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href={siteConfig.repoUrl} />}>
              <GithubIcon />
              <span>GitHub repository</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href={siteConfig.releasesUrl} />}>
              <RocketIcon />
              <span>Latest release</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
