"use client";

import { useDeferredValue, useState } from "react";
import { AuditStatusBadge } from "@/components/status-badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ScanAuditResult } from "@/lib/scan-scoring";

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
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  const filteredAudits = deferredQuery
    ? audits.filter((audit) => {
        const haystack = [
          audit.title,
          audit.ruleId,
          audit.description ?? "",
          audit.status.replaceAll("_", " "),
        ]
          .join(" ")
          .toLowerCase();

        return haystack.includes(deferredQuery);
      })
    : audits;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-nowrap sm:items-center sm:justify-between">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search checks, rule ids, or statuses"
          className="h-9 max-w-md border-black/10 bg-white"
        />
        <p className="shrink-0 text-sm text-[#0A0A0A]/75">
          {filteredAudits.length} of {audits.length} checks
        </p>
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
