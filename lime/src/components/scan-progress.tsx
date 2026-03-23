"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { getScan } from "@/lib/api";

interface ScanProgressProps {
  scanId: string;
  status: string;
}

/**
 * Client component that polls the API for scan progress updates.
 * When the scan status changes, it calls router.refresh() to update
 * the Server Component data. Auto-stops when scan is completed or failed.
 */
export function ScanProgress({ scanId, status }: ScanProgressProps) {
  const router = useRouter();
  const lastStatusRef = useRef(status);

  useEffect(() => {
    // Don't poll if the scan is already done
    if (status === "completed" || status === "failed") {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const scan = await getScan(scanId);
        // If status or progress changed, refresh the page data
        if (scan.status !== lastStatusRef.current) {
          lastStatusRef.current = scan.status;
          router.refresh();
        }
        // Also refresh if scanned_urls changed (progress update)
        router.refresh();

        // Stop polling when done
        if (scan.status === "completed" || scan.status === "failed") {
          clearInterval(interval);
        }
      } catch {
        // Silently ignore polling errors
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [scanId, status, router]);

  return null; // This component renders nothing, just polls
}
