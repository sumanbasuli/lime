"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  AggregatedAuditStatus,
  ScanScoreSummary,
} from "@/lib/scan-scoring";
import { getAccessibilityScoreBand, getDisplayScanStatus } from "@/lib/scan-scoring";
import { GlobeIcon, FileTextIcon, TagIcon } from "lucide-react";

const statusConfig: Record<
  string,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    className?: string;
  }
> = {
  pending: { label: "Pending", variant: "secondary" },
  profiling: { label: "Profiling", variant: "outline" },
  scanning: { label: "Scanning", variant: "outline" },
  processing: { label: "Processing", variant: "outline" },
  paused: { label: "Paused", variant: "secondary" },
  completed: { label: "Completed", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
  partial: {
    label: "Partial scan",
    variant: "outline",
    className: "border-[#0A0A0A] bg-[#FFED00] text-[#0A0A0A]",
  },
};

const severityConfig: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  critical: { label: "Critical", variant: "destructive" },
  serious: { label: "Serious", variant: "destructive" },
  moderate: { label: "Moderate", variant: "outline" },
  minor: { label: "Minor", variant: "secondary" },
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
  return (
    <Badge
      variant={config.variant}
      className={cn(config.className, className)}
    >
      {config.label}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  const config = severityConfig[severity] || {
    label: severity,
    variant: "secondary" as const,
  };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

export function ScanTypeBadge({ scanType }: { scanType: string }) {
  if (scanType === "single") {
    return (
      <Badge variant="outline" className="gap-1 text-xs font-normal">
        <FileTextIcon className="h-3 w-3" />
        Page
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-xs font-normal">
      <GlobeIcon className="h-3 w-3" />
      Sitemap
    </Badge>
  );
}

export function TagBadge({ tag }: { tag: string }) {
  return (
    <Badge variant="secondary" className="gap-1 text-xs font-normal">
      <TagIcon className="h-3 w-3" />
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

function scanScoreDotClass(score: number): string {
  const band = getAccessibilityScoreBand(score);

  if (band.tone === "green") {
    return "bg-[#1E7A4E]";
  }
  if (band.tone === "yellow") {
    return "bg-[#0A0A0A]";
  }

  return "bg-[#8F2D31]";
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
        <span
          className={cn("h-2 w-2 rounded-full", scanScoreDotClass(summary.score))}
        />
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
