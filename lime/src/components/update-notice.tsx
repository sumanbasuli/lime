"use client";

import * as React from "react";
import { ArrowUpCircleIcon, XIcon } from "lucide-react";

type UpdateInfo = {
  enabled: boolean;
  current?: string;
  latest?: string | null;
  url?: string | null;
  outdated?: boolean;
};

const DISMISS_STORAGE_KEY = "lime.updateNotice.dismissed";

export function UpdateNotice() {
  const [info, setInfo] = React.useState<UpdateInfo | null>(null);
  const [dismissedFor, setDismissedFor] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDismissedFor(
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(DISMISS_STORAGE_KEY),
    );
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();

    fetch("/_lime/update-check", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (payload) setInfo(payload as UpdateInfo);
      })
      .catch(() => {
        /* silent: update check is best-effort */
      });

    return () => controller.abort();
  }, []);

  if (!info?.enabled || !info.outdated || !info.latest) return null;
  if (dismissedFor === info.latest) return null;

  const dismiss = () => {
    if (!info.latest) return;
    window.localStorage.setItem(DISMISS_STORAGE_KEY, info.latest);
    setDismissedFor(info.latest);
  };

  return (
    <div className="mx-2 mb-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900 shadow-sm dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-100">
      <div className="flex items-start gap-2">
        <ArrowUpCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-tight">Update available</div>
          <div className="truncate opacity-80">
            {info.current ?? "current"} → {info.latest}
          </div>
          {info.url ? (
            <a
              href={info.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block font-medium underline underline-offset-2"
            >
              Release notes
            </a>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss update notice"
          className="rounded p-0.5 opacity-60 transition hover:bg-amber-100 hover:opacity-100 dark:hover:bg-amber-900/40"
          onClick={dismiss}
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
