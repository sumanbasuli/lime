"use client"

import * as React from "react"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function NavSecondary({
  items,
  ...props
}: {
  items: {
    title: string
    url: string
    icon: React.ReactNode
  }[]
} & React.ComponentPropsWithoutRef<typeof SidebarGroup>) {
  return (
    <SidebarGroup {...props}>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                size="sm"
                className="h-9 rounded-xl px-3 text-xs text-black/60 hover:text-black group-data-[collapsible=icon]:justify-center"
                render={
                  <a
                    href={item.url}
                    target={item.url.startsWith("http") ? "_blank" : undefined}
                    rel={item.url.startsWith("http") ? "noreferrer" : undefined}
                  />
                }
              >
                {item.icon}
                <span>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
