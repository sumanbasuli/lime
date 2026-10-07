export const MAX_QUEUED_REPORT_REQUESTS = 20;

export class ReportGenerationQueueFullError extends Error {
  constructor() {
    super("PDF report generation queue is full");
    this.name = "ReportGenerationQueueFullError";
  }
}

type WaitingRequest = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
};

class ReportGenerationLimiter {
  private active = 0;
  // Each incoming request supplies the latest settings snapshot for this process.
  private limit = 1;
  private queue: WaitingRequest[] = [];

  private drain() {
    while (this.active < this.limit && this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.signal?.removeEventListener("abort", next.onAbort);
      if (next.signal?.aborted) {
        next.reject(new DOMException("PDF report request was cancelled", "AbortError"));
        continue;
      }
      this.active += 1;
      next.resolve();
    }
  }

  async run<T>(
    limit: number,
    task: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) {
      throw new DOMException("PDF report request was cancelled", "AbortError");
    }

    this.limit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
    this.drain();

    if (this.active >= this.limit || this.queue.length > 0) {
      if (this.queue.length >= MAX_QUEUED_REPORT_REQUESTS) {
        throw new ReportGenerationQueueFullError();
      }

      await new Promise<void>((resolve, reject) => {
        const waiter: WaitingRequest = {
          resolve,
          reject,
          signal,
          onAbort: () => {
            const index = this.queue.indexOf(waiter);
            if (index === -1) {
              return;
            }
            this.queue.splice(index, 1);
            signal?.removeEventListener("abort", waiter.onAbort);
            reject(new DOMException("PDF report request was cancelled", "AbortError"));
            this.drain();
          },
        };

        this.queue.push(waiter);
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        if (signal?.aborted) {
          waiter.onAbort();
        }
      });
    } else {
      this.active += 1;
    }

    try {
      if (signal?.aborted) {
        throw new DOMException("PDF report request was cancelled", "AbortError");
      }
      return await task();
    } finally {
      this.active -= 1;
      this.drain();
    }
  }
}

const globalForReportLimiter = globalThis as typeof globalThis & {
  __limeReportGenerationLimiter?: ReportGenerationLimiter;
};

export const reportGenerationLimiter =
  globalForReportLimiter.__limeReportGenerationLimiter ??
  new ReportGenerationLimiter();

globalForReportLimiter.__limeReportGenerationLimiter = reportGenerationLimiter;
