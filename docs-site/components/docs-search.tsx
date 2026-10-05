"use client";

import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { MaterialSymbol } from "@/components/material-symbol";
import type { DocsSearchEntry } from "@/lib/docs-search";
import { withBasePath } from "@/lib/site";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SearchResult extends DocsSearchEntry {
  score: number;
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreEntry(entry: DocsSearchEntry, terms: string[]): number {
  const title = normalize(entry.title);
  const category = normalize(entry.category);
  const excerpt = normalize(entry.excerpt);
  const content = normalize(entry.content);

  return terms.reduce((score, term) => {
    if (!term) {
      return score;
    }

    let nextScore = score;
    if (title === term) {
      nextScore += 80;
    }
    if (title.includes(term)) {
      nextScore += 35;
    }
    if (category.includes(term)) {
      nextScore += 15;
    }
    if (excerpt.includes(term)) {
      nextScore += 10;
    }
    if (content.includes(term)) {
      nextScore += 4;
    }

    return nextScore;
  }, 0);
}

function searchEntries(entries: DocsSearchEntry[], query: string): SearchResult[] {
  const terms = normalize(query).split(" ").filter(Boolean);

  if (!terms.length) {
    return entries.slice(0, 8).map((entry) => ({ ...entry, score: 0 }));
  }

  return entries
    .filter((entry) => {
      const searchable = normalize([entry.title, entry.category, entry.excerpt, entry.content].join(" "));
      return terms.every((term) => searchable.includes(term));
    })
    .map((entry) => ({
      ...entry,
      score: scoreEntry(entry, terms),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, 10);
}

function snippetFor(entry: DocsSearchEntry, query: string) {
  const normalizedQuery = normalize(query);
  const firstTerm = normalizedQuery.split(" ").find(Boolean);
  const source = entry.excerpt || entry.content;

  if (!firstTerm) {
    return source;
  }

  const index = normalize(source).indexOf(firstTerm);
  if (index === -1) {
    return source;
  }

  const start = Math.max(0, index - 60);
  const end = Math.min(source.length, index + 160);
  return `${start > 0 ? "... " : ""}${source.slice(start, end)}${end < source.length ? " ..." : ""}`;
}

export function DocsSearch({ entries }: { entries: DocsSearchEntry[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const deferredQuery = useDeferredValue(query);
  const results = searchEntries(entries, deferredQuery);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (dialogRef.current) {
          inputRef.current?.focus();
          return;
        }
        if (document.querySelector('[aria-modal="true"]')) return;
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen(true);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    inputRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [open]);

  function openSearch(event: ReactMouseEvent<HTMLButtonElement>) {
    returnFocusRef.current = event.currentTarget;
    setOpen(true);
  }

  function closeSearch() {
    setOpen(false);
  }

  function openResult(result: SearchResult) {
    window.location.assign(withBasePath(result.href));
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const activeResultIndex = Math.min(activeIndex, Math.max(results.length - 1, 0));

    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return;
    }
    if (event.key === "Tab") {
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>("input, button, a[href]");
      const first = controls?.[0];
      const last = controls?.[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    // Links and buttons keep their native Enter/arrow behavior.
    if (event.target !== inputRef.current) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === "Enter" && results[activeResultIndex]) {
      event.preventDefault();
      openResult(results[activeResultIndex]);
    }
  }

  const dialog =
    open && typeof document !== "undefined" ? (
      <div
        className="fixed inset-0 z-[100] flex items-start justify-center bg-black/45 p-2 pt-16 backdrop-blur-md sm:p-3 sm:pt-20 md:p-6 md:pt-24"
        onClick={closeSearch}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Search docs"
          className="w-full max-w-2xl overflow-hidden rounded-[18px] border border-black/15 bg-[#fdfcf8] shadow-2xl"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleDialogKeyDown}
        >
          <div className="flex items-center gap-2 border-b px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3">
            <MaterialSymbol name="search" size={20} className="text-black/45" />
            <Input
              ref={inputRef}
              aria-label="Search documentation"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              placeholder="Search partial retry, CSV, Docker, API..."
              className="h-11 border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={closeSearch}
              aria-label="Close search"
            >
              <MaterialSymbol name="close" size={18} />
            </Button>
          </div>

          <div className="max-h-[65dvh] overflow-y-auto p-2 md:max-h-[60vh]">
            {results.length ? (
              <div className="space-y-1">
                {results.map((result, index) => (
                  <a
                    key={result.href}
                    href={withBasePath(result.href)}
                    className={`block rounded-2xl border p-3 no-underline transition-colors sm:p-4 ${
                      index === Math.min(activeIndex, Math.max(results.length - 1, 0))
                        ? "border-black bg-[#FFED00]/40 text-foreground"
                        : "border-transparent hover:border-border hover:bg-muted/60"
                    }`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={closeSearch}
                  >
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-background text-foreground shadow-sm">
                        <MaterialSymbol name="description" size={18} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 break-words font-heading text-base font-bold leading-6 sm:text-lg">
                            {result.title}
                          </span>
                          <span className="shrink-0 rounded-full border bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                            {result.category}
                          </span>
                        </span>
                        <span className="mt-1 line-clamp-2 block text-sm leading-6 text-muted-foreground">
                          {snippetFor(result, deferredQuery)}
                        </span>
                      </span>
                    </div>
                  </a>
                ))}
              </div>
            ) : (
              <div className="px-6 py-12 text-center">
                <div className="font-heading text-2xl font-bold">No docs found</div>
                <p className="mt-2 text-sm text-muted-foreground">
                  Try searching for scan, report, CSV, Docker, settings, or API.
                </p>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between border-t bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground sm:px-4 sm:text-xs">
            <span>Use ↑ ↓ to move</span>
            <span className="inline-flex items-center gap-1">
              <MaterialSymbol name="keyboard_return" size={14} />
              Open result
            </span>
          </div>
        </div>
      </div>
    ) : null;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="hidden min-w-48 justify-between border-border/80 bg-background/70 text-muted-foreground md:inline-flex lg:min-w-64"
        onClick={openSearch}
      >
        <span className="inline-flex items-center gap-2">
          <MaterialSymbol name="search" size={18} />
          Search docs
        </span>
        <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          ⌘K
        </kbd>
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className="md:hidden"
        onClick={openSearch}
        aria-label="Search docs"
      >
        <MaterialSymbol name="search" size={18} />
      </Button>

      {dialog ? createPortal(dialog, document.body) : null}
    </>
  );
}
