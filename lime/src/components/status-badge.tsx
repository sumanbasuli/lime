"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  AggregatedAuditStatus,
  ScanScoreSummary,
} from "@/lib/scan-scoring";
import { getAccessibilityScoreBand, getDisplayScanStatus } from "@/lib/scan-scoring";
import { MaterialSymbol } from "@/components/material-symbol";

const statusConfig: Record<
  string,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    className?: string;
  }
> = {
  pending: { label: "Pending", variant: "secondary", className: "text-black/60" },
  profiling: { label: "Profiling", variant: "outline", className: "border-black/25 bg-white" },
  scanning: { label: "Scanning", variant: "outline", className: "border-black/25 bg-white" },
  processing: { label: "Processing", variant: "outline", className: "border-black/25 bg-white" },
  paused: { label: "Paused", variant: "secondary", className: "text-black/60" },
  completed: { label: "Completed", variant: "default", className: "bg-black text-white" },
  failed: { label: "Failed", variant: "outline", className: "border-[#8F2D31] bg-white text-[#8F2D31]" },
  partial: {
    label: "Partial scan",
    variant: "outline",
    className: "border-[#0A0A0A] bg-[#FFED00] text-[#0A0A0A]",
  },
};

const severityConfig: Record<
  string,
  { label: string; className: string }
> = {
  critical: { label: "Critical", className: "border-[#9E3035] bg-[#9E3035] text-white" },
  serious: { label: "Serious", className: "border-black bg-black text-white" },
  moderate: { label: "Moderate", className: "border-black bg-[#FFED00] text-black" },
  minor: { label: "Minor", className: "border-black/18 bg-white text-black" },
};

export function StatusBadge({
  status,
  summary,
  className,
}: {
  status: string;
  summary?: Pick<ScanScoreSummary, "isPartialScan">;
  className?: string;
}) {
  const displayStatus = getDisplayScanStatus(status, summary);
  const config = statusConfig[displayStatus] || {
    label: status,
    variant: "secondary" as const,
  };
  const isActive = ["pending", "profiling", "scanning", "processing"].includes(
    displayStatus
  );
  const dotClassName =
    displayStatus === "failed"
      ? "bg-[#8F2D31]"
      : displayStatus === "paused"
        ? "bg-black/35"
        : displayStatus === "partial"
          ? "bg-black"
          : "bg-[#FFED00]";

  return (
    <Badge
      variant={config.variant}
      className={cn(
        "gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
        config.className,
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          dotClassName,
          isActive && "animate-pulse border border-black/30"
        )}
      />
      {config.label}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  const config = severityConfig[severity] || {
    label: severity,
    className: "border-black/15 bg-white text-black",
  };
  return (
    <Badge
      variant="outline"
      className={cn("rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em]", config.className)}
    >
      {config.label}
    </Badge>
  );
}

export function ScanTypeBadge({ scanType }: { scanType: string }) {
  if (scanType === "single") {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-black/60">
        <MaterialSymbol name="description" size={15} />
        Page
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-black/60">
      <MaterialSymbol name="language" size={15} />
      Sitemap
    </span>
  );
}

export function TagBadge({ tag }: { tag: string }) {
  return (
    <Badge variant="secondary" className="rounded-full px-3 text-[11px] font-semibold text-black/65">
      {tag}
    </Badge>
  );
}

function scanScoreToneClass(score: number): string {
  const band = getAccessibilityScoreBand(score);

  if (band.tone === "green") {
    return "border-[#1E7A4E] bg-white text-[#1E7A4E]";
  }
  if (band.tone === "yellow") {
    return "border-[#0A0A0A] bg-[#FFED00] text-[#0A0A0A]";
  }

  return "border-[#8F2D31] bg-white text-[#8F2D31]";
}

export function ScanScoreBadge({
  status,
  summary,
  className,
}: {
  status: string;
  summary: ScanScoreSummary;
  className?: string;
}) {
  if (summary.hasScore && summary.score !== null) {
    return (
      <Badge
        variant="outline"
          className={cn(
            "gap-2 rounded-full border px-2.5 py-1 text-[11px] font-semibold shadow-sm",
            scanScoreToneClass(summary.score),
            className
          )}
      >
        <span>
          {summary.score}
          <span className="ml-0.5 opacity-70">/100</span>
        </span>
      </Badge>
    );
  }

  if (summary.isPartialScan) {
    return (
      <Badge
        variant="outline"
        className={cn(
          "rounded-full border-[#0A0A0A] bg-[#FFED00] text-[#0A0A0A]",
          className
        )}
      >
        Partial
      </Badge>
    );
  }

  if (status !== "completed" && status !== "paused" && status !== "failed") {
    return (
      <Badge
        variant="outline"
        className={cn(
          "rounded-full border-black/15 bg-white text-[#0A0A0A]",
          className
        )}
      >
        In progress
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full border-black/15 bg-white text-[#0A0A0A]/70",
        className
      )}
    >
      —
    </Badge>
  );
}

const auditStatusConfig: Record<
  AggregatedAuditStatus,
  { label: string; className: string }
> = {
  failed: {
    label: "Failed",
    className: "border-[#8F2D31] bg-white text-[#8F2D31]",
  },
  excluded: {
    label: "Excluded",
    className: "border-black/15 bg-white text-[#0A0A0A]/80",
  },
  needs_review: {
    label: "Needs review",
    className: "border-[#0A0A0A] bg-[#FFED00] text-[#0A0A0A]",
  },
  passed: {
    label: "Passed",
    className: "border-[#1E7A4E] bg-white text-[#1E7A4E]",
  },
  not_applicable: {
    label: "Not applicable",
    className: "border-black/15 bg-white text-[#0A0A0A]/80",
  },
};

export function AuditStatusBadge({
  status,
  className,
}: {
  status: AggregatedAuditStatus;
  className?: string;
}) {
  const config = auditStatusConfig[status];

  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] font-semibold",
        config.className,
        className
      )}
    >
      {config.label}
    </Badge>
  );
}
