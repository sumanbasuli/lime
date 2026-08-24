"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { MaterialSymbol } from "@/components/material-symbol"

export function NavMain({
  items,
}: {
  items: {
    title: string
    url: string
    icon: React.ReactNode
    isActive?: boolean
    items?: {
      title: string
      url: string
    }[]
  }[]
}) {
  const pathname = usePathname()
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({})

  const isCurrentPath = (url: string) => {
    if (url === "/") {
      return pathname === "/"
    }

    return pathname === url || pathname.startsWith(`${url}/`)
  }

  const activeUrl = items
    .filter((item) => isCurrentPath(item.url))
    .sort((first, second) => second.url.length - first.url.length)[0]?.url

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="sr-only">Navigation</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const isItemActive =
            item.url === activeUrl ||
            item.items?.some((subItem) => isCurrentPath(subItem.url)) ||
            false
          const hasSubItems = Boolean(item.items?.length)

          if (!hasSubItems) {
            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  tooltip={item.title}
                  isActive={isItemActive}
                  className="h-10 rounded-xl px-3 text-[13px] font-medium data-active:bg-black data-active:text-[#FFED00] data-active:hover:bg-black data-active:hover:text-[#FFED00] group-data-[collapsible=icon]:justify-center"
                  render={
                    <Link
                      href={item.url}
                      aria-current={isItemActive ? "page" : undefined}
                    />
                  }
                >
                  {item.icon}
                  <span>{item.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          }

          const hasStoredOpenState = Object.prototype.hasOwnProperty.call(
            openItems,
            item.url
          )
          const isOpen = isItemActive
            ? true
            : hasStoredOpenState
              ? openItems[item.url]
              : Boolean(item.isActive)

          return (
            <Collapsible
              key={item.title}
              open={isOpen}
              onOpenChange={(open) =>
                setOpenItems((current) => ({
                  ...current,
                  [item.url]: open,
                }))
              }
              render={<SidebarMenuItem />}
            >
              <SidebarMenuButton
                tooltip={item.title}
                isActive={isItemActive}
                render={<Link href={item.url} />}
              >
                {item.icon}
                <span>{item.title}</span>
              </SidebarMenuButton>
              {item.items?.length ? (
                <>
                  <CollapsibleTrigger
                    render={
                      <SidebarMenuAction className="aria-expanded:rotate-90" />
                    }
                  >
                    <MaterialSymbol name="chevron_right" size={18} />
                    <span className="sr-only">Toggle</span>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {item.items.map((subItem) => {
                        const isSubItemActive = isCurrentPath(subItem.url)

                        return (
                          <SidebarMenuSubItem key={subItem.title}>
                            <SidebarMenuSubButton
                              isActive={isSubItemActive}
                              render={<Link href={subItem.url} />}
                            >
                              <span>{subItem.title}</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        )
                      })}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </>
              ) : null}
            </Collapsible>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
