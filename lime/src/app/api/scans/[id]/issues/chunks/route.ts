import { NextRequest } from "next/server";
import {
  ISSUE_SUMMARIES_PAGE_SIZE,
  loadIssueSummariesPage,
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
  const offset = parsePositiveInt(
    request.nextUrl.searchParams.get("offset"),
    0
  );
  const limit = Math.min(
    parsePositiveInt(
      request.nextUrl.searchParams.get("limit"),
      ISSUE_SUMMARIES_PAGE_SIZE
    ),
    50
  );

  const result = await measureServerAction(
    `issues chunk ${id}`,
    () => loadIssueSummariesPage(id, offset, limit),
    500
  );
  return Response.json(result);
}
