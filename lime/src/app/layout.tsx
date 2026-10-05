import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { AppHeader } from "@/components/app-header";

export const metadata: Metadata = {
  title: "LIME - Accessibility Scanner",
  description: "Scan websites for accessibility issues",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="antialiased" suppressHydrationWarning>
        <a
          href="#main-content"
          className="fixed top-3 left-3 z-[100] -translate-y-20 rounded-full bg-black px-4 py-2 text-sm font-semibold text-white transition-transform focus:translate-y-0 print:hidden"
        >
          Skip to content
        </a>
        <TooltipProvider>
          <SidebarProvider
            className="bg-[#F4F3EE]"
            style={{ "--sidebar-width": "15.625rem" } as React.CSSProperties}
          >
            <AppSidebar />
            <SidebarInset className="min-w-0 bg-[#F4F3EE]">
              <AppHeader />
              <main
                id="main-content"
                tabIndex={-1}
                className="flex flex-1 flex-col px-4 py-6 sm:px-6 lg:px-7 lg:py-7"
              >
                {children}
              </main>
            </SidebarInset>
          </SidebarProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
