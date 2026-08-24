"use client";

import { useState } from "react";
import { AuditStatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AggregatedAuditStatus, ScanAuditResult } from "@/lib/scan-scoring";

type AuditFilter = "all" | Exclude<AggregatedAuditStatus, "not_applicable">;

const auditFilters: { key: AuditFilter; label: string }[] = [
  { key: "all", label: "All checks" },
  { key: "failed", label: "Failed" },
  { key: "needs_review", label: "Needs review" },
  { key: "passed", label: "Passed" },
  { key: "excluded", label: "Excluded" },
];

function formatAuditCoverage(pageCounts: ScanAuditResult["pageCounts"]): string {
  const parts: string[] = [];

  if (pageCounts.failed > 0) {
    parts.push(`${pageCounts.failed} failed`);
  }
  if (pageCounts.passed > 0) {
    parts.push(`${pageCounts.passed} passed`);
  }
  if (pageCounts.incomplete > 0) {
    parts.push(`${pageCounts.incomplete} review`);
  }
  if (pageCounts.not_applicable > 0) {
    parts.push(`${pageCounts.not_applicable} n/a`);
  }

  return parts.join(", ");
}

export function AuditResultsDataTable({
  audits,
}: {
  audits: ScanAuditResult[];
}) {
  const [filter, setFilter] = useState<AuditFilter>("all");
  const filteredAudits =
    filter === "all" ? audits : audits.filter((audit) => audit.status === filter);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {auditFilters.map((item) => {
          const isActive = filter === item.key;
          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => setFilter(item.key)}
              className={`inline-flex h-9 items-center rounded-full border px-4 text-xs font-semibold transition-colors ${
                isActive
                  ? "border-black bg-black text-[#FFED00]"
                  : "border-black/10 bg-white text-black/60 hover:border-black/25 hover:text-black"
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="overflow-hidden rounded-2xl border border-black/10">
        <Table className="min-w-[960px] table-fixed">
          <colgroup>
            <col className="w-[52%]" />
            <col className="w-[11rem]" />
            <col className="w-[7rem]" />
            <col className="w-[18rem]" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-11 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0A0A0A]/75">
                Check
              </TableHead>
              <TableHead className="h-11 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0A0A0A]/75">
                Status
              </TableHead>
              <TableHead className="h-11 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0A0A0A]/75">
                Weight
              </TableHead>
              <TableHead className="h-11 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0A0A0A]/75">
                Pages
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredAudits.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-24 text-center text-sm text-[#0A0A0A]/75"
                >
                  No audit results match this filter.
                </TableCell>
              </TableRow>
            ) : (
              filteredAudits.map((audit) => {
                const coverageSummary = formatAuditCoverage(audit.pageCounts);

                return (
                <TableRow key={audit.ruleId} className="align-top">
                  <TableCell className="max-w-3xl whitespace-normal py-3">
                    <div className="space-y-1 pr-4">
                      {audit.helpUrl ? (
                        <a
                          href={audit.helpUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium leading-5 text-[#0A0A0A] hover:underline"
                        >
                          {audit.title}
                        </a>
                      ) : (
                        <p className="text-sm font-medium leading-5 text-[#0A0A0A]">
                          {audit.title}
                        </p>
                      )}
                      <p className="font-mono text-[10px] text-black/35">{audit.ruleId}</p>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-3 align-top">
                    <AuditStatusBadge status={audit.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap py-3 align-top text-sm font-medium text-[#0A0A0A]">
                    {audit.scored ? `${audit.weight} pts` : "Info"}
                  </TableCell>
                  <TableCell className="py-3 align-top text-sm text-[#0A0A0A]/80">
                    <span className="block truncate whitespace-nowrap" title={coverageSummary}>
                      {coverageSummary}
                    </span>
                  </TableCell>
                </TableRow>
              )})
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
