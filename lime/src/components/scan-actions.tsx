"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  deleteScan,
  isTerminalScanStatus,
  pauseScan,
  resumeScan,
  rescanScan,
  type Scan,
} from "@/lib/api";
import { cn } from "@/lib/utils";

interface ScanActionsProps {
  scanId: string;
  status: Scan["status"];
  pauseRequested?: boolean;
  isPartialScan?: boolean;
  redirectOnDelete?: string;
  size?: "sm" | "default";
  className?: string;
}

export function ScanActions({
  scanId,
  status,
  pauseRequested = false,
  isPartialScan = false,
  redirectOnDelete,
  size = "sm",
  className,
}: ScanActionsProps) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<
    "pause" | "resume" | "rescan" | "delete" | null
  >(null);
  const [pauseRequestedOverride, setPauseRequestedOverride] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBusy = pendingAction !== null;
  const isTerminal = isTerminalScanStatus(status);
  const isPaused = status === "paused";
  const isPauseRequested = pauseRequested || pauseRequestedOverride;

  const handlePause = async () => {
    setPendingAction("pause");
    setError(null);

    try {
      const scan = await pauseScan(scanId);
      setPauseRequestedOverride(scan.pause_requested);
      setPendingAction(null);
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to pause scan");
      setPendingAction(null);
    }
  };

  const handleResume = async () => {
    setPendingAction("resume");
    setError(null);
    setPauseRequestedOverride(false);

    try {
      await resumeScan(scanId);
      setPendingAction(null);
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume scan");
      setPendingAction(null);
    }
  };

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
        {!isTerminal ? (
          <Button
            type="button"
            variant="outline"
            size={size}
            disabled={isBusy || isPauseRequested}
            onClick={handlePause}
          >
            {pendingAction === "pause" || isPauseRequested ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <PauseIcon />
            )}
            {isPauseRequested ? "Pausing..." : "Pause"}
          </Button>
        ) : isPaused ? (
          <>
            <Button
              type="button"
              variant="outline"
              size={size}
              disabled={isBusy}
              onClick={handleResume}
            >
              {pendingAction === "resume" ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <PlayIcon />
              )}
              Resume
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
          </>
        ) : (
          <>
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
              {isPartialScan ? "Full rescan" : "Rescan"}
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
          </>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
