"use client";

import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Maximize2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface IssueScreenshotLightboxProps {
  src: string;
  previewSrc?: string;
  alt: string;
  label: string;
  previewClassName?: string;
  triggerLabel?: string;
}

export function IssueScreenshotLightbox({
  src,
  previewSrc,
  alt,
  label,
  previewClassName,
  triggerLabel,
}: IssueScreenshotLightboxProps) {
  const hasPreview = Boolean(previewClassName);
  const [activePreviewSrc, setActivePreviewSrc] = useState(previewSrc ?? src);

  return (
    <Dialog.Root>
      <Dialog.Trigger
        className={
          hasPreview
            ? "group relative mx-auto inline-flex max-w-full overflow-hidden rounded-xl border border-black/10 bg-[#f6f0e4] p-2 text-left shadow-[0_12px_28px_rgba(17,17,17,0.08)] transition-transform hover:scale-[1.01] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            : "inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        }
      >
        {hasPreview ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={activePreviewSrc}
              alt={alt}
              className={previewClassName}
              loading="lazy"
              onError={() => {
                if (activePreviewSrc !== src) {
                  setActivePreviewSrc(src);
                }
              }}
            />
            <span className="pointer-events-none absolute right-4 bottom-4 inline-flex items-center gap-1 rounded-full bg-black/80 px-2.5 py-1 text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <Maximize2Icon className="h-3 w-3" />
              Expand
            </span>
          </>
        ) : (
          <>
            <Maximize2Icon className="h-3.5 w-3.5" />
            {triggerLabel ?? `Open ${label.toLowerCase()}`}
          </>
        )}
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/70 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-sm" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex w-[min(96vw,1120px)] max-h-[92vh] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#111111] text-white shadow-[0_24px_80px_rgba(0,0,0,0.45)] outline-none transition duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <Dialog.Title className="font-heading text-base font-bold">
              {label}
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-white hover:bg-white/10 hover:text-white"
                />
              }
            >
              <XIcon className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-auto bg-[#111111] p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={alt}
              className="block w-full rounded-xl border border-white/10 bg-white shadow-[0_20px_48px_rgba(0,0,0,0.28)]"
            />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
