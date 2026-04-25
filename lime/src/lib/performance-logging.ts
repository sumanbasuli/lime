const DEFAULT_SLOW_MS = 750;

function shouldLogPerformance(durationMs: number, thresholdMs: number): boolean {
  if (process.env.LIME_PERF_LOG === "true") {
    return true;
  }

  if (process.env.LIME_PERF_LOG === "false") {
    return false;
  }

  return process.env.NODE_ENV !== "production" && durationMs >= thresholdMs;
}

export async function measureServerAction<T>(
  label: string,
  action: () => Promise<T>,
  thresholdMs = DEFAULT_SLOW_MS
): Promise<T> {
  const start = performance.now();

  try {
    return await action();
  } finally {
    const durationMs = performance.now() - start;
    if (shouldLogPerformance(durationMs, thresholdMs)) {
      console.info(
        `[perf] ${label} ${durationMs.toFixed(1)}ms`
      );
    }
  }
}
