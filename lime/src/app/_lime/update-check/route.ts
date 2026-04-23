import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

const DEFAULT_REPO = "sumanbasuli/lime";

type DisabledPayload = {
  enabled: false;
};

type EnabledPayload = {
  enabled: true;
  current: string;
  latest: string | null;
  latestRaw: string | null;
  url: string | null;
  outdated: boolean;
  checkedAt: string;
};

function cleanTag(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

function compareSemver(a: string, b: string): number {
  const parse = (input: string) =>
    input
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

export async function GET(): Promise<NextResponse<DisabledPayload | EnabledPayload | { error: string }>> {
  const enabled = (process.env.LIME_UPDATE_CHECK ?? "").toLowerCase() === "true";

  if (!enabled) {
    return NextResponse.json({ enabled: false } satisfies DisabledPayload);
  }

  const current = cleanTag(process.env.LIME_VERSION) ?? "dev";
  const repo = process.env.LIME_GITHUB_REPO?.trim() || DEFAULT_REPO;
  const endpoint = `https://api.github.com/repos/${repo}/releases/latest`;

  try {
    const response = await fetch(endpoint, {
      next: { revalidate: 1800 },
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `lime-update-check/${current}`,
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        {
          enabled: true,
          current,
          latest: null,
          latestRaw: null,
          url: null,
          outdated: false,
          checkedAt: new Date().toISOString(),
        } satisfies EnabledPayload,
      );
    }

    const body = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      prerelease?: boolean;
      draft?: boolean;
    };

    if (body.draft || body.prerelease) {
      return NextResponse.json({
        enabled: true,
        current,
        latest: null,
        latestRaw: null,
        url: null,
        outdated: false,
        checkedAt: new Date().toISOString(),
      } satisfies EnabledPayload);
    }

    const latestRaw = cleanTag(body.tag_name);
    const outdated = !!latestRaw && compareSemver(latestRaw, current) > 0;

    return NextResponse.json({
      enabled: true,
      current,
      latest: body.tag_name ?? null,
      latestRaw,
      url: body.html_url ?? null,
      outdated,
      checkedAt: new Date().toISOString(),
    } satisfies EnabledPayload);
  } catch {
    return NextResponse.json({
      enabled: true,
      current,
      latest: null,
      latestRaw: null,
      url: null,
      outdated: false,
      checkedAt: new Date().toISOString(),
    } satisfies EnabledPayload);
  }
}
