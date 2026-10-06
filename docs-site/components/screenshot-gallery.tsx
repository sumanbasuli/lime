"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import type { ProductScreenshot } from "@/content/screenshots";
import { assetPath } from "@/lib/site";
import { MaterialSymbol } from "@/components/material-symbol";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ScreenshotGallery({
  screenshots,
}: {
  screenshots: ProductScreenshot[];
}) {
  const [selected, setSelected] = useState<ProductScreenshot | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const backdropPressRef = useRef(false);
  const titleId = useId();
  const captionId = useId();

  useEffect(() => {
    if (!selected || !dialogRef.current) return;

    const dialog = dialogRef.current;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    closeButtonRef.current?.focus();

    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [selected]);

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        {screenshots.map((shot) => (
          <button
            key={shot.id}
            type="button"
            onClick={(event) => {
              triggerRef.current = event.currentTarget;
              setSelected(shot);
            }}
            className="group block w-full text-left"
          >
            <figure className="overflow-hidden rounded-[18px] border border-black/10 bg-[#f3f2ed] transition-all hover:-translate-y-0.5 hover:shadow-lg">
              <div className="relative aspect-[16/10] overflow-hidden bg-[#f3f2ed] p-3 sm:p-5">
                <Image
                  src={assetPath(shot.src)}
                  alt={shot.alt}
                  width={shot.width}
                  height={shot.height}
                  sizes="(min-width: 1024px) 50vw, 100vw"
                  unoptimized
                  className="h-full w-full rounded-xl border border-black/10 bg-white object-cover object-top shadow-sm"
                />
                <span className="absolute top-4 right-4 inline-flex rounded-full border border-black/15 bg-white/90 p-2 shadow-sm sm:top-6 sm:right-6">
                  <MaterialSymbol name="zoom_in" size={18} />
                </span>
              </div>
              <figcaption className="border-t border-black/10 bg-white px-5 py-4">
                <span className="block font-heading text-lg font-semibold sm:text-xl">{shot.title}</span>
                <span className="mt-1 block text-sm text-black/52">
                  {shot.caption}
                </span>
              </figcaption>
            </figure>
          </button>
        ))}
      </div>

      <dialog
        ref={dialogRef}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={captionId}
        className="fixed inset-0 z-[100] m-0 h-dvh max-h-none w-screen max-w-none items-center justify-items-center overflow-hidden border-0 bg-black/75 p-2 text-foreground backdrop-blur-sm open:grid sm:p-4 [&::backdrop]:bg-transparent"
        onCancel={(event) => {
          event.preventDefault();
          setSelected(null);
        }}
        onPointerDown={(event) => {
          backdropPressRef.current = event.target === event.currentTarget;
        }}
        onClick={(event) => {
          if (backdropPressRef.current && event.target === event.currentTarget) setSelected(null);
          backdropPressRef.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const first = closeButtonRef.current;
          const last = viewerRef.current;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        {selected ? (
          <Card
            className="min-h-0 max-h-[calc(100dvh-1rem)] w-full max-w-[96rem] overflow-hidden rounded-2xl py-0 sm:max-h-[94vh] sm:rounded-3xl"
          >
            <CardHeader className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3 sm:gap-4 sm:px-6 sm:py-4">
              <div className="min-w-0">
                <CardTitle id={titleId}>{selected.title}</CardTitle>
                <CardDescription id={captionId}>{selected.caption}</CardDescription>
              </div>
              <Button
                ref={closeButtonRef}
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSelected(null)}
                aria-label="Close screenshot"
              >
                <MaterialSymbol name="close" size={18} />
              </Button>
            </CardHeader>
            <CardContent
              ref={viewerRef}
              role="region"
              aria-label={`${selected.title} screenshot viewer`}
              tabIndex={0}
              className="min-h-0 overflow-auto p-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-black/60"
            >
              <Image
                src={assetPath(selected.src)}
                alt={selected.alt}
                width={selected.width}
                height={selected.height}
                sizes="100vw"
                unoptimized
                className="mx-auto h-auto w-full"
              />
            </CardContent>
          </Card>
        ) : null}
      </dialog>
    </>
  );
}
