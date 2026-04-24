"use client"

import * as React from "react"
import Link from "next/link"

import { NavMain } from "@/components/nav-main"
import { NavSecondary } from "@/components/nav-secondary"
import { UpdateNotice } from "@/components/update-notice"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  LayoutDashboardIcon,
  ScanSearchIcon,
  Settings2Icon,
  HeartPulseIcon,
  BookOpenIcon,
} from "lucide-react"

const data = {
  navMain: [
    {
      title: "Dashboard",
      url: "/",
      icon: <LayoutDashboardIcon />,
    },
    {
      title: "Scans",
      url: "/scans",
      icon: <ScanSearchIcon />,
      items: [
        {
          title: "All Scans",
          url: "/scans",
        },
        {
          title: "New Scan",
          url: "/scans/new",
        },
      ],
    },
    {
      title: "Settings",
      url: "/settings",
      icon: <Settings2Icon />,
    },
  ],
  navSecondary: [
    {
      title: "API Health",
      url: "/api/health",
      icon: <HeartPulseIcon />,
    },
    {
      title: "Docs",
      url: "#",
      icon: <BookOpenIcon />,
    },
  ],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="h-auto py-1 hover:bg-transparent active:bg-transparent" render={<Link href="/" />}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo.svg"
                alt="LIME"
                className="h-10 w-auto"
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={data.navMain} />
        <div className="mt-auto">
          <UpdateNotice />
          <NavSecondary items={data.navSecondary} />
        </div>
      </SidebarContent>
    </Sidebar>
  )
}
