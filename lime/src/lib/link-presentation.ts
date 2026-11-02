import type { BootstrapIconName } from "@/components/bootstrap-icon";
import { redactUrlUserinfo } from "@/lib/url-presentation";

export type LinkPresentation = {
  hostname: string;
  label: string;
  path: string;
  icon: BootstrapIconName;
  brand: boolean;
};

const brands: { hosts: readonly string[]; label: string; icon: BootstrapIconName }[] = [
  { hosts: ["linkedin.com", "lnkd.in"], label: "LinkedIn", icon: "linkedin" },
  { hosts: ["github.com"], label: "GitHub", icon: "github" },
  { hosts: ["wordpress.org", "wordpress.com", "wordpress.net", "w.org", "wp.me"], label: "WordPress", icon: "wordpress" },
  { hosts: ["x.com", "twitter.com", "t.co"], label: "X / Twitter", icon: "twitter-x" },
  { hosts: ["facebook.com", "fb.com", "fb.me"], label: "Facebook", icon: "facebook" },
  { hosts: ["instagram.com"], label: "Instagram", icon: "instagram" },
  { hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com"], label: "YouTube", icon: "youtube" },
];

/** Presentation only: no network requests, favicon lookups, or destination health inference. */
export function getLinkPresentation(rawUrl: string, linkType?: string): LinkPresentation {
  const fallback: LinkPresentation = { hostname: "", label: "Link", path: redactUrlUserinfo(rawUrl), icon: "link-45deg", brand: false };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fallback;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const path = url.pathname;
  const brand = brands.find(({ hosts }) => hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`)));
  if (brand) return { hostname, path, label: brand.label, icon: brand.icon, brand: true };

  // Treat file extensions as visual hints, not MIME claims or a replacement for saved link_type.
  const extension = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  let icon: BootstrapIconName = "globe2";
  if (extension === "pdf") icon = "file-earmark-pdf";
  else if (extension && /^(?:css|js|mjs|cjs|json|map|xml)$/.test(extension)) icon = "code-slash";
  else if (extension && /^(?:avif|bmp|gif|ico|jpeg|jpg|png|svg|tiff|webp)$/.test(extension)) icon = "image";
  else if (linkType === "document" || linkType === "media") icon = "file-earmark-text";
  return { hostname, path, label: hostname, icon, brand: false };
}
