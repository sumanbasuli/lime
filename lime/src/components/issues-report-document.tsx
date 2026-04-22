/* eslint-disable @next/next/no-img-element */

import { formatViewportLabel } from "@/lib/viewport-presets";
import {
  getAccessibilityScoreBand,
  getLighthouseAccessibilityWeight,
} from "@/lib/scan-scoring";
import type {
  IssueReportData,
  ReportIssueGroup,
  ReportOccurrence,
} from "@/lib/issues-report-data";
import type { ACTRule, AccessibilityReference } from "@/lib/act-rules";

const reportStyles = `
  @page {
    size: A4;
    margin: 14mm;
  }

  :root {
    color-scheme: light;
    --report-black: #101010;
    --report-paper: #fcfcf8;
    --report-ink-soft: rgba(16, 16, 16, 0.72);
    --report-line: rgba(16, 16, 16, 0.14);
    --report-lime: #ffed00;
    --report-green: #0e5a4a;
    --report-red: #8f2d31;
    --report-gold: #c18800;
    --report-card: #ffffff;
    --report-muted: #f2f0e8;
  }

  * {
    box-sizing: border-box;
  }

  html, body {
    margin: 0;
    padding: 0;
    background: var(--report-paper);
    color: var(--report-black);
    font-family: "Helvetica Neue", Arial, sans-serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  body {
    line-height: 1.45;
  }

  body:has([data-report-page="true"]) {
    background: var(--report-paper);
  }

  body:has([data-report-page="true"]) [data-slot="sidebar"],
  body:has([data-report-page="true"]) [data-slot="sidebar-gap"],
  body:has([data-report-page="true"]) [data-slot="sidebar-container"] {
    display: none !important;
  }

  body:has([data-report-page="true"]) [data-slot="sidebar-wrapper"] {
    display: block;
    min-height: auto;
    background: transparent;
  }

  body:has([data-report-page="true"]) [data-slot="sidebar-inset"] {
    display: block;
    min-height: auto;
    margin: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    background: transparent !important;
  }

  body:has([data-report-page="true"]) [data-slot="sidebar-inset"] > header {
    display: none !important;
  }

  body:has([data-report-page="true"]) [data-slot="sidebar-inset"] > main {
    display: block;
    padding: 0 !important;
  }

  .report-root {
    width: 100%;
  }

  .cover-page {
    min-height: 260mm;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 18mm;
    page-break-after: always;
    break-after: page;
    background:
      radial-gradient(circle at top right, rgba(255, 237, 0, 0.28), transparent 34%),
      linear-gradient(180deg, #fffef6 0%, #f7f6ef 100%);
    border: 1px solid var(--report-line);
    border-radius: 18px;
    padding: 16mm;
  }

  .cover-brand {
    display: flex;
    flex-direction: column;
    gap: 7mm;
  }

  .cover-logo {
    width: 86mm;
    height: auto;
  }

  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: fit-content;
    border-radius: 999px;
    border: 1px solid rgba(16, 16, 16, 0.12);
    background: rgba(255, 255, 255, 0.88);
    padding: 7px 12px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .cover-title {
    max-width: 170mm;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 28px;
    line-height: 1.02;
    font-weight: 700;
    margin: 0;
  }

  .cover-subtitle {
    max-width: 150mm;
    margin: 0;
    font-size: 14px;
    line-height: 1.6;
    color: var(--report-ink-soft);
  }

  .cover-site-info {
    width: 100%;
    border-top: 1px solid var(--report-line);
    padding-top: 10mm;
  }

  .summary-card,
  .section-intro,
  .issue-card,
  .occurrence-card,
  .guidance-card {
    border: 1px solid var(--report-line);
    border-radius: 16px;
    background: var(--report-card);
  }

  .summary-card {
    box-shadow: 0 14px 30px rgba(16, 16, 16, 0.05);
  }

  .detail-list {
    margin: 14px 0 0;
    display: grid;
    gap: 10px;
  }

  .detail-row {
    display: grid;
    grid-template-columns: 34mm minmax(0, 1fr);
    gap: 10px;
    align-items: start;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--report-line);
  }

  .detail-row:last-child {
    padding-bottom: 0;
    border-bottom: 0;
  }

  .detail-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--report-ink-soft);
  }

  .detail-value {
    font-size: 13px;
    line-height: 1.55;
    font-weight: 600;
    word-break: break-word;
  }

  .toc-page {
    min-height: 260mm;
    justify-content: flex-start;
    break-after: page;
    page-break-after: always;
  }

  .toc-title,
  .section-title,
  .summary-title {
    margin: 0;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 22px;
    line-height: 1.1;
  }

  .toc-list {
    margin: 10mm 0 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 16px;
  }

  .toc-item {
    display: block;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--report-line);
  }

  .toc-item:last-child {
    padding-bottom: 0;
    border-bottom: 0;
  }

  .toc-link {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 10px;
    align-items: end;
    color: inherit;
    text-decoration: none;
  }

  .toc-link:hover {
    text-decoration: none;
  }

  .toc-item-title {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 20px;
    line-height: 1.2;
    font-weight: 700;
  }

  .toc-item-leader {
    border-bottom: 1px dotted rgba(16, 16, 16, 0.35);
    transform: translateY(-5px);
  }

  .toc-item-action {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--report-ink-soft);
  }

  .toc-item-copy {
    margin: 6px 0 0 0;
    max-width: 150mm;
    font-size: 12px;
    color: var(--report-ink-soft);
  }

  .page {
    display: block;
    margin-bottom: 10mm;
  }

  .page > * + * {
    margin-top: 10mm;
  }

  .page-break-before {
    break-before: page;
    page-break-before: always;
  }

  .summary-hero {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    gap: 10mm;
    align-items: stretch;
  }

  .score-panel {
    padding: 18px;
    background:
      linear-gradient(135deg, rgba(255, 237, 0, 0.96), rgba(255, 255, 255, 0.94)),
      var(--report-card);
  }

  .score-eyebrow,
  .section-kicker {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--report-ink-soft);
    margin-bottom: 8px;
  }

  .score-row {
    display: flex;
    align-items: end;
    gap: 12px;
    flex-wrap: wrap;
  }

  .score-number {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 62px;
    line-height: 0.9;
    font-weight: 700;
  }

  .score-out-of {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--report-ink-soft);
    margin-bottom: 8px;
  }

  .pill-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    padding: 6px 11px;
    border: 1px solid rgba(16, 16, 16, 0.12);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    background: white;
  }

  .pill-green {
    border-color: rgba(14, 90, 74, 0.25);
    color: var(--report-green);
  }

  .pill-yellow {
    border-color: rgba(16, 16, 16, 0.18);
    background: var(--report-lime);
  }

  .pill-red {
    border-color: rgba(143, 45, 49, 0.25);
    color: var(--report-red);
  }

  .pill-neutral {
    color: var(--report-black);
  }

  .score-copy {
    margin: 14px 0 0;
    font-size: 13px;
    color: rgba(16, 16, 16, 0.85);
  }

  .severity-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .severity-card {
    padding: 14px;
    min-height: 102px;
  }

  .severity-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--report-ink-soft);
  }

  .severity-value {
    margin-top: 10px;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 40px;
    line-height: 0.95;
    font-weight: 700;
  }

  .severity-copy {
    margin-top: 8px;
    font-size: 12px;
    color: var(--report-ink-soft);
  }

  .severity-critical {
    background: linear-gradient(180deg, rgba(143, 45, 49, 0.12), #ffffff);
  }

  .severity-serious {
    background: linear-gradient(180deg, rgba(16, 16, 16, 0.08), #ffffff);
  }

  .severity-moderate {
    background: linear-gradient(180deg, rgba(255, 237, 0, 0.26), #ffffff);
  }

  .severity-minor,
  .severity-review,
  .severity-excluded {
    background: linear-gradient(180deg, rgba(16, 16, 16, 0.03), #ffffff);
  }

  .section-header {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 12px;
  }

  .section-copy {
    max-width: 140mm;
    margin: 8px 0 0;
    color: var(--report-ink-soft);
    font-size: 13px;
  }

  .issue-list {
    display: block;
  }

  .issue-list > * {
    break-before: page;
    page-break-before: always;
  }

  .issue-card {
    overflow: visible;
    break-inside: auto;
    page-break-inside: auto;
    border: 0;
    border-top: 1.5px solid rgba(16, 16, 16, 0.22);
    border-radius: 0;
    background: transparent;
    padding-top: 5mm;
  }

  .issue-card-header {
    padding: 0 0 5mm;
    border-bottom: 1px solid var(--report-line);
    background: transparent;
  }

  .issue-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0 0;
  }

  .issue-kicker {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--report-ink-soft);
  }

  .issue-title {
    margin: 10px 0 0;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 26px;
    line-height: 1.18;
  }

  .issue-title a {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px solid transparent;
  }

  .issue-title a:hover {
    border-bottom-color: currentColor;
  }

  .issue-description {
    margin: 10px 0 0;
    font-size: 13px;
    color: var(--report-ink-soft);
  }

  .issue-card-body {
    padding: 6mm 0 0;
    display: block;
  }

  .issue-card-body > * + * {
    margin-top: 12px;
  }

  .callout {
    border-radius: 14px;
    border: 1px solid rgba(14, 90, 74, 0.15);
    background: rgba(231, 255, 246, 0.92);
    padding: 14px 16px;
  }

  .callout-title {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 16px;
    line-height: 1.15;
    margin: 0 0 8px;
  }

  .callout-copy {
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
  }

  .guidance-grid {
    display: block;
  }

  .guidance-card {
    padding: 14px 15px;
    break-inside: auto;
    page-break-inside: auto;
  }

  .guidance-grid > * + * {
    margin-top: 10px;
  }

  .guidance-header {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-bottom: 10px;
  }

  .guidance-title {
    margin: 0;
    font-size: 15px;
    line-height: 1.25;
    font-weight: 700;
  }

  .guidance-title a {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px solid transparent;
  }

  .guidance-title a:hover {
    border-bottom-color: currentColor;
  }

  .guidance-body {
    display: grid;
    gap: 8px;
    font-size: 12.5px;
    color: rgba(16, 16, 16, 0.88);
  }

  .guidance-body p {
    margin: 0;
  }

  .requirements {
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    margin-top: 10px;
  }

  .requirement-card {
    border-radius: 12px;
    border: 1px solid var(--report-line);
    background: var(--report-muted);
    padding: 9px 10px;
  }

  .requirement-title {
    font-size: 11px;
    font-weight: 700;
    line-height: 1.4;
  }

  .requirement-copy {
    font-size: 10px;
    color: var(--report-ink-soft);
    margin-top: 4px;
  }

  .occurrence-list {
    display: block;
  }

  .occurrence-list > * + * {
    margin-top: 10px;
  }

  .occurrence-card {
    padding: 14px 15px;
    break-inside: auto;
    page-break-inside: auto;
  }

  .occurrence-meta {
    display: grid;
    gap: 8px;
  }

  .occurrence-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--report-ink-soft);
  }

  .occurrence-link {
    color: var(--report-green);
    font-size: 12px;
    text-decoration: none;
    word-break: break-word;
  }

  .occurrence-link:hover {
    text-decoration: underline;
  }

  .selector-text {
    font-size: 11px;
    color: var(--report-ink-soft);
    word-break: break-word;
  }

  .selector-text code {
    border-radius: 999px;
    background: var(--report-muted);
    padding: 2px 8px;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 11px;
    color: var(--report-black);
  }

  .code-block {
    margin: 0;
    border-radius: 14px;
    background: #111111;
    color: #f8f8f2;
    padding: 12px 14px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 11px;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  .occurrence-media-grid {
    display: block;
    margin-top: 10px;
  }

  .media-card {
    border-radius: 14px;
    border: 1px solid var(--report-line);
    background: var(--report-muted);
    padding: 10px;
    display: grid;
    gap: 8px;
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .occurrence-media-grid > * + * {
    margin-top: 10px;
  }

  .media-card img {
    width: 100%;
    max-height: 105mm;
    object-fit: contain;
    object-position: center;
    border-radius: 10px;
    background: #ffffff;
    border: 1px solid rgba(16, 16, 16, 0.08);
  }

  .small-copy {
    font-size: 11px;
    color: var(--report-ink-soft);
    margin: 0;
  }

  .footer-note {
    margin-top: 6mm;
    font-size: 10px;
    color: var(--report-ink-soft);
    text-align: right;
  }

  @media print {
    .cover-page,
    .summary-card,
    .guidance-card,
    .occurrence-card,
    .issue-card {
      box-shadow: none !important;
    }

    .issue-card-header {
      break-after: avoid-page;
      page-break-after: avoid;
    }
  }
`;

function extractHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

function formatScanType(scanType: string): string {
  return scanType === "single" ? "Single page scan" : "Sitemap scan";
}

function buildSuggestedChangesSummary(suggestedFixes: string[]): string | null {
  const prioritizedFixes = Array.from(
    new Set(
      suggestedFixes
        .map((suggestedFix) => suggestedFix.trim())
        .filter(Boolean)
        .filter(
          (suggestedFix) =>
            !suggestedFix.startsWith("Avoid failing patterns like:") &&
            !suggestedFix.startsWith(
              "Use the ACT passing pattern as a reference:"
            ) &&
            !suggestedFix.startsWith("Meet the ACT expectation:")
        )
    )
  );

  const summaryFixes =
    prioritizedFixes.length > 0
      ? prioritizedFixes.slice(0, 3)
      : Array.from(new Set(suggestedFixes.filter(Boolean))).slice(0, 2);

  if (summaryFixes.length === 0) {
    return null;
  }

  return summaryFixes.join(" ");
}

function selectActionableFixes(suggestedFixes: string[], limit = 2): string[] {
  return Array.from(
    new Set(
      suggestedFixes
        .map((suggestedFix) => suggestedFix.trim())
        .filter(Boolean)
        .filter(
          (suggestedFix) =>
            !suggestedFix.startsWith("Avoid failing patterns like:") &&
            !suggestedFix.startsWith(
              "Use the ACT passing pattern as a reference:"
            ) &&
            !suggestedFix.startsWith("Meet the ACT expectation:")
        )
    )
  ).slice(0, limit);
}

function buildRuleMeaningParagraph(actRule: ACTRule): string {
  if (actRule.summary && actRule.summary !== actRule.title) {
    return actRule.summary;
  }

  return `${actRule.title}.`;
}

function buildRuleActionParagraph(actRule: ACTRule): string | null {
  const actionableFixes = selectActionableFixes(actRule.suggestedFixes);
  if (actionableFixes.length === 0) {
    return null;
  }

  return actionableFixes.join(" ");
}

function normalizeComparisonText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldShowRuleDescription(
  title: string,
  ruleDescription: string | null
): ruleDescription is string {
  if (!ruleDescription) {
    return false;
  }

  return normalizeComparisonText(title) !== normalizeComparisonText(ruleDescription);
}

function elementScreenshotUrl(path: string): string {
  const parts = path.replace(/^\/app\/screenshots\//, "").split("/");
  if (parts.length >= 2) {
    return `/api/screenshots/${parts[0]}/${parts[1]}`;
  }

  return "";
}

function occurrenceScreenshot(occ: {
  elementScreenshotPath: string | null;
}) {
  if (occ.elementScreenshotPath) {
    return {
      path: occ.elementScreenshotPath,
      label: "Focused screenshot",
    };
  }

  return null;
}

function occurrencePageCapture(occ: { screenshotPath: string | null }) {
  if (!occ.screenshotPath) {
    return null;
  }

  return {
    path: occ.screenshotPath,
    label: "Page capture",
  };
}

function formatOccurrenceLabel(count: number): string {
  return `${count} occurrence${count === 1 ? "" : "s"}`;
}

function getScoreChip(summary: IssueReportData["scoreSummary"]): {
  label: string;
  className: string;
} {
  if (summary.hasScore && summary.score !== null) {
    const band = getAccessibilityScoreBand(summary.score);
    const tone =
      band.tone === "green"
        ? "pill-green"
        : band.tone === "yellow"
          ? "pill-yellow"
          : "pill-red";

    return {
      label: summary.isPartialScan ? "Partial scan" : band.label,
      className: tone,
    };
  }

  if (summary.isPartialScan) {
    return { label: "Partial scan", className: "pill-neutral" };
  }

  return { label: "No final score", className: "pill-neutral" };
}

function getScoreCopy(data: IssueReportData): string {
  const { scoreSummary, scan, activeIssueCount } = data;
  if (scoreSummary.hasScore && scoreSummary.score !== null) {
    if (scoreSummary.isPartialScan) {
      return `The current accessibility score is based on ${scoreSummary.completedUrlCount} completed pages out of ${scoreSummary.totalUrlCount}. ${scoreSummary.failedUrlCount} pages failed during scanning, so the score reflects completed pages only until those failed pages are retried.`;
    }

    return `This report includes ${activeIssueCount} weighted failed issue groups across ${scoreSummary.completedUrlCount} completed pages.`;
  }

  if (scan.status === "paused") {
    return "This scan was paused before a final score could be calculated. The findings below reflect the latest persisted state of the scan.";
  }

  if (scan.status === "failed") {
    return "This scan failed before a final score could be calculated. The report includes any findings that were successfully persisted.";
  }

  return "No weighted accessibility score is available for this scan. The report still includes the weighted failed issue detail breakdown.";
}

function DetailList({
  items,
}: {
  items: { label: string; value: string }[];
}) {
  return (
    <dl className="detail-list">
      {items.map((item) => (
        <div key={item.label} className="detail-row">
          <dt className="detail-label">{item.label}</dt>
          <dd className="detail-value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ScorePanel({ data }: { data: IssueReportData }) {
  const { scoreSummary, scan } = data;
  const scoreChip = getScoreChip(scoreSummary);

  return (
    <section className="summary-card score-panel">
      <div className="score-eyebrow">Accessibility score</div>
      <div className="score-row">
        <div className="score-number">
          {scoreSummary.hasScore && scoreSummary.score !== null
            ? scoreSummary.score
            : "—"}
        </div>
        <div className="score-out-of">out of 100</div>
      </div>
      <div className="pill-row">
        <span className={`pill ${scoreChip.className}`}>{scoreChip.label}</span>
        <span className="pill pill-neutral">
          {scan.status === "completed"
            ? "Completed"
            : scan.status === "paused"
              ? "Paused"
              : scan.status === "failed"
                ? "Failed"
                : "In progress"}
        </span>
      </div>
      <p className="score-copy">{getScoreCopy(data)}</p>
    </section>
  );
}

function SeverityCard({
  label,
  value,
  copy,
  className,
}: {
  label: string;
  value: number;
  copy: string;
  className: string;
}) {
  return (
    <article className={`summary-card severity-card ${className}`}>
      <div className="severity-label">{label}</div>
      <div className="severity-value">{value}</div>
      <div className="severity-copy">{copy}</div>
    </article>
  );
}

function RequirementCards({
  references,
}: {
  references: AccessibilityReference[];
}) {
  if (references.length === 0) {
    return (
      <div className="requirements">
        <div className="requirement-card">
          <div className="requirement-title">No direct standards reference</div>
          <div className="requirement-copy">Supporting guidance only</div>
        </div>
      </div>
    );
  }

  return (
    <div className="requirements">
      {references.map((reference) => (
        <div key={reference.id} className="requirement-card">
          <div className="requirement-title">{reference.title}</div>
          <div className="requirement-copy">
            {reference.forConformance ? "Required" : "Supporting"}
          </div>
        </div>
      ))}
    </div>
  );
}

function ActGuidanceCard({
  actRule,
  complianceReferences,
}: {
  actRule: ACTRule;
  complianceReferences: AccessibilityReference[];
}) {
  const actionParagraph = buildRuleActionParagraph(actRule);

  return (
    <article className="guidance-card">
      <div className="guidance-header">
        <span className="pill pill-yellow">{actRule.actRuleId}</span>
        <span className="pill pill-neutral">{actRule.status}</span>
      </div>
      <h3 className="guidance-title">
        <a href={actRule.ruleUrl}>{actRule.title}</a>
      </h3>
      <div className="guidance-body">
        <p>
          <strong>What this means:</strong> {buildRuleMeaningParagraph(actRule)}
        </p>
        {actionParagraph && (
          <p>
            <strong>What to do:</strong> {actionParagraph}
          </p>
        )}
      </div>
      <RequirementCards references={complianceReferences} />
    </article>
  );
}

function AxeGuidanceCard({
  title,
  helpUrl,
  description,
  references,
}: {
  title: string;
  helpUrl: string | null;
  description: string | null;
  references: AccessibilityReference[];
}) {
  return (
    <article className="guidance-card">
      <div className="guidance-header">
        <span className="pill pill-neutral">axe-core</span>
      </div>
      <h3 className="guidance-title">
        {helpUrl ? <a href={helpUrl}>{title}</a> : title}
      </h3>
      <div className="guidance-body">
        <p>
          <strong>What this means:</strong> {description || title}
        </p>
        <p>
          <strong>What to review:</strong> Compare the affected elements below with
          the expected accessible pattern and the linked documentation.
        </p>
      </div>
      <RequirementCards references={references} />
    </article>
  );
}

function GuidanceSection({
  title,
  helpUrl,
  ruleDescription,
  actRules,
  complianceReferences,
}: {
  title: string;
  helpUrl: string | null;
  ruleDescription: string | null;
  actRules: ACTRule[];
  complianceReferences: AccessibilityReference[];
}) {
  if (actRules.length > 0) {
    return (
      <section className="guidance-grid">
        {actRules.map((actRule) => (
          <ActGuidanceCard
            key={actRule.actRuleId}
            actRule={actRule}
            complianceReferences={complianceReferences}
          />
        ))}
      </section>
    );
  }

  return (
    <section className="guidance-grid" style={{ gridTemplateColumns: "1fr" }}>
      <AxeGuidanceCard
        title={title}
        helpUrl={helpUrl}
        description={ruleDescription}
        references={complianceReferences}
      />
    </section>
  );
}

function OccurrenceSection({
  occurrences,
}: {
  occurrences: ReportOccurrence[];
}) {
  return (
    <section className="occurrence-list">
      {occurrences.map((occurrence) => {
        const screenshot = occurrenceScreenshot(occurrence);
        const pageCapture = occurrencePageCapture(occurrence);

        return (
          <article key={occurrence.id} className="occurrence-card">
            <div className="occurrence-meta">
              <div>
                <div className="occurrence-label">URL</div>
                <a href={occurrence.pageUrl} className="occurrence-link">
                  {occurrence.pageUrl}
                </a>
              </div>
              {occurrence.cssSelector && (
                <div className="selector-text">
                  Selector: <code>{occurrence.cssSelector}</code>
                </div>
              )}
            </div>

            {occurrence.htmlSnippet && (
              <div style={{ marginTop: "10px" }}>
                <div className="occurrence-label" style={{ marginBottom: "6px" }}>
                  HTML snippet
                </div>
                <pre className="code-block">{occurrence.htmlSnippet}</pre>
              </div>
            )}

            {(screenshot || pageCapture) && (
              <div className="occurrence-media-grid">
                {screenshot && (
                  <div className="media-card">
                    <div className="occurrence-label">{screenshot.label}</div>
                    <img
                      src={elementScreenshotUrl(screenshot.path)}
                      alt={screenshot.label}
                    />
                  </div>
                )}
                {pageCapture && !screenshot && (
                  <div className="media-card">
                    <div className="occurrence-label">{pageCapture.label}</div>
                    <img
                      src={elementScreenshotUrl(pageCapture.path)}
                      alt={pageCapture.label}
                    />
                  </div>
                )}
              </div>
            )}

            {!occurrence.htmlSnippet && !screenshot && !pageCapture && (
              <p className="small-copy" style={{ marginTop: "10px" }}>
                No stored element context was available for this occurrence.
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}

function FailedIssueCard({ issueGroup }: { issueGroup: ReportIssueGroup }) {
  const { issue, occurrences, complianceReferences, axeRuleDescription } = issueGroup;
  const suggestedChangesSummary = buildSuggestedChangesSummary(issue.suggestedFixes);
  const weight = getLighthouseAccessibilityWeight(issue.violationType);

  return (
    <article className="issue-card">
      <header className="issue-card-header">
        <div className="section-kicker">Expanded findings</div>
        <div className="issue-kicker">Failed check</div>
        <h3 className="issue-title">
          {issue.helpUrl ? <a href={issue.helpUrl}>{issue.description}</a> : issue.description}
        </h3>
        {shouldShowRuleDescription(issue.description, axeRuleDescription) && (
          <p className="issue-description">{axeRuleDescription}</p>
        )}
        <div className="issue-badges">
          <span className="pill pill-neutral">{issue.severity}</span>
          {weight > 0 ? (
            <span className="pill pill-neutral">Weight {weight}</span>
          ) : (
            <span className="pill pill-neutral">Not scored</span>
          )}
          <span className="pill pill-neutral">
            {formatOccurrenceLabel(occurrences.length)}
          </span>
        </div>
      </header>

      <div className="issue-card-body">
        {suggestedChangesSummary && (
          <section className="callout">
            <h4 className="callout-title">Suggested changes</h4>
            <p className="callout-copy">{suggestedChangesSummary}</p>
          </section>
        )}

        <section>
          <div className="section-kicker">Standards and guidance</div>
          <GuidanceSection
            title={issue.description}
            helpUrl={issue.helpUrl}
            ruleDescription={axeRuleDescription}
            actRules={issue.actRules}
            complianceReferences={complianceReferences}
          />
        </section>

        <section>
          <div className="section-kicker">Affected elements</div>
          <OccurrenceSection occurrences={occurrences} />
        </section>
      </div>
    </article>
  );
}

function CoverPage({ data }: { data: IssueReportData }) {
  const { scan, totalIssueCardCount } = data;
  const siteInfoItems = [
    { label: "Target URL", value: scan.sitemapUrl },
    { label: "Scan type", value: formatScanType(scan.scanType) },
    {
      label: "Viewport",
      value: formatViewportLabel(
        scan.viewportPreset,
        scan.viewportWidth,
        scan.viewportHeight
      ),
    },
    { label: "Issues in report", value: String(totalIssueCardCount) },
  ];

  return (
    <section className="cover-page">
      <div className="cover-brand">
        <img src="/logo.png" alt="Lime logo" className="cover-logo" />
        <div className="eyebrow">Accessibility issue report</div>
        <h1 className="cover-title">
          {extractHost(scan.sitemapUrl)} accessibility findings
        </h1>
        <p className="cover-subtitle">
          A printable, expanded record of every weighted failed issue captured by
          Lime for this scan.
        </p>
      </div>

      <section className="cover-site-info">
        <h2 className="summary-title">Site information</h2>
        <DetailList items={siteInfoItems} />
      </section>
    </section>
  );
}

function TableOfContentsPage({ data }: { data: IssueReportData }) {
  const tocItems = [
    {
      title: "Accessibility score and severity breakdown",
      copy: "Weighted score, current score band, and severity counts for the issues in this report.",
      href: "#accessibility-summary",
    },
    {
      title: "Failed checks",
      copy: `${data.activeIssueCount} weighted failed issue groups included in this report.`,
      href: "#failed-checks",
    },
  ];

  return (
    <section className="page toc-page">
      <div>
        <div className="section-kicker">Contents</div>
        <h2 className="toc-title">Table of contents</h2>
        <p className="section-copy">
          Use the linked entries below to jump to the main sections in supported
          PDF viewers.
        </p>
      </div>

      <ol className="toc-list">
        {tocItems.map((item) => (
          <li key={item.href} className="toc-item">
            <a href={item.href} className="toc-link">
              <span className="toc-item-title">{item.title}</span>
              <span className="toc-item-leader" aria-hidden="true" />
              <span className="toc-item-action">Jump</span>
            </a>
            <p className="toc-item-copy">{item.copy}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function IssuesReportDocument({ data }: { data: IssueReportData }) {
  const scoreBand =
    data.scoreSummary.hasScore && data.scoreSummary.score !== null
      ? getAccessibilityScoreBand(data.scoreSummary.score)
      : null;

  return (
    <div data-report-page="true" data-report-ready="true">
      <style>{reportStyles}</style>
      <main className="report-root" aria-label={`Lime issue report for ${extractHost(data.scan.sitemapUrl)}`}>
        <CoverPage data={data} />
        <TableOfContentsPage data={data} />

        <section id="accessibility-summary" className="page">
          <div className="section-header">
            <div>
              <div className="section-kicker">Executive summary</div>
              <h2 className="section-title">Accessibility score and severity breakdown</h2>
              <p className="section-copy">
                This summary combines the weighted accessibility score, coverage
                information, and the current distribution of issue severities.
              </p>
            </div>
          </div>

          <ScorePanel data={data} />

          <div className="severity-grid">
            <SeverityCard
              label="Critical"
              value={data.severityBreakdown.critical}
              copy="Highest-severity blockers."
              className="severity-critical"
            />
            <SeverityCard
              label="Serious"
              value={data.severityBreakdown.serious}
              copy="Major accessibility barriers."
              className="severity-serious"
            />
            <SeverityCard
              label="Moderate"
              value={data.severityBreakdown.moderate}
              copy="Material issues that still need remediation."
              className="severity-moderate"
            />
            <SeverityCard
              label="Minor"
              value={data.severityBreakdown.minor}
              copy="Lower-severity quality issues."
              className="severity-minor"
            />
          </div>

          <div className="footer-note">
            {scoreBand
              ? `Overall score band: ${scoreBand.label}`
              : "Overall score band unavailable"}
          </div>
        </section>

        {data.issuesWithOccurrences.length > 0 ? (
          <div id="failed-checks" className="issue-list">
            {data.issuesWithOccurrences.map((issueGroup) => (
              <FailedIssueCard
                key={issueGroup.issue.id}
                issueGroup={issueGroup}
              />
            ))}
          </div>
        ) : (
          <section id="failed-checks" className="page page-break-before">
            <div className="section-header">
              <div>
                <div className="section-kicker">Expanded findings</div>
                <h2 className="section-title">Failed checks</h2>
                <p className="section-copy">
                  No weighted failed checks were stored for this scan.
                </p>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
