"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MaterialSymbol } from "@/components/material-symbol";
import { Input } from "@/components/ui/input";
import { LinkCheckPagination, LinkCheckStatusBadge, LinkCheckSummaryCards, linkCheckButtonClass } from "@/components/link-check-summary";
import { createLinkCheck, getLinkChecks, getLinkCheckStats, type LinkCheck, type LinkCheckPage, type LinkCheckStats } from "@/lib/api";
import { redactUrlUserinfo } from "@/lib/url-presentation";

const PAGE_SIZE = 10;

export function LinkCheckerDashboard() {
  const router = useRouter();
  const [checkType, setCheckType] = useState<"crawl" | "single">("crawl");
  const [url, setUrl] = useState("");
  const [maxPages, setMaxPages] = useState("100");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [history, setHistory] = useState<LinkCheckPage<LinkCheck> | null>(null);
  const [stats, setStats] = useState<LinkCheckStats | null>(null);
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    let hasRunningJobs = false;
    async function load() {
      try {
        const [data, totals] = await Promise.all([getLinkChecks(PAGE_SIZE, offset, controller.signal), getLinkCheckStats(controller.signal)]);
        if (!active) return;
        if (offset > 0 && data.items.length === 0) {
          active = false;
          setLoading(true);
          setOffset(data.total > 0 ? Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE : 0);
          return;
        }
        setHistory(data);
        setStats(totals);
        setHistoryError(null);
        hasRunningJobs = totals.active_checks > 0;
      } catch (error) {
        if (!active) return;
        setHistoryError(error instanceof Error ? error.message : "Unable to load link checks");
      } finally {
        if (active) {
          setLoading(false);
          if (hasRunningJobs) timer = setTimeout(load, 3000);
        }
      }
    }
    void load();
    return () => { active = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, [offset, retry]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    } catch {
      setFormError("Enter an HTTP or HTTPS URL without embedded credentials.");
      return;
    }
    const pages = Number(maxPages);
    if (checkType === "crawl" && (!Number.isInteger(pages) || pages < 1 || pages > 500)) {
      setFormError("Maximum pages must be a whole number between 1 and 500.");
      return;
    }
    setSubmitting(true);
    try {
      const check = await createLinkCheck({ url: parsed.href, checkType, maxPages: checkType === "crawl" ? pages : 1 });
      router.push(`/links/${check.id}`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to start link check");
      setSubmitting(false);
    }
  }

  function changePage(nextOffset: number) { setLoading(true); setHistoryError(null); setOffset(nextOffset); }

  return <div className="mx-auto w-full max-w-[1180px] space-y-5">
    <div>
      <h1 className="lime-page-title">Link checker</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">Find broken targets, redirects, and connection errors in links discovered from your pages. Every check is a saved one-shot job, not a recurring monitor.</p>
    </div>
    {stats ? <><p className="text-xs text-muted-foreground">{stats.total_checks} saved checks · {stats.active_checks} active · {stats.pages_checked} source pages checked</p><LinkCheckSummaryCards stats={stats} scope="All saved checks" /></> : null}
    <section className="lime-card p-5" aria-labelledby="new-link-check-title">
      <h2 id="new-link-check-title" className="lime-section-title">Check a site</h2>
      <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
        <fieldset disabled={submitting}>
          <legend className="lime-eyebrow">Check type</legend>
          <div className="mt-2 flex w-fit items-center gap-1 rounded-xl bg-black/[0.055] p-1">
            {(["crawl", "single"] as const).map((type) => <button key={type} type="button" aria-pressed={checkType === type} onClick={() => setCheckType(type)} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${checkType === type ? "bg-white text-black shadow-sm" : "text-black/55 hover:text-black"}`}>
              <MaterialSymbol name={type === "crawl" ? "language" : "description"} size={16} />{type === "crawl" ? "Full crawl" : "Single page"}
            </button>)}
          </div>
        </fieldset>
        <div className={`grid gap-3 ${checkType === "crawl" ? "md:grid-cols-[minmax(0,1fr)_150px]" : ""}`}>
          <div className="min-w-0 space-y-1.5">
            <label htmlFor="link-check-url" className="lime-eyebrow block">{checkType === "crawl" ? "Website URL" : "Page URL"}</label>
            <Input id="link-check-url" type="url" required autoComplete="url" value={url} onChange={(event) => setUrl(event.target.value)} disabled={submitting} placeholder={checkType === "crawl" ? "https://example.com" : "https://example.com/about"} className="h-11 rounded-xl bg-[#FBFAF6] px-4 font-mono text-sm shadow-none focus:bg-white" aria-describedby="link-check-scope" />
          </div>
          {checkType === "crawl" ? <div className="space-y-1.5">
            <label htmlFor="link-check-max-pages" className="lime-eyebrow block">Maximum pages</label>
            <Input id="link-check-max-pages" type="number" min={1} max={500} step={1} value={maxPages} onChange={(event) => setMaxPages(event.target.value)} disabled={submitting} className="h-11 rounded-xl bg-[#FBFAF6] px-4 shadow-none" />
          </div> : null}
        </div>
        <p id="link-check-scope" className="text-xs leading-5 text-muted-foreground">{checkType === "crawl" ? "Follow same-origin HTML pages up to your limit. Verify discovered internal and external targets without crawling external sites." : "Read this page only and verify its discovered targets; linked pages are not crawled."} HTTP(S) only. Your entered host may be an internal site; discovered links to other private-network hosts are blocked. Scripts are not executed.</p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={submitting} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-black px-6 text-sm font-semibold text-white transition-colors hover:bg-[#FFED00] hover:text-black disabled:cursor-wait disabled:opacity-60"><MaterialSymbol name={submitting ? "progress_activity" : "play_arrow"} size={18} className={submitting ? "animate-spin" : undefined} />{submitting ? "Starting check…" : "Start link check"}</button>
          <Link href="/scans/new" className="text-xs text-muted-foreground underline underline-offset-4 hover:text-black">Include a link check in an accessibility scan</Link>
        </div>
        {formError ? <p role="alert" className="text-xs font-medium text-[#8F2D31]">{formError}</p> : null}
      </form>
    </section>
    <section className="lime-card p-5" aria-labelledby="link-history-title" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="link-history-title" className="lime-section-title">All checks</h2><p className="text-xs text-muted-foreground">{history ? `${history.total} saved check${history.total === 1 ? "" : "s"}` : "Loading history…"}</p></div>
      {historyError ? <div role="alert" className="mt-4 rounded-xl bg-[#F8E8E9] p-4 text-xs text-[#8F2D31]"><p>{historyError}</p><button type="button" className={`${linkCheckButtonClass} mt-3`} onClick={() => { setLoading(true); setRetry((value) => value + 1); }}>Retry history</button></div> : null}
      {!history && loading ? <p role="status" className="py-12 text-center text-sm text-muted-foreground">Loading link checks…</p> : null}
      {history && history.items.length === 0 ? <div className="py-12 text-center"><p className="font-heading text-xl font-semibold">No link checks yet</p><p className="mt-2 text-xs text-muted-foreground">Start a check above, or select Include link check when creating a scan.</p></div> : null}
      {history && history.items.length > 0 ? <>
        <div className="my-4 divide-y divide-black/8">
          {history.items.map((check) => <article key={check.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1"><Link href={`/links/${check.id}`} className="text-sm font-semibold [overflow-wrap:anywhere] hover:underline">{redactUrlUserinfo(check.url)}</Link><p className="mt-1.5 text-xs leading-5 text-muted-foreground">{check.check_type === "crawl" ? "Full crawl" : check.check_type === "single" ? "Single page" : check.scan_id ? "Included in scan" : "Saved scan pages"} · {new Date(check.created_at).toLocaleString()}</p><p className="mt-1 text-xs text-muted-foreground">{check.links_checked}/{check.total_links} targets · {check.summary.broken} broken · {check.summary.redirected} redirected{check.truncated || check.pages_failed > 0 ? " · Limited coverage" : ""}</p></div>
            <div className="flex shrink-0 items-center gap-3"><LinkCheckStatusBadge status={check.status} /><Link href={`/links/${check.id}`} className={linkCheckButtonClass} aria-label={`View link check for ${redactUrlUserinfo(check.url)}`}>View results<MaterialSymbol name="arrow_forward" size={16} /></Link></div>
          </article>)}
        </div>
        <LinkCheckPagination offset={offset} limit={PAGE_SIZE} total={history.total} hasMore={history.has_more} loading={loading} onPage={changePage} />
      </> : null}
    </section>
  </div>;
}
