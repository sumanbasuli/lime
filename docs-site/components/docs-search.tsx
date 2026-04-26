"use client";

import {
  CornerDownLeftIcon,
  FileTextIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
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
  const deferredQuery = useDeferredValue(query);
  const results = searchEntries(entries, deferredQuery);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
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
  }, [open]);

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
        className="fixed inset-0 z-[100] flex items-start justify-center bg-black/45 p-3 pt-20 backdrop-blur-md md:p-6 md:pt-24"
        onClick={closeSearch}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Search docs"
          className="w-full max-w-2xl overflow-hidden rounded-3xl border bg-background shadow-2xl"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleDialogKeyDown}
        >
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <SearchIcon className="size-5 text-muted-foreground" />
            <Input
              ref={inputRef}
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
              <XIcon className="size-4" />
            </Button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-2">
            {results.length ? (
              <div className="space-y-1">
                {results.map((result, index) => (
                  <a
                    key={result.href}
                    href={withBasePath(result.href)}
                    className={`block rounded-2xl border p-4 no-underline transition-colors ${
                      index === Math.min(activeIndex, Math.max(results.length - 1, 0))
                        ? "border-black bg-[#FFED00]/40 text-foreground"
                        : "border-transparent hover:border-border hover:bg-muted/60"
                    }`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={closeSearch}
                  >
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-background text-foreground shadow-sm">
                        <FileTextIcon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-heading text-lg font-bold leading-6">
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

          <div className="flex items-center justify-between border-t bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            <span>Use ↑ ↓ to move</span>
            <span className="inline-flex items-center gap-1">
              <CornerDownLeftIcon className="size-3" />
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
        onClick={() => setOpen(true)}
      >
        <span className="inline-flex items-center gap-2">
          <SearchIcon className="size-4" />
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
        onClick={() => setOpen(true)}
        aria-label="Search docs"
      >
        <SearchIcon className="size-4" />
      </Button>

      {dialog ? createPortal(dialog, document.body) : null}
    </>
  );
}
