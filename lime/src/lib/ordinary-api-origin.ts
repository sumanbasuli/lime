const forbidden = () =>
  Response.json({ error: "Cross-origin write requests are not allowed" }, { status: 403 });

// Browser writes must come from the dashboard origin. Requests without browser
// origin metadata remain available to CLI and other server-side API clients.
export function rejectCrossOriginWrite(request: Request): Response | null {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return null;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site" || (fetchSite === "same-site" && origin === null)) return forbidden();
  if (origin === null) return null;

  try {
    const parsedOrigin = new URL(origin);
    if (
      !["http:", "https:"].includes(parsedOrigin.protocol) ||
      parsedOrigin.origin !== origin
    ) return forbidden();

    // Next may use its internal listener URL behind a reverse proxy. The
    // public Host and proxy-set protocol describe the browser's destination.
    const requestUrl = new URL(request.url);
    const host = request.headers.get("host") || requestUrl.host;
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0].trim();
    const protocol = forwardedProto || requestUrl.protocol.slice(0, -1);
    if (protocol !== "http" && protocol !== "https") return forbidden();

    if (parsedOrigin.origin !== new URL(`${protocol}://${host}`).origin) return forbidden();
    return null;
  } catch {
    return forbidden();
  }
}
