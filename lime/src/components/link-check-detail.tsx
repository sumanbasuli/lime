"use client";

import Link from "next/link";
import { redactUrlUserinfo } from "@/lib/url-presentation";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BootstrapIcon, type BootstrapIconName } from "@/components/bootstrap-icon";
import { getLinkPresentation } from "@/lib/link-presentation";
import { LinkCheckCoverage, LinkCheckPagination, LinkCheckStatusBadge, LinkCheckSummaryCards, LinkTargetBadge, LinkUrl, linkCheckButtonClass } from "@/components/link-check-summary";
import { cancelLinkCheck, deleteLinkCheck, downloadLinkCheckCsv, getLinkCheck, getLinkCheckResults, getLinkCheckSources, isActiveLinkCheck, recheckLinks, type LinkCheck, type LinkCheckPage, type LinkSource, type LinkTarget, type LinkTargetStatus } from "@/lib/api";

const PAGE_SIZE = 20;
const targetFilters: { value: LinkTargetStatus | "all"; label: string }[] = [
  { value: "all", label: "All targets" }, { value: "broken", label: "Broken" },
  { value: "redirected", label: "Redirected" }, { value: "error", label: "Errors" },
  { value: "blocked", label: "Blocked" }, { value: "healthy", label: "Healthy" },
  { value: "unchecked", label: "Unchecked" },
];

function targetExplanation(target: LinkTarget): { title: string; detail: string; icon: BootstrapIconName } {
  if (target.status_code === 999) return { title: "Non-standard HTTP response", detail: "The server returned HTTP 999. Open this destination to verify availability manually before changing its source reference.", icon: "exclamation-triangle" };
  if (target.status === "healthy") return { title: "Destination responded successfully", detail: "A successful HTTP response was saved. This does not verify the page content or fragment anchors.", icon: "check-circle" };
  if (target.status === "redirected") return { title: "Destination has moved", detail: "The redirect reached a successful response. Review the final URL below before updating the original reference.", icon: "arrow-up-right" };
  if (target.status === "blocked") return { title: "Not checked: network policy", detail: "This destination or a redirect was outside the permitted network boundary. Blocked is not a broken-link verdict.", icon: "shield-lock" };
  if (target.status === "unchecked") return { title: "No availability verdict", detail: "The check stopped before verifying this target. Review coverage and run a fresh check with a suitable scope.", icon: "clock" };
  if (target.error_kind === "timeout") return { title: "Request timed out", detail: "No response arrived before the request deadline. Availability is inconclusive; try again later.", icon: "clock" };
  if (target.status === "error") return { title: "Availability is inconclusive", detail: target.status_code === 401 || target.status_code === 403 ? "The server requires authentication or refused access. Verify manually with the appropriate access." : target.status_code === 429 ? "The server rate-limited this request. Wait before rechecking." : "A network or redirect problem prevented a reliable result. Review the saved error below.", icon: "exclamation-triangle" };
  return { title: target.status_code === 404 ? "Destination not found" : target.status_code === 410 ? "Destination is no longer available" : "Destination returned an HTTP error", detail: target.status_code && target.status_code >= 500 ? "The server reported a failure. Check the destination and retry before changing references." : "Open the destination, then restore it or update the references shown below if the URL is incorrect.", icon: "exclamation-triangle" };
}

function elapsedTime(check: LinkCheck) {
  if (!check.completed_at) return "Not finished";
  const seconds = Math.max(0, Math.round((Date.parse(check.completed_at) - Date.parse(check.created_at)) / 1000));
  if (!Number.isFinite(seconds)) return "Unavailable";
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function TargetSources({ checkId, target }: { checkId: string; target: LinkTarget }) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<LinkCheckPage<LinkSource> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    void getLinkCheckSources(checkId, target.id, PAGE_SIZE, offset, controller.signal).then((data) => {
      if (active) { setPage(data); setError(null); }
    }).catch((err) => { if (active) setError(err instanceof Error ? err.message : "Unable to load sources"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [checkId, target.id, target.occurrence_count, offset, open, retry]);
  return <div className="mt-3">
    <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-lg px-1 text-xs font-semibold underline decoration-black/20 underline-offset-4 hover:decoration-black focus-visible:outline-2 focus-visible:outline-offset-2" aria-expanded={open} aria-controls={`sources-${target.id}`} onClick={() => { if (!open) { setLoading(true); setError(null); } setOpen(!open); }}>
      <BootstrapIcon name={open ? "chevron-up" : "chevron-down"} size={14} />{open ? "Hide sources" : "Show sources"} ({target.occurrence_count})
    </button>
    {open ? <div id={`sources-${target.id}`} className="mt-2 min-w-0 space-y-4 rounded-xl border border-black/10 bg-[#FBFAF6] p-3 sm:p-4" aria-busy={loading}>
      <div className="min-w-0 rounded-lg border border-black/8 bg-white p-3"><p className="lime-eyebrow">Destination URL</p><code className="mt-2 block whitespace-normal font-mono text-[11px] leading-5 [overflow-wrap:anywhere]">{redactUrlUserinfo(target.target_url)}</code></div>
      <div><h4 className="font-sans text-sm font-semibold">Referenced from</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">Use the source page and captured HTML context to locate each reference. Repeated occurrences are kept separately.</p></div>
      {error ? <div role="alert" className="rounded-lg bg-[#F8E8E9] p-3 text-xs text-[#8F2D31]"><p>{error}</p><p className="mt-1">This page of references could not be loaded. Previously loaded rows are hidden to avoid showing the wrong page.</p><button type="button" className={`${linkCheckButtonClass} mt-2`} onClick={() => { setLoading(true); setError(null); setRetry((value) => value + 1); }}>Retry sources</button></div> : null}
      {loading ? <p role="status" className="py-3 text-xs text-muted-foreground">Loading source references…</p> : null}
      {page && !loading && !error ? <>
        {page.items.length === 0 ? <p className="py-3 text-xs text-muted-foreground">No source references are saved for this target.</p> : <ul className="space-y-3">
          {page.items.map((source, index) => <li key={`${offset + index}-${source.page_url}`} className="min-w-0 rounded-xl border border-black/8 bg-white p-3 text-xs sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><span className="inline-flex items-center gap-2 font-semibold"><BootstrapIcon name={source.element === "page" ? "globe2" : "code-slash"} size={14} />Occurrence {offset + index + 1}</span><code className="rounded-md bg-black/5 px-2 py-1 font-mono text-[10px]">{source.element}[{source.attribute}]</code></div>
            <dl className="grid min-w-0 grid-cols-2 gap-3">
              <div className="col-span-2 min-w-0"><dt className="lime-eyebrow">Found on</dt><dd className="mt-1.5 min-w-0 font-sans text-xs leading-5"><LinkUrl url={source.page_url} /></dd></div>
              <div><dt className="lime-eyebrow">{source.element === "page" ? "Evidence type" : "Element"}</dt><dd className="mt-1.5 font-mono [overflow-wrap:anywhere]">{source.element === "page" ? "Source page request" : `<${source.element}>`}</dd></div>
              <div><dt className="lime-eyebrow">Attribute</dt><dd className="mt-1.5 font-mono [overflow-wrap:anywhere]">{source.attribute}</dd></div>
              <div className="col-span-2 min-w-0"><dt className="lime-eyebrow">Captured text</dt><dd className="mt-1.5 whitespace-pre-wrap leading-5 [overflow-wrap:anywhere]">{source.text?.trim() ? source.text : <span className="text-muted-foreground">No text captured for this reference.</span>}</dd></div>
            </dl>
            {source.element === "page" ? <p className="mt-3 border-t border-black/8 pt-3 leading-5 text-muted-foreground">This is the source-page inventory entry, not an extracted HTML link.</p> : null}
          </li>)}
        </ul>}
        <div role="group" aria-label={`Source reference pages for ${redactUrlUserinfo(target.target_url)}`}><LinkCheckPagination offset={offset} limit={PAGE_SIZE} total={page.total} hasMore={page.has_more} loading={loading} onPage={(next) => { setLoading(true); setError(null); setOffset(next); }} /></div>
      </> : null}
    </div> : null}
  </div>;
}

function TargetRow({ checkId, target }: { checkId: string; target: LinkTarget }) {
  const destination = getLinkPresentation(target.target_url, target.link_type);
  const explanation = targetExplanation(target);
  return <article className="min-w-0 overflow-hidden rounded-2xl border border-black/10 bg-white p-4 sm:p-5">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-1 items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-black/8 bg-[#F4F3EE] text-black" data-destination-icon={destination.icon}><BootstrapIcon name={destination.icon} size={20} /></span><div className="min-w-0 flex-1"><h3 className="font-sans text-sm font-semibold"><LinkUrl url={target.target_url}>{destination.label}</LinkUrl></h3><p className="mt-1 truncate font-mono text-[11px] leading-5 text-muted-foreground" title={redactUrlUserinfo(target.target_url)}>{redactUrlUserinfo(target.target_url)}</p><p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground"><span className="rounded-md bg-black/5 px-2 py-1">{target.link_type === "media" ? "Page resource" : target.link_type === "document" ? "Document" : target.link_type === "internal" ? "Internal" : "External"}</span>{target.status_code ? <span className="rounded-md bg-black/5 px-2 py-1 font-mono">HTTP {target.status_code}</span> : null}{target.redirect_count > 0 ? <span>{target.redirect_count} redirect hop{target.redirect_count === 1 ? "" : "s"}</span> : null}<span>{target.occurrence_count} reference{target.occurrence_count === 1 ? "" : "s"}</span></p></div></div>
      <div className="shrink-0"><LinkTargetBadge status={target.status} timeout={target.error_kind === "timeout"} /></div>
    </div>
    {target.status !== "healthy" ? <div className={`mt-4 flex items-start gap-2.5 rounded-xl p-3 ${target.status === "broken" || target.status === "error" ? "bg-[#F8E8E9]/65 text-[#6F2428]" : "bg-[#F4F3EE] text-black/70"}`}><BootstrapIcon name={explanation.icon} size={16} className="mt-0.5 shrink-0" /><div className="min-w-0"><p className="text-xs font-semibold">{explanation.title}</p><p className="mt-1 text-xs leading-5">{explanation.detail}</p></div></div> : null}
    {target.final_url && target.final_url !== target.target_url ? <div className="mt-3 min-w-0 rounded-xl border border-black/8 p-3"><p className="lime-eyebrow">Final destination</p><p className="mt-1.5 font-mono text-xs leading-5"><LinkUrl url={target.final_url} /></p></div> : null}
    {target.error ? <p className="mt-3 text-xs leading-5 text-[#8F2D31] [overflow-wrap:anywhere]">{target.error_kind ? `${target.error_kind.replaceAll("_", " ")}: ` : ""}{target.error}</p> : null}
    <TargetSources checkId={checkId} target={target} />
  </article>;
}

export function LinkCheckDetail({ checkId }: { checkId: string }) {
  const router = useRouter();
  const [check, setCheck] = useState<LinkCheck | null>(null);
  const [results, setResults] = useState<LinkCheckPage<LinkTarget> | null>(null);
  const [status, setStatus] = useState<LinkTargetStatus | "all">("all");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [action, setAction] = useState<"cancel" | "recheck" | "delete" | "export" | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const [job, targets] = await Promise.all([
          getLinkCheck(checkId, controller.signal),
          getLinkCheckResults(checkId, { status: status === "all" ? undefined : status, limit: PAGE_SIZE, offset }, controller.signal),
        ]);
        if (!active) return;
        setCheck(job);
        setResults(targets);
        setError(null);
        running = isActiveLinkCheck(job.status);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Unable to load link check");
      } finally {
        if (active) {
          setLoading(false);
          if (running) timer = setTimeout(load, 3000);
        }
      }
    }
    void load();
    return () => { active = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, [checkId, status, offset, retry]);

  async function runAction(nextAction: "cancel" | "recheck" | "delete" | "export") {
    if (nextAction === "delete" && !window.confirm("Delete this link check and all its saved results? This cannot be undone. The accessibility scan, if any, will be kept.")) return;
    setAction(nextAction);
    setActionError(null);
    try {
      if (nextAction === "cancel") {
        setCheck(await cancelLinkCheck(checkId));
        setRetry((value) => value + 1);
      } else if (nextAction === "recheck") {
        const newCheck = await recheckLinks(checkId);
        router.push(`/links/${newCheck.id}`);
      } else if (nextAction === "delete") {
        await deleteLinkCheck(checkId);
        router.push("/links");
      } else await downloadLinkCheckCsv(checkId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Unable to complete action");
    } finally { setAction(null); }
  }

  return <div className="mx-auto w-full max-w-[1180px] space-y-5">
    <Link href="/links" className="inline-flex min-h-9 items-center gap-1 text-xs text-muted-foreground hover:text-black"><BootstrapIcon name="chevron-left" size={16} />All link checks</Link>
    {!check && loading ? <p role="status" className="lime-card p-8 text-sm text-muted-foreground">Loading link check…</p> : null}
    {error ? <div role="alert" className="rounded-2xl border border-[#8F2D31]/15 bg-[#F8E8E9] p-4 text-sm text-[#8F2D31]"><p>{error}</p><button type="button" className={`${linkCheckButtonClass} mt-3`} onClick={() => { setLoading(true); setRetry((value) => value + 1); }}>Retry link check</button></div> : null}
    {check ? <>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1"><h1 className="lime-page-title">Link check details</h1><p className="mt-3 text-sm leading-5"><LinkUrl url={check.url} /></p><p className="mt-2 text-xs leading-5 text-muted-foreground">{check.check_type === "crawl" ? `Full crawl · Maximum ${check.max_pages} pages` : check.check_type === "single" ? "Single page" : check.scan_id ? "Included in accessibility scan" : "Saved accessibility-scan page inventory"}</p>{check.scan_id ? <Link href={`/scans/${check.scan_id}`} className="mt-2 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4">View accessibility scan<BootstrapIcon name="arrow-up-right" size={14} /></Link> : null}</div>
        <div className="flex flex-wrap items-center gap-2"><LinkCheckStatusBadge status={check.status} />{isActiveLinkCheck(check.status) ? <button type="button" className={linkCheckButtonClass} disabled={action !== null} onClick={() => void runAction("cancel")}><BootstrapIcon name="stop-circle" size={16} />{action === "cancel" ? "Cancelling…" : "Cancel check"}</button> : <><button type="button" className={linkCheckButtonClass} disabled={action !== null} onClick={() => void runAction("recheck")}><BootstrapIcon name="arrow-clockwise" size={16} />{action === "recheck" ? "Starting…" : "Recheck"}</button><button type="button" className={`${linkCheckButtonClass} text-[#8F2D31]`} disabled={action !== null} onClick={() => void runAction("delete")}><BootstrapIcon name="trash" size={16} />{action === "delete" ? "Deleting…" : "Delete check"}</button></>}<button type="button" className={linkCheckButtonClass} disabled={action !== null} onClick={() => void runAction("export")}><BootstrapIcon name="download" size={16} />{action === "export" ? "Exporting…" : "Export CSV"}</button></div>
      </div>
      <dl className="grid grid-cols-2 gap-4 rounded-2xl border border-black/10 bg-white p-4 text-xs sm:grid-cols-4 sm:p-5" aria-label="Run details">
        <div className="min-w-0"><dt className="lime-eyebrow">Scope</dt><dd className="mt-2 leading-5">{check.check_type === "single" ? "One source page" : check.check_type === "crawl" ? `Same-origin crawl · ${check.max_pages} page limit` : "Saved accessibility-scan pages"}</dd></div>
        <div className="min-w-0"><dt className="lime-eyebrow">Started</dt><dd className="mt-2 leading-5">{new Date(check.created_at).toLocaleString()}</dd></div>
        <div className="min-w-0"><dt className="lime-eyebrow">Finished</dt><dd className="mt-2 leading-5">{check.completed_at ? new Date(check.completed_at).toLocaleString() : "Not finished"}</dd></div>
        <div className="min-w-0"><dt className="lime-eyebrow">Elapsed</dt><dd className="mt-2 leading-5">{elapsedTime(check)}<span className="mt-1 block text-[10px] text-muted-foreground">Includes any queued time</span></dd></div>
      </dl>
      {actionError ? <p role="alert" className="text-sm text-[#8F2D31]">{actionError}</p> : null}
      {isActiveLinkCheck(check.status) ? <section className="lime-card p-5" aria-label="Link check progress"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="lime-section-title">{check.status === "queued" ? "Waiting to start" : "Check in progress"}</h2><p className="text-xs text-muted-foreground">{check.pages_checked} pages · {check.links_checked}/{check.total_links} targets</p></div><p className="mt-3 text-xs leading-5 text-muted-foreground">{check.status === "queued" && check.scan_id ? "This check starts after its accessibility scan finishes. A paused scan keeps the link check queued until resumed." : check.status === "queued" ? "Your saved check is waiting for the worker." : "Discovering pages and verifying unique link targets. Counts may grow while discovery continues."}</p><div className="mt-4 h-2 overflow-hidden rounded-full bg-black/8"><div className="h-full rounded-full bg-[#FFED00] transition-[width]" style={{ width: `${check.total_links > 0 ? Math.min(100, Math.round(check.links_checked / check.total_links * 100)) : 0}%` }} /></div></section> : <p className="text-xs text-muted-foreground">{check.status === "completed" ? "Processing completed; individual targets may still be broken, blocked, or inconclusive." : check.status === "cancelled" ? "This check was cancelled. Saved partial results are retained." : "This check failed. Review the failure and any saved partial results before rechecking."} Recheck creates a new saved job and keeps this one.</p>}
      {check.error ? <p role="alert" className="rounded-xl bg-[#F8E8E9] p-4 text-xs leading-5 text-[#8F2D31] [overflow-wrap:anywhere]">{check.error}</p> : null}
      <LinkCheckSummaryCards checks={[check]} />
      <LinkCheckCoverage check={check} />
      <section className="lime-card p-5" aria-labelledby="link-target-title" aria-busy={loading}>
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="link-target-title" className="lime-section-title">Link targets</h2><div className="flex items-center gap-2"><label htmlFor="link-status-filter" className="text-xs font-medium">Status</label><select id="link-status-filter" value={status} className="min-h-10 max-w-full rounded-xl border border-black/12 bg-[#FBFAF6] px-3 text-xs" onChange={(event) => { setLoading(true); setOffset(0); setStatus(event.target.value as LinkTargetStatus | "all"); }}>{targetFilters.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select></div></div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">One result per unique target; expand sources to see each place it was referenced. Errors include timeouts, network failures, and redirect loops. Blocked and unchecked targets are not verified as working.</p>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" role="group" aria-label="Filter by outcome">
          {targetFilters.filter((filter) => filter.value !== "all").map((filter) => {
            const outcome = filter.value as LinkTargetStatus;
            return <button key={outcome} type="button" aria-pressed={status === outcome} aria-label={`Show ${filter.label.toLowerCase()} targets`} onClick={() => { setLoading(true); setOffset(0); setStatus(outcome); }} className={`flex min-h-14 flex-col items-start gap-1 rounded-xl border px-3 py-2 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${status === outcome ? "border-black bg-black text-[#FFED00]" : "border-black/10 bg-[#FBFAF6] hover:border-black/30"}`}><span className="text-[10px] font-medium">{filter.label}</span><span className="text-lg font-semibold leading-none">{check.summary[outcome]}</span></button>;
          })}
        </div>
        {loading ? <p role="status" className="mt-4 text-xs text-muted-foreground">Updating results…</p> : null}
        {results && !loading ? <><div className="my-4 space-y-3">{results.items.length === 0 ? <div className="rounded-xl border border-dashed border-black/15 p-8 text-center"><p className="text-sm font-semibold">{isActiveLinkCheck(check.status) ? "No matching targets yet" : "No matching targets"}</p><p className="mt-2 text-xs text-muted-foreground">{status !== "all" ? "Try All targets to see other outcomes." : isActiveLinkCheck(check.status) ? "Results appear as links are discovered and checked." : "This job has no saved link targets. Review source-page coverage above."}</p></div> : results.items.map((target) => <TargetRow key={target.id} checkId={checkId} target={target} />)}</div><div role="group" aria-label="Link target pages"><LinkCheckPagination offset={offset} limit={PAGE_SIZE} total={results.total} hasMore={results.has_more} loading={loading} onPage={(next) => { setLoading(true); setOffset(next); }} /></div></> : null}
      </section>
    </> : null}
  </div>;
}
