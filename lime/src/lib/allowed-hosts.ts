import { isIP } from "node:net";
import { domainToASCII } from "node:url";

type HostPolicy = { names: ReadonlySet<string>; valid: boolean };

function parseAuthority(value: string): string | null {
  if (!value || value !== value.trim() || /[\s,/@?#%\\]/u.test(value)) return null;

  let hostname: string;
  let port: string | undefined;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return null;
    hostname = value.slice(1, close);
    if (isIP(hostname) !== 6 || hostname.includes("%")) return null;
    const suffix = value.slice(close + 1);
    if (suffix && !suffix.startsWith(":")) return null;
    port = suffix ? suffix.slice(1) : undefined;
  } else {
    const separator = value.indexOf(":");
    hostname = separator < 0 ? value : value.slice(0, separator);
    port = separator < 0 ? undefined : value.slice(separator + 1);
    if (hostname.includes(":") || hostname.includes("[") || hostname.includes("]")) return null;
  }

  if (port !== undefined && (!/^[0-9]+$/u.test(port) || Number(port) < 1 || Number(port) > 65535)) return null;
  if (isIP(hostname) === 4 || isIP(hostname) === 6) return hostname.toLowerCase();
  if (/^0x[0-9a-f]+$/iu.test(hostname) || /^[0-9.]+$/u.test(hostname)) return null;

  const normalized = domainToASCII(hostname.replace(/\.$/u, "")).toLowerCase();
  if (!normalized || normalized.length > 253 || normalized.endsWith(".")) return null;
  const labels = normalized.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) return null;
  return normalized;
}

function parsePolicy(value: string | undefined): HostPolicy {
  const names = new Set<string>();
  if (!value) return { names, valid: true };
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    const parsed = parseAuthority(trimmed);
    if (!trimmed || !parsed) return { names: new Set(), valid: false };
    names.add(parsed);
  }
  return { names, valid: true };
}

const policy = parsePolicy(process.env.LIME_ALLOWED_HOSTS);

// Use the wire Host, never request.url or a forwarded header: those can describe
// an internal listener or a value supplied by an untrusted proxy client.
export function rejectUntrustedHost(request: Request): Response | null {
  const hostname = parseAuthority(request.headers.get("host") ?? "");
  if (policy.valid && hostname && (hostname === "localhost" || isIP(hostname) !== 0 || policy.names.has(hostname))) {
    return null;
  }
  return Response.json({ error: "Unrecognized request host" }, { status: 421, headers: { "Cache-Control": "no-store" } });
}
