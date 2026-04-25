class ReportGenerationLimiter {
  private active = 0;
  private queue: Array<() => void> = [];

  async run<T>(limit: number, task: () => Promise<T>): Promise<T> {
    const normalizedLimit = Math.max(1, Math.trunc(limit));

    if (this.active >= normalizedLimit) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.active += 1;
    try {
      return await task();
    } finally {
      this.active = Math.max(0, this.active - 1);
      const next = this.queue.shift();
      if (next) {
        next();
      }
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
