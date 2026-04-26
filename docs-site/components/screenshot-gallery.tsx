"use client";

import { XIcon, ZoomInIcon } from "lucide-react";
import { useState } from "react";
import { ProductScreenshot } from "@/content/screenshots";
import { assetPath } from "@/lib/site";
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
      <div className="space-y-8">
        {screenshots.map((shot) => (
          <button
            key={shot.id}
            type="button"
            onClick={() => setSelected(shot)}
            className="group block w-full text-left"
          >
            <figure className="overflow-hidden rounded-3xl border bg-muted shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
              <div className="relative bg-muted p-1">
                <img
                  src={assetPath(shot.src)}
                  alt={shot.alt}
                  className="h-auto w-full rounded-[1.35rem] border bg-white object-contain"
                />
                <span className="absolute right-3 top-3 inline-flex rounded-full border bg-background/90 p-2 shadow-sm">
                  <ZoomInIcon className="size-4" />
                </span>
              </div>
              <figcaption className="border-t bg-background px-5 py-4">
                <span className="block font-heading text-xl font-bold">{shot.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">
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
          className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setSelected(null)}
        >
          <Card
            className="max-h-[94vh] w-full max-w-[96rem] overflow-hidden py-0"
            onClick={(event) => event.stopPropagation()}
          >
            <CardHeader className="flex-row items-start justify-between gap-4 border-b py-4">
              <div>
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
                <XIcon className="size-4" />
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
