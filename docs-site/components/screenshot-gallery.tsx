"use client";

import { useState } from "react";
import { ProductScreenshot } from "@/content/screenshots";
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

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-2">
        {screenshots.map((shot) => (
          <button
            key={shot.id}
            type="button"
            onClick={() => setSelected(shot)}
            className="group block w-full text-left"
          >
            <figure className="overflow-hidden rounded-[18px] border border-black/10 bg-[#f3f2ed] transition-all hover:-translate-y-0.5 hover:shadow-lg">
              <div className="relative aspect-[16/10] overflow-hidden bg-[#f3f2ed] p-3 sm:p-5">
                <img
                  src={assetPath(shot.src)}
                  alt={shot.alt}
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

      {selected ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={selected.title}
          className="fixed inset-0 z-[100] grid place-items-center bg-black/75 p-2 backdrop-blur-sm sm:p-4"
          onClick={() => setSelected(null)}
        >
          <Card
            className="max-h-[calc(100dvh-1rem)] w-full max-w-[96rem] overflow-hidden rounded-2xl py-0 sm:max-h-[94vh] sm:rounded-3xl"
            onClick={(event) => event.stopPropagation()}
          >
            <CardHeader className="flex-row items-start justify-between gap-3 border-b px-4 py-3 sm:gap-4 sm:px-6 sm:py-4">
              <div className="min-w-0">
                <CardTitle>{selected.title}</CardTitle>
                <CardDescription>{selected.caption}</CardDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSelected(null)}
                aria-label="Close screenshot"
              >
                <MaterialSymbol name="close" size={18} />
              </Button>
            </CardHeader>
            <CardContent className="overflow-auto p-0">
              <img
                src={assetPath(selected.src)}
                alt={selected.alt}
                className="mx-auto h-auto w-full"
              />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </>
  );
}
