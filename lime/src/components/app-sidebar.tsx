"use client"

import * as React from "react"
import Link from "next/link"

import { NavMain } from "@/components/nav-main"
import { NavSecondary } from "@/components/nav-secondary"
import { UpdateNotice } from "@/components/update-notice"
import { MaterialSymbol } from "@/components/material-symbol"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarTrigger,
} from "@/components/ui/sidebar"
const data = {
  navMain: [
    {
      title: "Dashboard",
      url: "/",
      icon: <MaterialSymbol name="dashboard" size={20} />,
    },
    {
      title: "Scans",
      url: "/scans",
      icon: <MaterialSymbol name="screen_search_desktop" size={20} />,
    },
    {
      title: "Link checker",
      url: "/links",
      icon: <MaterialSymbol name="link" size={20} />,
    },
    {
      title: "New scan",
      url: "/scans/new",
      icon: <MaterialSymbol name="add_circle" size={20} />,
    },
    {
      title: "Settings",
      url: "/settings",
      icon: <MaterialSymbol name="tune" size={20} />,
    },
  ],
  navSecondary: [
    {
      title: "API — operational",
      url: "/api/health",
      icon: <span className="h-2 w-2 rounded-full bg-[#1E7A4E]" />,
    },
    {
      title: "Documentation",
      url: "https://lime.heysuman.com/docs/",
      icon: <MaterialSymbol name="menu_book" size={18} />,
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="px-3 pt-5 pb-3">
        <div className="flex min-h-10 items-center justify-between gap-2 px-1.5">
          <Link
            href="/"
            className="group-data-[collapsible=icon]:hidden"
            aria-label="LIME dashboard"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="LIME" className="h-[38px] w-auto" />
          </Link>
          <SidebarTrigger className="ml-auto size-8 rounded-lg text-black/45 hover:bg-black/5 hover:text-black" />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
        <div className="mt-auto">
          <UpdateNotice />
          <NavSecondary items={data.navSecondary} />
        </div>
      </SidebarContent>
      <SidebarFooter className="border-t border-black/8 px-3 py-3">
        <div className="flex items-center gap-2.5 overflow-hidden rounded-xl px-0.5 group-data-[collapsible=icon]:justify-center">
          <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-black text-[12px] font-bold text-[#FFED00]">
            SB
          </div>
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-[13px] font-semibold">Suman Basuli</p>
            <p className="truncate text-[11.5px] text-black/45">Self-hosted · v1.0.5</p>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
