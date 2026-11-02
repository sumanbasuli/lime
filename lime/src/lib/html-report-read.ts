import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import type { QueryResult, QueryResultRow } from "pg";
import { pool } from "@/db";
import * as schema from "@/db/schema";
import type { ReportReadContext } from "@/lib/mcp-report-read";

// This budget applies only to the rendered HTML/PDF path. CSV retains its
// complete, separately streamed export. Charge generously for JS strings,
// objects, and the copies held while React and Chromium render the document.
export const HTML_REPORT_MAX_ROWS = 4096;
export const HTML_REPORT_MAX_BYTES = 8 * 1024 * 1024;

export class HtmlReportTooLargeError extends Error {
  constructor() {
    super("This report is too large to render safely. Download the complete CSV export instead.");
  }
}

type ReportSelect<T> = PromiseLike<T[]> & {
  toSQL(): { sql: string; params: unknown[] };
};

// Measure the complete projection on PostgreSQL before fetching any row. In
// particular, a single oversized URL or HTML snippet cannot cross into Node.
export async function withHtmlReportRead<T>(
  work: (context: ReportReadContext) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let queue: Promise<unknown> = Promise.resolve();
  let failure: unknown;
  let rows = BigInt(0);
  let bytes = BigInt(0);
  let closed = false;
  const check = () => {
    if (failure) throw failure;
    if (closed) throw new Error("HTML report read is closed");
  };
  const enqueue = <R>(work: () => Promise<R>): Promise<R> => {
    const next = queue.then(async () => {
      check();
      try {
        return await work();
      } catch (error) {
        failure ??= error;
        throw error;
      }
    });
    queue = next.catch(() => {});
    return next;
  };
  const measure = async (text: string, params: unknown[], columns: number) => {
    if (!Number.isSafeInteger(columns) || columns < 1 || columns > 128) {
      throw new Error("Invalid HTML report projection");
    }
    const names = Array.from({ length: columns }, (_, index) => `"c${index}"`);
    const width = names.map((name) => `COALESCE(octet_length(${name}::text)::numeric, 0)`).join(" + ");
    const result = await client.query<{ row_count: string; byte_count: string }>(
      `WITH html_report_rows (${names.join(", ")}) AS (
         (${text}) UNION ALL SELECT ${names.map(() => "NULL").join(", ")} WHERE false
       )
       SELECT count(*)::text AS row_count,
         COALESCE(sum(1024::numeric + 6 * (${width})), 0)::text AS byte_count
       FROM html_report_rows`,
      params
    );
    const nextRows = BigInt(result.rows[0].row_count);
    const nextBytes = BigInt(result.rows[0].byte_count);
    if (nextRows < BigInt(0) || nextBytes < BigInt(0) ||
      rows + nextRows > BigInt(HTML_REPORT_MAX_ROWS) ||
      bytes + nextBytes > BigInt(HTML_REPORT_MAX_BYTES)) {
      throw new HtmlReportTooLargeError();
    }
    rows += nextRows;
    bytes += nextBytes;
  };

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30000ms'");
    const context: ReportReadContext = {
      db: drizzle(client, { schema }),
      check,
      read<R>(query: ReportSelect<R>, columns: number) {
        return enqueue(async () => {
          const prepared = query.toSQL();
          await measure(prepared.sql, prepared.params, columns);
          return await query;
        });
      },
      query<R extends QueryResultRow>(text: string, params: unknown[], columns: number): Promise<QueryResult<R>> {
        return enqueue(async () => {
          await measure(text, params, columns);
          return client.query<R>(text, params);
        });
      },
    };
    const result = await work(context);
    await queue;
    check();
    closed = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    failure ??= error;
    closed = true;
    await queue;
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}
