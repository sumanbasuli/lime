"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

interface ActiveScansRefreshProps {
  enabled: boolean;
}

export function ActiveScansRefresh({ enabled }: ActiveScansRefreshProps) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const interval = setInterval(() => {
      router.refresh();
    }, 3000);

    return () => clearInterval(interval);
  }, [enabled, router]);

  return null;
}
