"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2Icon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  deleteScan,
  isTerminalScanStatus,
  rescanScan,
  type Scan,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface ScanActionsProps {
  scanId: string;
  status: Scan["status"];
  redirectOnDelete?: string;
  size?: "sm" | "default";
  className?: string;
}

export function ScanActions({
  scanId,
  status,
  redirectOnDelete,
  size = "sm",
  className,
}: ScanActionsProps) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<"rescan" | "delete" | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  if (!isTerminalScanStatus(status)) {
    return null;
  }

  const isBusy = pendingAction !== null;

  const handleRescan = async () => {
    setPendingAction("rescan");
    setError(null);

    try {
      const nextScan = await rescanScan(scanId);
      startTransition(() => {
        router.push(`/scans/${nextScan.id}`);
        router.refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rescan");
      setPendingAction(null);
    }
  };

  const handleDelete = async () => {
    const confirmed = window.confirm(
      "Delete this scan and its saved results? This cannot be undone."
    );
    if (!confirmed) {
      return;
    }

    setPendingAction("delete");
    setError(null);

    try {
      await deleteScan(scanId);
      startTransition(() => {
        if (redirectOnDelete) {
          router.push(redirectOnDelete);
          return;
        }
        router.refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete scan");
      setPendingAction(null);
    }
  };

  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size={size}
          disabled={isBusy}
          onClick={handleRescan}
        >
          {pendingAction === "rescan" ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <RefreshCwIcon />
          )}
          Rescan
        </Button>
        <Button
          type="button"
          variant="destructive"
          size={size}
          disabled={isBusy}
          onClick={handleDelete}
        >
          {pendingAction === "delete" ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <Trash2Icon />
          )}
          Delete
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
