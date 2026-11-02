// A full report may have many issue groups, and each group starts several
// database reads. Share this budget across failed and needs-review groups.
const REPORT_GROUP_CONCURRENCY = 2;

export interface ReportGroupScheduler {
  run<R>(load: () => Promise<R>): Promise<R>;
  abort(error: unknown): void;
}

export function createReportGroupScheduler(): ReportGroupScheduler {
  let active = 0;
  let failed = false;
  let firstError: unknown;
  const waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  function abort(error: unknown): void {
    if (failed) return;
    failed = true;
    firstError = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  }

  return {
    abort,
    async run<R>(load: () => Promise<R>): Promise<R> {
      if (failed) throw firstError;
      if (active < REPORT_GROUP_CONCURRENCY) {
        active++;
      } else {
        await new Promise<void>((resolve, reject) => {
          waiters.push({ resolve, reject });
        });
        // A different active group can fail after this permit is transferred
        // but before this waiter resumes. Return the permit without starting
        // another database read in that case.
        if (failed) {
          active--;
          throw firstError;
        }
      }

      try {
        return await load();
      } catch (error) {
        abort(error);
        throw error;
      } finally {
        const next = failed ? undefined : waiters.shift();
        if (next) next.resolve();
        else active--;
      }
    },
  };
}

export async function mapReportGroups<T, R>(
  items: readonly T[],
  load: (item: T) => Promise<R>,
  scheduler: ReportGroupScheduler
): Promise<R[]> {
  const groups = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(items.length, REPORT_GROUP_CONCURRENCY) },
      async () => {
        while (nextIndex < items.length) {
          const index = nextIndex++;
          groups[index] = await scheduler.run(() => load(items[index]));
        }
      }
    )
  );
  return groups;
}
