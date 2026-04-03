import {
  getAccessibilityScoreBand,
  type AccessibilityScoreTone,
  type ScanScoreSummary,
} from "@/lib/scan-scoring";
import { cn } from "@/lib/utils";

const ARC_PATH = "M 24 104 A 78 78 0 0 1 180 104";
const ARC_LENGTH = Math.PI * 78;

const toneConfig: Record<
  AccessibilityScoreTone | "neutral",
  {
    chipClassName: string;
    stroke: string;
  }
> = {
  green: {
    chipClassName: "border-[#1E7A4E] bg-white text-[#1E7A4E]",
    stroke: "#1E7A4E",
  },
  yellow: {
    chipClassName: "border-[#0A0A0A] bg-[#FFED00] text-[#0A0A0A]",
    stroke: "#FFED00",
  },
  red: {
    chipClassName: "border-[#8F2D31] bg-white text-[#8F2D31]",
    stroke: "#8F2D31",
  },
  neutral: {
    chipClassName: "border-black/15 bg-white text-[#0A0A0A]",
    stroke: "#D6D6D6",
  },
};

function getGaugeLabel(summary: ScanScoreSummary, status: string): {
  chipLabel: string;
  scoreLabel: string;
  tone: AccessibilityScoreTone | "neutral";
} {
  if (summary.hasScore && summary.score !== null) {
    const band = getAccessibilityScoreBand(summary.score);
    return {
      chipLabel: summary.isPartialScan ? "Partial scan" : band.label,
      scoreLabel: String(summary.score),
      tone: band.tone,
    };
  }

  if (summary.isPartialScan) {
    return { chipLabel: "Partial", scoreLabel: "—", tone: "neutral" };
  }

  if (status === "failed") {
    return { chipLabel: "Failed", scoreLabel: "—", tone: "neutral" };
  }

  if (status !== "completed" && status !== "paused") {
    return { chipLabel: "In progress", scoreLabel: "—", tone: "neutral" };
  }

  if (!summary.hasAuditData) {
    return { chipLabel: "No data", scoreLabel: "—", tone: "neutral" };
  }

  return { chipLabel: "No score", scoreLabel: "—", tone: "neutral" };
}

export function AccessibilityScoreGauge({
  summary,
  status,
  className,
}: {
  summary: ScanScoreSummary;
  status: string;
  className?: string;
}) {
  const { chipLabel, scoreLabel, tone } = getGaugeLabel(summary, status);
  const score = summary.hasScore && summary.score !== null ? summary.score : 0;
  const filledLength = (Math.max(0, Math.min(score, 100)) / 100) * ARC_LENGTH;
  const palette = toneConfig[tone];

  return (
    <div className={cn("mx-auto w-full max-w-[240px]", className)}>
      <div className="relative">
        <svg
          viewBox="0 0 204 128"
          className="relative h-auto w-full"
          aria-hidden="true"
        >
          <path
            d={ARC_PATH}
            fill="none"
            stroke="#0A0A0A"
            strokeOpacity="0.08"
            strokeWidth="14"
            strokeLinecap="round"
          />
          <path
            d={ARC_PATH}
            fill="none"
            stroke={palette.stroke}
            strokeWidth="14"
            strokeLinecap="round"
            strokeDasharray={`${filledLength} ${ARC_LENGTH}`}
          />
        </svg>

        <div className="absolute inset-x-0 top-8 flex flex-col items-center text-center">
          <div className="font-heading text-5xl font-bold leading-none text-[#0A0A0A]">
            {scoreLabel}
          </div>
          <div className="mt-2 text-[11px] font-medium uppercase tracking-[0.14em] text-[#0A0A0A]/45">
            out of 100
          </div>
          <div
            className={cn(
              "mt-3 inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.1em]",
              palette.chipClassName
            )}
          >
            {chipLabel}
          </div>
        </div>
      </div>
    </div>
  );
}
