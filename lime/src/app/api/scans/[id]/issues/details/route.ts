import { NextRequest } from "next/server";
import {
  ISSUE_OCCURRENCES_PAGE_SIZE,
  loadIssueDetailWithSummary,
} from "@/lib/scan-issues";
import { measureServerAction } from "@/lib/performance-logging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const kind = request.nextUrl.searchParams.get("kind");
  const key = request.nextUrl.searchParams.get("key");

  if ((kind !== "failed" && kind !== "needs_review") || !key) {
    return Response.json(
      { error: "kind and key are required" },
      { status: 400 }
    );
  }

  const occurrenceOffset = parsePositiveInt(
    request.nextUrl.searchParams.get("occurrenceOffset"),
    0
  );
  const occurrenceLimit = Math.min(
    parsePositiveInt(
      request.nextUrl.searchParams.get("occurrenceLimit"),
      ISSUE_OCCURRENCES_PAGE_SIZE
    ),
    100
  );

  const result = await measureServerAction(
    `issue detail ${id} ${kind}`,
    () =>
      loadIssueDetailWithSummary(
        id,
        kind,
        key,
        occurrenceOffset,
        occurrenceLimit
      ),
    500
  );

  if (!result) {
    return Response.json({ error: "Issue not found" }, { status: 404 });
  }

  return Response.json(result);
}
