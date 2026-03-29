import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { scans, issues, issueOccurrences, urls } from "@/db/schema";
import { eq } from "drizzle-orm";
import { SeverityBadge } from "@/components/status-badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { IssueFalsePositiveButton } from "@/components/issue-false-positive-button";
import { IssueScreenshotLightbox } from "@/components/issue-screenshot-lightbox";
import { CodeSnippet } from "@/components/code-snippet";
import {
  enrichIssueWithACT,
  mergeAccessibilityReferences,
  normalizeACTAccessibilityRequirements,
  resolveAxeRuleContext,
  type ACTRule,
  type AccessibilityReference,
} from "@/lib/act-rules";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";

export const dynamic = "force-dynamic";

interface IssuesPageProps {
  params: Promise<{ id: string }>;
}

const alternativeACTRulePairs = new Set(["09o5cg:afw4f7"]);

function actStatusBadgeVariant(
  status: ACTRule["status"]
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "approved":
      return "default";
    case "proposed":
      return "secondary";
    case "deprecated":
      return "destructive";
    default:
      return "outline";
  }
}

function formatACTStatus(status: ACTRule["status"]): string {
  if (status === "approved") {
    return "W3C Recommendation";
  }

  return status.charAt(0).toUpperCase() + status.slice(1);
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

function selectActionableFixes(
  suggestedFixes: string[],
  limit = 2
): string[] {
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

function areAlternativeACTRules(firstRule: ACTRule, secondRule: ACTRule): boolean {
  const pairKey = [firstRule.actRuleId, secondRule.actRuleId]
    .sort()
    .join(":");

  return alternativeACTRulePairs.has(pairKey);
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

function ACTRuleCard({
  actRule,
  complianceReferences,
}: {
  actRule: ACTRule;
  complianceReferences: AccessibilityReference[];
}) {
  const accessibilityReferences = mergeAccessibilityReferences(
    normalizeACTAccessibilityRequirements(actRule.accessibilityRequirements),
    complianceReferences
  );

  return (
    <article className="rounded-lg border border-black/20 bg-[#FFED00] p-3 text-[#111111]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className="border-black bg-black font-mono text-[#FFED00]"
        >
          {actRule.actRuleId}
        </Badge>
        <Badge
          variant={actStatusBadgeVariant(actRule.status)}
          className="border-black/30 bg-white text-[#111111]"
        >
          {formatACTStatus(actRule.status)}
        </Badge>
        <a
          href={actRule.ruleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-heading text-[15px] font-bold leading-tight text-[#111111] hover:underline"
        >
          {actRule.title}
          <ExternalLinkIcon className="h-3 w-3" />
        </a>
      </div>

      <div className="mt-2 space-y-2 text-sm leading-5 text-[#111111]/85">
        <p>
          <span className="mr-2 font-semibold underline decoration-black/35 underline-offset-3">
            What this means
          </span>
          {buildRuleMeaningParagraph(actRule)}
        </p>
        {buildRuleActionParagraph(actRule) && (
          <p>
            <span className="mr-2 font-semibold underline decoration-black/35 underline-offset-3">
              What to do
            </span>
            {buildRuleActionParagraph(actRule)}
          </p>
        )}
      </div>

      {accessibilityReferences.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold text-[#111111]/70">
            Accessibility requirements
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {accessibilityReferences.map((requirement) => (
              <div
                key={`${actRule.actRuleId}-${requirement.id}`}
                className="rounded-md border border-black/20 bg-white/80 px-2.5 py-2"
              >
                <p className="text-xs font-medium leading-5">
                  {requirement.title}
                </p>
                <p className="mt-1 text-[11px] text-[#111111]/70">
                  {requirement.forConformance ? "Required" : "Supporting"}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function BaseRuleGuidanceCard({
  description,
  helpUrl,
  accessibilityRequirements,
}: {
  description: string;
  helpUrl: string | null;
  accessibilityRequirements: AccessibilityReference[];
}) {
  return (
    <article className="rounded-lg border border-black/20 bg-[#FFED00] p-3 text-[#111111]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="secondary"
          className="border-black/30 bg-white text-[#111111]"
        >
          axe-core
        </Badge>
        {helpUrl ? (
          <a
            href={helpUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-heading text-[15px] font-bold leading-tight text-[#111111] hover:underline"
          >
            {description}
            <ExternalLinkIcon className="h-3 w-3" />
          </a>
        ) : (
          <h3 className="font-heading text-[15px] font-bold leading-tight text-[#111111]">
            {description}
          </h3>
        )}
      </div>

      <div className="mt-2 space-y-2 text-sm leading-5 text-[#111111]/85">
        <p>
          <span className="mr-2 font-semibold underline decoration-black/35 underline-offset-3">
            What this means
          </span>
          {description}
        </p>
        <p>
          <span className="mr-2 font-semibold underline decoration-black/35 underline-offset-3">
            What to review
          </span>
          Review the affected elements below and compare them with the linked
          guidance so the expected accessible pattern is clear in context.
        </p>
      </div>

      {accessibilityRequirements.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold text-[#111111]/70">
            Accessibility requirements
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {accessibilityRequirements.map((requirement) => (
            <div
              key={requirement.id}
              className="rounded-md border border-black/20 bg-white/80 px-2.5 py-2"
            >
              <p className="text-xs font-medium leading-5">
                {requirement.title}
              </p>
              <p className="mt-1 text-[11px] text-[#111111]/70">
                {requirement.forConformance ? "Required" : "Supporting"}
              </p>
            </div>
            ))}
          </div>
        </div>
      )}

      {accessibilityRequirements.length === 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold text-[#111111]/70">
            Accessibility requirements
          </p>
          <div className="mt-2 rounded-md border border-black/20 bg-white/80 px-2.5 py-2">
            <p className="text-xs font-medium leading-5">
              No direct standards reference
            </p>
            <p className="mt-1 text-[11px] text-[#111111]/70">
              Supporting guidance only
            </p>
          </div>
        </div>
      )}
    </article>
  );
}

function AlternativeRuleBinder() {
  return (
    <div className="flex shrink-0 items-center justify-center px-1 lg:px-0">
      <div className="flex w-full items-center gap-3 lg:h-full lg:w-16 lg:flex-col lg:justify-center">
        <div className="h-px flex-1 bg-black/20 lg:h-10 lg:w-px lg:flex-none" />
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-black/15 bg-white/85 text-[#111111] shadow-[0_12px_28px_rgba(17,17,17,0.12)] ring-4 ring-white/35 backdrop-blur-sm">
          <span className="font-heading text-sm font-bold leading-none">
            OR
          </span>
        </div>
        <div className="h-px flex-1 bg-black/20 lg:h-10 lg:w-px lg:flex-none" />
      </div>
    </div>
  );
}

function elementScreenshotUrl(path: string): string {
  // path is like /app/screenshots/{scanId}/{filename}
  // we serve via /api/screenshots/{scanId}/{filename}
  const parts = path.replace(/^\/app\/screenshots\//, "").split("/");
  if (parts.length >= 2) {
    return `/api/screenshots/${parts[0]}/${parts[1]}`;
  }
  return "";
}

function focusedPreviewPath(path: string): string {
  const extensionIndex = path.lastIndexOf(".");
  if (extensionIndex === -1) {
    return `${path}_preview`;
  }

  return `${path.slice(0, extensionIndex)}_preview${path.slice(extensionIndex)}`;
}

function occurrenceScreenshot(occ: {
  elementScreenshotPath: string | null;
}) {
  if (occ.elementScreenshotPath) {
    return {
      path: occ.elementScreenshotPath,
      label: "Screenshot",
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

export default async function IssuesPage({ params }: IssuesPageProps) {
  const { id } = await params;

  // Verify scan exists
  const [scan] = await db.select().from(scans).where(eq(scans.id, id));
  if (!scan) {
    notFound();
  }

  // Fetch all issues for this scan
  const scanIssues = await db
    .select()
    .from(issues)
    .where(eq(issues.scanId, id));

  // Build issues with occurrences
  const issuesWithOccurrences = await Promise.all(
    scanIssues.map(async (issue) => {
      const occurrences = await db
        .select({
          id: issueOccurrences.id,
          issueId: issueOccurrences.issueId,
          urlId: issueOccurrences.urlId,
          htmlSnippet: issueOccurrences.htmlSnippet,
          screenshotPath: issueOccurrences.screenshotPath,
          elementScreenshotPath: issueOccurrences.elementScreenshotPath,
          cssSelector: issueOccurrences.cssSelector,
          createdAt: issueOccurrences.createdAt,
          pageUrl: urls.url,
        })
        .from(issueOccurrences)
        .innerJoin(urls, eq(urls.id, issueOccurrences.urlId))
        .where(eq(issueOccurrences.issueId, issue.id));

      const enrichedIssue = await enrichIssueWithACT(issue);
      const axeContext = await resolveAxeRuleContext(issue.violationType);

      return {
        issue: enrichedIssue,
        occurrences,
        complianceReferences: axeContext.accessibilityRequirements,
        axeSuggestedChange: axeContext.successCriterion,
        axeRuleDescription: axeContext.ruleDescription,
      };
    })
  );

  // Sort by severity priority
  const severityOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  issuesWithOccurrences.sort(
    (a, b) =>
      (severityOrder[a.issue.severity as keyof typeof severityOrder] ?? 3) -
      (severityOrder[b.issue.severity as keyof typeof severityOrder] ?? 3)
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Link href="/scans" className="transition-colors hover:text-foreground">
          Scans
        </Link>
        <ChevronRightIcon className="h-3.5 w-3.5" />
        <Link
          href={`/scans/${id}`}
          className="truncate transition-colors hover:text-foreground"
        >
          {scan.sitemapUrl}
        </Link>
        <ChevronRightIcon className="h-3.5 w-3.5" />
        <span>Issues</span>
      </div>

      <h1 className="font-heading text-3xl font-bold leading-[0.95] sm:text-4xl">
        Issue details{" "}
        <span className="font-sans text-sm font-medium text-muted-foreground">
          ({issuesWithOccurrences.length})
        </span>
      </h1>

      {issuesWithOccurrences.length === 0 ? (
        <section className="rounded-xl border bg-card p-12 text-center text-muted-foreground">
          No issues found for this scan.
        </section>
      ) : (
        <div className="space-y-3">
          {issuesWithOccurrences.map(
            ({
              issue,
              occurrences,
              complianceReferences,
              axeSuggestedChange,
              axeRuleDescription,
            }) => {
            const suggestedChangesSummary =
              buildSuggestedChangesSummary(issue.suggestedFixes) ??
              (issue.actRules.length === 0
                ? axeSuggestedChange
                : null);
            const hasAlternativeRulePair =
              issue.actRules.length === 2 &&
              areAlternativeACTRules(issue.actRules[0], issue.actRules[1]);

            return (
              <Collapsible key={issue.id}>
                <section
                  data-issue-card
                  data-false-positive={issue.isFalsePositive ? "true" : "false"}
                  className="overflow-hidden rounded-xl border bg-card"
                >
                  <div className="relative">
                    <CollapsibleTrigger
                      aria-label={`Toggle details for ${issue.description}`}
                      className="issue-card-trigger peer absolute inset-0 rounded-xl transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />

                    <div className="issue-card-header pointer-events-none relative z-10 flex items-start gap-3 p-4 pr-36 sm:pr-40">
                      <div className="issue-expander mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-all duration-200">
                        <ChevronRightIcon className="h-4 w-4 transition-transform duration-200" />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <SeverityBadge
                            severity={issue.severity ?? "moderate"}
                          />
                          {issue.isFalsePositive && (
                            <Badge variant="secondary">False positive</Badge>
                          )}
                          <span className="text-[11px] font-medium text-muted-foreground">
                            {formatOccurrenceLabel(occurrences.length)}
                          </span>
                        </div>

                        {issue.helpUrl ? (
                          <a
                            href={issue.helpUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="pointer-events-auto mt-2 inline-flex max-w-full items-start gap-1 font-heading text-[15px] font-bold leading-tight text-foreground hover:underline"
                          >
                            <span className="issue-card-heading truncate sm:whitespace-normal">
                              {issue.description}
                            </span>
                            <ExternalLinkIcon className="mt-0.5 h-3 w-3 shrink-0" />
                          </a>
                        ) : (
                          <h2 className="issue-card-heading mt-2 font-heading text-[15px] font-bold leading-tight text-foreground">
                            {issue.description}
                          </h2>
                        )}
                        {shouldShowRuleDescription(
                          issue.description,
                          axeRuleDescription
                        ) && (
                          <p className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">
                            {axeRuleDescription}
                          </p>
                        )}

                      </div>
                    </div>

                    <IssueFalsePositiveButton
                      scanId={id}
                      issueId={issue.id}
                      isFalsePositive={issue.isFalsePositive}
                      className="absolute right-4 top-4 z-20"
                    />
                  </div>

                  <CollapsibleContent>
                    <div className="space-y-4 border-t px-4 pb-4 pt-3">
                      {suggestedChangesSummary && (
                        <section className="rounded-lg border border-[#0E5A4A]/20 bg-[#E7FFF6] p-4 text-[#0F172A]">
                          <h3 className="font-heading text-base font-bold text-[#0F172A]">
                            Suggested changes
                          </h3>
                          <p className="mt-2 text-sm leading-5 text-[#0F172A]/80">
                            {suggestedChangesSummary}
                          </p>
                        </section>
                      )}

                      {issue.actRules.length > 0 ? (
                        <section className="space-y-2">
                          {hasAlternativeRulePair ? (
                            <div className="flex flex-col items-center gap-3 lg:flex-row lg:items-stretch">
                              <div className="w-full lg:flex-1">
                                <ACTRuleCard
                                  actRule={issue.actRules[0]}
                                  complianceReferences={complianceReferences}
                                />
                              </div>
                              <AlternativeRuleBinder />
                              <div className="w-full lg:flex-1">
                                <ACTRuleCard
                                  actRule={issue.actRules[1]}
                                  complianceReferences={complianceReferences}
                                />
                              </div>
                            </div>
                          ) : (
                            <div className="grid gap-3 lg:grid-cols-2">
                              {issue.actRules.map((actRule) => (
                                <ACTRuleCard
                                  key={actRule.actRuleId}
                                  actRule={actRule}
                                  complianceReferences={complianceReferences}
                                />
                              ))}
                            </div>
                          )}
                        </section>
                      ) : (
                        <section>
                          <BaseRuleGuidanceCard
                            description={issue.description}
                            helpUrl={issue.helpUrl}
                            accessibilityRequirements={complianceReferences}
                          />
                        </section>
                      )}

                      <section className="space-y-2">
                        <h3 className="font-heading text-base font-bold">
                          Affected elements
                        </h3>

                        {occurrences.map((occ) => {
                          const screenshot = occurrenceScreenshot(occ);
                          const pageCapture = occurrencePageCapture(occ);

                          return (
                            <div
                              key={occ.id}
                              className="rounded-xl border bg-muted/30 p-3"
                            >
                            <p className="text-[11px] font-medium text-muted-foreground">
                              URL
                            </p>
                            <a
                              href={occ.pageUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-1.5 inline-flex break-all text-sm leading-5 text-primary hover:underline"
                            >
                              {occ.pageUrl}
                            </a>

                            {occ.cssSelector && (
                              <p className="mt-2 text-[11px] text-muted-foreground">
                                Selector:{" "}
                                <code className="rounded bg-muted px-1 font-mono">
                                  {occ.cssSelector}
                                </code>
                              </p>
                            )}

                            {occ.htmlSnippet && (
                              <div className="mt-2">
                                <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                                  HTML snippet
                                </p>
                                <CodeSnippet code={occ.htmlSnippet} />
                              </div>
                            )}

                            {screenshot && (
                              <div className="mt-2">
                                <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                                  {screenshot.label}
                                </p>
                                <IssueScreenshotLightbox
                                  src={elementScreenshotUrl(screenshot.path)}
                                  previewSrc={elementScreenshotUrl(
                                    focusedPreviewPath(screenshot.path)
                                  )}
                                  alt={`Screenshot of ${issue.violationType} violation`}
                                  label={`${issue.violationType} screenshot`}
                                    previewClassName="block max-h-64 w-auto max-w-full rounded-lg object-contain object-center"
                                />
                              </div>
                            )}

                            {!screenshot && pageCapture && (
                              <div className="mt-2 space-y-2">
                                <p className="text-[11px] text-muted-foreground">
                                  A focused screenshot was not available for
                                  this occurrence.
                                </p>
                                <IssueScreenshotLightbox
                                  src={elementScreenshotUrl(pageCapture.path)}
                                  alt={`Page capture for ${issue.violationType} violation`}
                                  label={pageCapture.label}
                                  triggerLabel="Open page capture"
                                />
                              </div>
                            )}
                            </div>
                          );
                        })}
                      </section>
                    </div>
                  </CollapsibleContent>
                </section>
              </Collapsible>
            );
          })}
        </div>
      )}
    </div>
  );
}
