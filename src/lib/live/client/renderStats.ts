const WINDOW_SIZE = 40;

export type RenderPercentiles = { p50: number; p95: number; count: number };

const percentile = (sorted: number[], p: number): number => {
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
};

export class RenderStatsTracker {
  private samples: number[] = [];

  record(renderMs: number): void {
    this.samples.push(renderMs);
    if (this.samples.length > WINDOW_SIZE) {
      this.samples.shift();
    }
  }

  snapshot(): RenderPercentiles | null {
    if (this.samples.length === 0) {
      return null;
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      count: sorted.length,
    };
  }
}
