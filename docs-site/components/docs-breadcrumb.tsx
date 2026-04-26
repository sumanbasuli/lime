"use client";

import { usePathname } from "next/navigation";
import { navigationGroups } from "@/content/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { withBasePath } from "@/lib/site";

function normalizePath(path: string) {
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }

  return path;
}

function titleFromPath(pathname: string) {
  const segment = pathname.split("/").filter(Boolean).at(-1);

  if (!segment) {
    return "Docs";
  }

  return segment
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function DocsBreadcrumb() {
  const pathname = normalizePath(usePathname());
  const groupMatch = navigationGroups.find(
    (group) =>
      group.href.startsWith("/docs") && normalizePath(group.href) === pathname
  );
  const itemMatch = navigationGroups
    .flatMap((group) =>
      group.items.map((item) => ({
        group: group.title,
        item,
      }))
    )
    .find(({ item }) => normalizePath(item.href) === pathname);

  const showGroup =
    itemMatch && itemMatch.group !== "Product" && itemMatch.item.href !== "/docs";
  const pageTitle = groupMatch?.title ?? itemMatch?.item.title ?? titleFromPath(pathname);

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="min-w-0 flex-nowrap text-xs md:text-sm">
        <BreadcrumbItem>
          <BreadcrumbLink render={<a href={withBasePath("/docs/")} />}>
            Docs
          </BreadcrumbLink>
        </BreadcrumbItem>
        {showGroup ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
              <span className="truncate text-muted-foreground">
                {itemMatch.group}
              </span>
            </BreadcrumbItem>
          </>
        ) : null}
        {pageTitle !== "Docs" ? (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="truncate">{pageTitle}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
