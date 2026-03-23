import { Badge } from "@/components/ui/badge";
import { GlobeIcon, FileTextIcon, TagIcon } from "lucide-react";

const statusConfig: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  pending: { label: "Pending", variant: "secondary" },
  profiling: { label: "Profiling", variant: "outline" },
  scanning: { label: "Scanning", variant: "outline" },
  processing: { label: "Processing", variant: "outline" },
  completed: { label: "Completed", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
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

export function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] || {
    label: status,
    variant: "secondary" as const,
  };
  return <Badge variant={config.variant}>{config.label}</Badge>;
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
