import { drizzle } from "drizzle-orm/node-postgres";
import { Client, type QueryResult, type QueryResultRow } from "pg";
import type { db } from "@/db";
import * as schema from "@/db/schema";

const PREPARATION_BYTES = 32 * 1024 * 1024;
const PREPARATION_ROWS = 16_384;
const PREPARATION_TIMEOUT_MS = 30_000;

type ReportSelect<T> = PromiseLike<T[]> & {
  toSQL(): { sql: string; params: unknown[] };
};

type ScoreCacheWrite = Pick<ReportSelect<never>, "toSQL">;

export interface ReportReadContext {
  db: Omit<typeof db, "$client">;
  read<T>(query: ReportSelect<T>, columns: number): Promise<T[]>;
  query<R extends QueryResultRow>(text: string, values: unknown[], columns: number): Promise<QueryResult<R>>;
  stageScoreCache?(query: ScoreCacheWrite): void;
  check(): void;
}

export class McpReportPreparationLimitError extends Error {
  constructor() {
    super("Artifact exceeds the MCP report preparation limit. Use download_path for the complete file.");
  }
}

export class McpReadPreparationBusyError extends Error {
  constructor() {
    super("MCP database read capacity is busy. Retry after 1 second.");
  }
}

const globalForMcpPreparation = globalThis as typeof globalThis & {
  __limeMcpReadPreparations?: { active: number };
};
const preparations = globalForMcpPreparation.__limeMcpReadPreparations ?? { active: 0 };
globalForMcpPreparation.__limeMcpReadPreparations = preparations;

export async function readReportQuery<T>(
  query: ReportSelect<T>,
  context: ReportReadContext | undefined,
  columns: number,
): Promise<T[]> {
  return context ? context.read(query, columns) : await query;
}

function isServerError(error: unknown): boolean {
  for (let value = error, depth = 0; value && typeof value === "object" && depth < 4; depth++) {
    if ("severity" in value && typeof value.severity === "string" && "code" in value && typeof value.code === "string") return true;
    value = "cause" in value ? value.cause : undefined;
  }
  return false;
}

// Only trusted in-process MCP callers receive this context; HTTP parameters
// cannot enable it or relax ordinary report behavior.
export async function withMcpReportRead<T>(
  callerSignal: AbortSignal,
  work: (context: ReportReadContext) => Promise<T>,
  options: { scoreCacheScanId?: string } = {},
): Promise<T> {
  callerSignal.throwIfAborted();
  if (preparations.active >= 2) throw new McpReadPreparationBusyError();
  preparations.active++;
  try {
    return await runMcpReportRead(callerSignal, work, options);
  } finally {
    preparations.active--;
  }
}

async function runMcpReportRead<T>(
  callerSignal: AbortSignal,
  work: (context: ReportReadContext) => Promise<T>,
  options: { scoreCacheScanId?: string },
): Promise<T> {
  callerSignal.throwIfAborted();
  const deadline = Date.now() + PREPARATION_TIMEOUT_MS;
  const timeout = new AbortController();
  const signal = AbortSignal.any([callerSignal, timeout.signal]);
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
    application_name: "lime-mcp-report",
  });
  const timer = setTimeout(() => timeout.abort(), PREPARATION_TIMEOUT_MS);
  timer.unref?.();
  let failure: unknown;
  let failed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let activeUntil = 0;
  let orphanUntil = 0;
  let bytes = BigInt(0);
  let rows = BigInt(0);
  let snapshotClosed = false;
  let scoreCacheWrite: { sql: string; params: unknown[] } | undefined;
  const fail = (error: unknown) => {
    if (!failed) { failed = true; failure = error; }
  };
  const close = () => closing ??= client.end().catch(() => {});
  const abort = () => {
    fail(new Error("MCP report preparation cancelled or timed out."));
    orphanUntil = Math.max(orphanUntil, activeUntil);
    void close();
  };
  const onError = (error: Error) => {
    fail(error);
    orphanUntil = Math.max(orphanUntil, activeUntil);
  };
  client.on("error", onError);
  signal.addEventListener("abort", abort, { once: true });
  const check = () => {
    if (failed) throw failure;
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("MCP report preparation timed out.");
  };
  const statement = async <R>(execute: () => Promise<R>, allowance: number): Promise<R> => {
    check();
    activeUntil = Date.now() + allowance;
    try {
      return await execute();
    } catch (error) {
      // A server SQL error confirms that statement ended. A broken connection
      // alone does not prove PostgreSQL noticed the disconnect during execution.
      if (!isServerError(error)) orphanUntil = Math.max(orphanUntil, activeUntil);
      fail(error);
      throw error;
    } finally {
      activeUntil = 0;
    }
  };
  const boundedStatement = async <R>(execute: () => Promise<R>): Promise<R> => {
    check();
    const allowance = Math.max(1, deadline - Date.now());
    await statement(
      () => client.query("SELECT set_config('statement_timeout', $1, true)", [`${allowance}ms`]),
      PREPARATION_TIMEOUT_MS,
    );
    check();
    return statement(execute, allowance);
  };
  const enqueue = <R>(execute: () => Promise<R>): Promise<R> => {
    const next = queue.then(() => { check(); return execute(); });
    queue = next.catch((error) => { fail(error); });
    return next;
  };
  const admit = async (text: string, values: unknown[], columns: number) => {
    if (snapshotClosed) throw new Error("MCP read snapshot is closed.");
    if (!Number.isSafeInteger(columns) || columns < 1 || columns > 128) throw new Error("Invalid report projection.");
    const names = Array.from({ length: columns }, (_, index) => `"c${index}"`);
    const textBytes = names.map((name) => `COALESCE(octet_length(${name}::text)::numeric, 0)`).join(" + ");
    // The false UNION arm verifies the exact column count before any raw rows
    // are fetched. Measure logical TEXT, not compressed/TOAST storage size.
    const measured = await boundedStatement(() => client.query<{ row_count: string; byte_count: string }>(
      `WITH mcp_report_rows (${names.join(", ")}) AS (
         (${text}) UNION ALL SELECT ${names.map(() => "NULL").join(", ")} WHERE false
       )
       SELECT count(*)::text AS row_count,
         COALESCE(sum(1024::numeric + 6 * (${textBytes})), 0)::text AS byte_count
       FROM mcp_report_rows`,
      values,
    ));
    const count = BigInt(measured.rows[0].row_count);
    const size = BigInt(measured.rows[0].byte_count);
    if (count < BigInt(0) || size < BigInt(0) || rows + count > BigInt(PREPARATION_ROWS) || bytes + size > BigInt(PREPARATION_BYTES)) {
      throw new McpReportPreparationLimitError();
    }
    rows += count;
    bytes += size;
  };

  try {
    if (signal.aborted) abort();
    check();
    // pg can leave connect() pending when end() interrupts its startup handshake.
    let connectAbort = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        connectAbort = () => reject(new Error("MCP report connection cancelled or timed out."));
        signal.addEventListener("abort", connectAbort, { once: true });
        client.connect().then(() => resolve(), reject);
        if (signal.aborted) connectAbort();
      });
    } finally {
      signal.removeEventListener("abort", connectAbort);
    }
    check();
    await statement(() => client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"), PREPARATION_TIMEOUT_MS);
    await statement(() => client.query("SET LOCAL statement_timeout = '30000ms'"), PREPARATION_TIMEOUT_MS);
    const context: ReportReadContext = {
      db: drizzle(client, { schema }),
      check,
      read(query, columns) {
        return enqueue(async () => {
          const prepared = query.toSQL();
          await admit(prepared.sql, prepared.params, columns);
          return boundedStatement(async () => await query);
        });
      },
      query<R extends QueryResultRow>(text: string, values: unknown[], columns: number) {
        return enqueue(async () => {
          await admit(text, values, columns);
          return boundedStatement(() => client.query<R>(text, values));
        });
      },
    };
    if (options.scoreCacheScanId) {
      context.stageScoreCache = (query) => {
        check();
        const prepared = query.toSQL();
        // Only the existing fixed-scalar cache upsert for this scan may write.
        if (scoreCacheWrite || snapshotClosed ||
          !prepared.sql.startsWith('insert into "scan_score_summary_cache" ') ||
          prepared.sql.length > 65_536 || /;|\breturning\b/i.test(prepared.sql) ||
          prepared.params.length > 128 || prepared.params[0] !== options.scoreCacheScanId ||
          prepared.params.some((value) => value !== null &&
            !(typeof value === "string" && Buffer.byteLength(value) <= 4096) &&
            !(typeof value === "number" && Number.isFinite(value)) &&
            typeof value !== "boolean" && !(value instanceof Date && Number.isFinite(value.getTime())))) {
          throw new Error("Invalid MCP score cache publication.");
        }
        scoreCacheWrite = { sql: prepared.sql, params: prepared.params.map((value) =>
          value instanceof Date ? new Date(value.getTime()) : value) };
      };
    }
    const result = await work(context);
    await queue;
    check();
    if (scoreCacheWrite) {
      const write = scoreCacheWrite;
      snapshotClosed = true;
      await boundedStatement(() => client.query("COMMIT"));
      // READ COMMITTED keeps simultaneous cold-cache upserts compatible.
      await statement(() => client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE"), PREPARATION_TIMEOUT_MS);
      await statement(() => client.query("SET LOCAL statement_timeout = '30000ms'"), PREPARATION_TIMEOUT_MS);
      await boundedStatement(() => client.query(write.sql, write.params));
      await boundedStatement(() => client.query("COMMIT"));
    }
    check();
    return result;
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await close();
    await queue;
    // Keep the caller's admission lease until any disconnected SQL reaches its
    // enforced statement deadline; dropping the socket is not a CancelRequest.
    if (orphanUntil > Date.now()) await new Promise((resolve) => setTimeout(resolve, orphanUntil - Date.now()));
    client.off("error", onError);
  }
}
