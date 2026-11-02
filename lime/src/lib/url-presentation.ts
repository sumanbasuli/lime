/** Remove URL credentials, query, and fragment for display or export only. */
export function redactUrlUserinfo(value: string): string {
  // Keep the stored URL untouched for the scanner. Strip before parsing so a
  // malformed legacy URL cannot make the public fallback echo a token.
  const boundary = value.search(/[?#]/);
  const publicValue = boundary < 0 ? value : value.slice(0, boundary);
  try {
    const url = new URL(publicValue);
    if (!url.username && !url.password) return publicValue;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    // Preserve a malformed URL's public path, but not credentials or tails.
    const match = publicValue.match(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)([^/?#]*)([\s\S]*)$/i);
    if (match) {
      const at = match[2].lastIndexOf("@");
      if (at >= 0) return `${match[1]}${match[2].slice(at + 1)}${match[3]}`;
    }
    return publicValue;
  }
}

export function redactOptionalUrlUserinfo(value: string | null): string | null {
  return value === null ? null : redactUrlUserinfo(value);
}
