"use client";

import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useRouter } from "next/navigation";
import { MaterialSymbol } from "@/components/material-symbol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  markIssueFalsePositive,
  unmarkIssueFalsePositive,
} from "@/lib/api";

interface IssueFalsePositiveButtonProps {
  scanId: string;
  issueId: string;
  isFalsePositive: boolean;
  className?: string;
  onFalsePositiveChange?: (issueId: string, isFalsePositive: boolean) => void;
}

export function IssueFalsePositiveButton({
  scanId,
  issueId,
  isFalsePositive,
  className,
  onFalsePositiveChange,
}: IssueFalsePositiveButtonProps) {
  const router = useRouter();
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [localIsFalsePositive, setLocalIsFalsePositive] =
    useState(isFalsePositive);
  const [isPending, setIsPending] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocalIsFalsePositive(isFalsePositive);
  }, [isFalsePositive]);

  useEffect(() => {
    const issueCard = containerRef.current?.closest<HTMLElement>("[data-issue-card]");
    if (!issueCard) {
      return;
    }

    issueCard.dataset.falsePositive = localIsFalsePositive ? "true" : "false";
  }, [localIsFalsePositive]);

  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
    };
  }, []);

  const handleClick = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current);
      successTimeoutRef.current = null;
    }

    setIsPending(true);
    setShowSuccess(false);
    setError(null);

    try {
      if (localIsFalsePositive) {
        await unmarkIssueFalsePositive(scanId, issueId);
      } else {
        await markIssueFalsePositive(scanId, issueId);
      }

      const nextIsFalsePositive = !localIsFalsePositive;
      setLocalIsFalsePositive(nextIsFalsePositive);
      onFalsePositiveChange?.(issueId, nextIsFalsePositive);
      setIsPending(false);
      setShowSuccess(true);

      successTimeoutRef.current = setTimeout(() => {
        setShowSuccess(false);
      }, 900);

      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update issue state"
      );
      setIsPending(false);
    }
  };

  return (
    <div
      ref={containerRef}
      className={cn("flex shrink-0 flex-col items-end gap-1", className)}
    >
      <Button
        type="button"
        variant={localIsFalsePositive ? "secondary" : "outline"}
        size="sm"
        className="rounded-full px-3"
        disabled={isPending}
        onClick={handleClick}
      >
        {isPending ? (
          <MaterialSymbol name="progress_activity" size={15} className="animate-spin" />
        ) : showSuccess ? (
          <MaterialSymbol name="check" size={15} />
        ) : (
          <MaterialSymbol name="flag" size={15} />
        )}
        {localIsFalsePositive
          ? "Unmark false positive"
          : "Mark false positive"}
      </Button>
      {error && (
        <p className="max-w-40 text-right text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
