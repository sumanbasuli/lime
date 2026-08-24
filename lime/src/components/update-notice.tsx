"use client";

import * as React from "react";
import { MaterialSymbol } from "@/components/material-symbol";
import {
  readUpdateNoticeEnabled,
  UPDATE_NOTICE_ENABLED_STORAGE_KEY,
  UPDATE_NOTICE_PREFERENCE_EVENT,
} from "@/lib/update-notice-preference";

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
  const [enabled, setEnabled] = React.useState(true);

  React.useEffect(() => {
    setEnabled(readUpdateNoticeEnabled());

    const handlePreference = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "boolean") {
        setEnabled(event.detail);
        return;
      }
      setEnabled(readUpdateNoticeEnabled());
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === UPDATE_NOTICE_ENABLED_STORAGE_KEY) {
        setEnabled(readUpdateNoticeEnabled());
      }
    };

    window.addEventListener(UPDATE_NOTICE_PREFERENCE_EVENT, handlePreference);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(UPDATE_NOTICE_PREFERENCE_EVENT, handlePreference);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

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

  if (!enabled || !info?.enabled || !info.outdated || !info.latest) return null;
  if (dismissedFor === info.latest) return null;

  const dismiss = () => {
    if (!info.latest) return;
    window.localStorage.setItem(DISMISS_STORAGE_KEY, info.latest);
    setDismissedFor(info.latest);
  };

  return (
    <div className="relative mx-3 mb-3 rounded-2xl border border-black bg-[#FFED00] px-3.5 py-3 text-xs text-black group-data-[collapsible=icon]:hidden">
      <div className="min-w-0 pr-5">
          <div className="text-[11px] font-bold uppercase leading-tight tracking-[0.08em]">Update available</div>
          <div className="mt-1.5 text-[13px] leading-[1.4] text-black/80">
            LIME {info.latest} is available. You are running {info.current ?? "the current version"}.
          </div>
          {info.url ? (
            <a
              href={info.url}
              target="_blank"
              rel="noreferrer"
            className="mt-2.5 inline-flex items-center gap-1 border-b-[1.5px] border-black pb-px text-[12.5px] font-semibold"
            >
              View release
              <MaterialSymbol name="arrow_forward" size={14} />
            </a>
          ) : null}
      </div>
        <button
          type="button"
          aria-label="Dismiss update notice"
          className="absolute top-2.5 right-2.5 flex size-6 items-center justify-center rounded-lg opacity-50 transition hover:bg-black/10 hover:opacity-100"
          onClick={dismiss}
        >
          <MaterialSymbol name="close" size={15} />
        </button>
    </div>
  );
}
