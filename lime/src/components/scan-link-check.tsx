"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MaterialSymbol } from "@/components/material-symbol";
import { LinkCheckCoverage, LinkCheckStatusBadge, linkCheckButtonClass } from "@/components/link-check-summary";
import { getScanLinkCheck, isActiveLinkCheck, type LinkCheck } from "@/lib/api";

// The companion is independent of accessibility scores/evidence. Polling this
// card never refreshes or rewrites the scan, its screenshot data, or its audits.
export function ScanLinkCheck({ scanId, enabled = false }: { scanId: string; enabled?: boolean }) {
  const [check, setCheck] = useState<LinkCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const job = await getScanLinkCheck(scanId, controller.signal);
        if (!active) return;
        setCheck(job);
        setError(null);
        running = job ? isActiveLinkCheck(job.status) : false;
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Unable to load associated link check");
      } finally {
        if (active) {
          setLoading(false);
          if (running) timer = setTimeout(load, 3000);
        }
      }
    }
    void load();
    return () => { active = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, [scanId, retry]);

  if (!check && !error && !enabled) return null;
  return <section className="lime-card rounded-[22px] p-6" aria-labelledby="scan-link-check-title">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="scan-link-check-title" className="inline-flex items-center gap-2 font-heading text-[22px] font-semibold"><MaterialSymbol name="link" size={22} />Link check</h2>{check ? <LinkCheckStatusBadge status={check.status} /> : null}</div>
    <p className="mt-2 max-w-2xl text-[13px] leading-5 text-muted-foreground">Link results are separate from the accessibility score and screenshot evidence.</p>
    {loading && !check ? <p role="status" className="mt-3 text-xs text-muted-foreground">Loading associated link check…</p> : null}
    {!loading && !check && !error && enabled ? <p className="mt-3 text-xs leading-5 text-muted-foreground">No associated link check is available. It may have been deleted. The accessibility results are unaffected.</p> : null}
    {error ? <div role="alert" className="mt-3 text-xs text-[#8F2D31]"><p>{error}</p><button type="button" className={`${linkCheckButtonClass} mt-2`} onClick={() => { setLoading(true); setRetry((value) => value + 1); }}>Retry link check</button></div> : null}
    {check ? <div className="mt-4 space-y-4">
      {check.status === "queued" ? <p role="status" className="text-xs leading-5 text-muted-foreground">Waiting for accessibility scanning to finish. If this scan is paused, resume it to allow the link check to start.</p> : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[{ label: "Targets checked", value: `${check.links_checked}/${check.total_links}` }, { label: "Broken", value: check.summary.broken }, { label: "Redirected", value: check.summary.redirected }, { label: "Errors", value: check.summary.error }].map((item) => <div key={item.label} className="rounded-xl border border-black/10 bg-[#FBFAF6] p-3"><p className="lime-eyebrow">{item.label}</p><p className="mt-2 font-heading text-2xl font-semibold">{item.value}</p></div>)}</div>
      {isActiveLinkCheck(check.status) ? <div className="h-2 overflow-hidden rounded-full bg-black/8"><div className="h-full rounded-full bg-[#FFED00]" style={{ width: `${check.total_links ? Math.min(100, Math.round(check.links_checked / check.total_links * 100)) : 0}%` }} /></div> : null}
      <LinkCheckCoverage check={check} />
      {check.error ? <p role="alert" className="text-xs leading-5 text-[#8F2D31] [overflow-wrap:anywhere]">{check.error}</p> : null}
      <Link href={`/links/${check.id}`} className={linkCheckButtonClass}>View link results<MaterialSymbol name="arrow_forward" size={16} /></Link>
    </div> : null}
  </section>;
}
