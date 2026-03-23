"use client";

import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, Loader2Icon } from "lucide-react";
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
}

export function IssueFalsePositiveButton({
  scanId,
  issueId,
  isFalsePositive,
  className,
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

      setLocalIsFalsePositive((current) => !current);
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
          <Loader2Icon className="animate-spin" />
        ) : showSuccess ? (
          <CheckIcon />
        ) : null}
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
