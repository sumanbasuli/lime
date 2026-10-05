import type { ReactNode } from "react";
import type { LinkCheck, LinkCheckStats, LinkCheckStatus, LinkTargetStatus } from "@/lib/api";
import { BootstrapIcon, type BootstrapIconName } from "@/components/bootstrap-icon";

export const linkCheckButtonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-black/12 bg-white px-4 text-xs font-semibold transition-colors hover:bg-black hover:text-[#FFED00] disabled:cursor-wait disabled:opacity-50";

export function LinkCheckStatusBadge({ status }: { status: LinkCheckStatus }) {
  const active = status === "queued" || status === "running";
  const styles = active ? "bg-[#FFED00] text-black" : status === "completed" ? "bg-[#E7F2EA] text-[#1E7A4E]" : status === "failed" ? "bg-[#F8E8E9] text-[#8F2D31]" : "bg-black/5 text-black/65";
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold capitalize ${styles}`}>
    <span className={status === "running" ? "animate-spin" : undefined}><BootstrapIcon name={active ? "arrow-clockwise" : status === "completed" ? "check-circle" : status === "cancelled" ? "stop-circle" : "exclamation-triangle"} size={12} /></span>
    {status}
  </span>;
}

export function LinkTargetBadge({ status, timeout = false }: { status: LinkTargetStatus; timeout?: boolean }) {
  const labels: Record<LinkTargetStatus, string> = { healthy: "Healthy", redirected: "Redirected", broken: "Broken", error: "Error", blocked: "Blocked", unchecked: "Unchecked" };
  const styles = status === "broken" || status === "error" ? "bg-[#F8E8E9] text-[#8F2D31]" : status === "healthy" ? "bg-[#E7F2EA] text-[#1E7A4E]" : status === "redirected" ? "bg-[#FFED00] text-black" : "bg-black/5 text-black/65";
  const icon: BootstrapIconName = timeout ? "clock" : status === "healthy" ? "check-circle" : status === "redirected" ? "arrow-up-right" : status === "blocked" ? "shield-lock" : status === "unchecked" ? "clock" : "exclamation-triangle";
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${styles}`}><BootstrapIcon name={icon} size={12} />{timeout ? "Timeout" : labels[status]}</span>;
}

export function LinkUrl({ url, children, className = "" }: { url: string; children?: ReactNode; className?: string }) {
  let isHttp = false;
  try { isHttp = ["http:", "https:"].includes(new URL(url).protocol); } catch { /* Invalid targets remain readable, not actionable links. */ }
  return isHttp ? <a href={url} target="_blank" rel="noopener noreferrer" className={`[overflow-wrap:anywhere] underline decoration-black/20 underline-offset-4 hover:decoration-black ${className}`}>{children ?? url}</a> : <span className={`[overflow-wrap:anywhere] ${className}`}>{children ?? url}</span>;
}

export function LinkCheckSummaryCards({ checks = [], stats, scope }: { checks?: LinkCheck[]; stats?: LinkCheckStats; scope?: string }) {
  const summary = stats ? { broken: stats.broken_links, checked: stats.links_checked, redirected: stats.redirected_links, timeout: stats.timeouts } : checks.reduce((total, check) => ({
    broken: total.broken + check.summary.broken,
    checked: total.checked + check.links_checked,
    redirected: total.redirected + check.summary.redirected,
    timeout: total.timeout + check.summary.timeout,
  }), { broken: 0, checked: 0, redirected: 0, timeout: 0 });
  return <section aria-label="Link checker summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    {([
      { label: "Broken links", icon: "exclamation-triangle" as const, value: summary.broken, help: "HTTP failures, excluding access and rate limits", dark: true },
      { label: "Links checked", icon: "link-45deg" as const, value: summary.checked, help: "Unique targets with a saved outcome" },
      { label: "Redirected links", icon: "arrow-up-right" as const, value: summary.redirected, help: "Targets that required one or more hops" },
      { label: "Timeouts", icon: "clock" as const, value: summary.timeout, help: "Inconclusive: no response before the deadline" },
    ]).map((card) => <article key={card.label} className={card.dark ? "rounded-[20px] border border-black bg-black p-5 text-white" : "lime-card p-5"}>
      <div className="flex items-center justify-between gap-2"><p className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${card.dark ? "text-white/55" : "text-black/55"}`}>{card.label}</p><BootstrapIcon name={card.icon} size={17} className={card.dark ? "text-[#FFED00]" : "text-black/40"} /></div>
      <p className={`mt-3 font-heading text-[42px] font-semibold leading-none ${card.dark ? "text-[#FFED00]" : ""}`}>{card.value}</p>
      <p className={`mt-3 text-[11px] leading-5 ${card.dark ? "text-white/60" : "text-muted-foreground"}`}>{card.help}{scope ? ` · ${scope}` : ""}</p>
    </article>)}
  </section>;
}

export function LinkCheckCoverage({ check }: { check: LinkCheck }) {
  const incomplete = check.truncated || check.pages_failed > 0 || check.summary.unchecked > 0 || check.status === "cancelled" || check.status === "failed";
  return <div className={`rounded-xl border p-3 text-xs leading-5 ${incomplete ? "border-[#8F2D31]/15 bg-[#F8E8E9]/50 text-[#6F2428]" : "border-black/10 bg-[#FBFAF6] text-muted-foreground"}`}>
    {check.pages_checked} source page{check.pages_checked === 1 ? "" : "s"} checked; {check.links_checked} of {check.total_links} discovered targets checked.
    {check.pages_failed > 0 ? ` ${check.pages_failed} source page${check.pages_failed === 1 ? "" : "s"} could not be read.` : ""}
    {check.truncated ? " Coverage is partial: some source content or discovered references could not be fully inspected. Review source-page failures and configured limits." : ""}
    {check.summary.unchecked > 0 ? ` ${check.summary.unchecked} target${check.summary.unchecked === 1 ? " remains" : "s remain"} unchecked.` : ""}
    {incomplete ? " These results do not establish that every link works." : " Link outcomes reflect this check’s time, network, and accessible HTML only."}
  </div>;
}

export function LinkCheckPagination({ offset, limit, total, hasMore, loading, onPage }: { offset: number; limit: number; total: number; hasMore: boolean; loading: boolean; onPage: (offset: number) => void }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 border-t border-black/8 pt-4">
    <p className="text-xs text-muted-foreground">{total === 0 ? "0 results" : `${offset + 1}–${Math.min(offset + limit, total)} of ${total}`}</p>
    {total > limit || offset > 0 ? <div className="flex max-w-full flex-wrap gap-2">
      <button type="button" className={linkCheckButtonClass} disabled={loading || offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}><BootstrapIcon name="chevron-left" size={14} />Previous</button>
      <button type="button" className={linkCheckButtonClass} disabled={loading || !hasMore} onClick={() => onPage(offset + limit)}>Next<BootstrapIcon name="chevron-right" size={14} /></button>
    </div> : null}
  </div>;
}
