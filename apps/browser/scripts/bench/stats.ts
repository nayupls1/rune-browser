// Small statistics helpers for the benchmarks: medians and percentiles of repeated runs, and whether two
// sets of runs differ by more than their noise.

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);

/** The p-th percentile (0–100) by linear interpolation; NaN for no values. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export const median = (xs: number[]) => percentile(xs, 50);
export const max = (xs: number[]) => (xs.length ? Math.max(...xs) : NaN);

/** Median absolute deviation, scaled to be comparable to a standard deviation. */
export function mad(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

/** How far apart the medians of two sets of runs are, in units of their combined noise (robust z-score). */
export function separation(a: number[], b: number[]): number {
  const noise = Math.hypot(mad(a) / Math.sqrt(a.length || 1), mad(b) / Math.sqrt(b.length || 1));
  const diff = Math.abs(median(a) - median(b));
  if (noise === 0) return diff === 0 ? 0 : Infinity;
  return diff / noise;
}

/** Geometric mean of positive numbers (for averaging ratios). */
export function geomean(xs: number[]): number {
  const ok = xs.filter((x) => x > 0 && Number.isFinite(x));
  if (!ok.length) return NaN;
  return Math.exp(sum(ok.map(Math.log)) / ok.length);
}

/** Frame statistics from a list of frame intervals (ms between consecutive frames). */
export function frameStats(intervals: number[], refreshMs = 1000 / 60) {
  const total = sum(intervals);
  // A frame that took longer than one and a half refresh intervals missed at least one vsync.
  const dropped = sum(intervals.map((d) => Math.max(0, Math.round(d / refreshMs) - 1)));
  const expected = Math.max(1, Math.round(total / refreshMs));
  return {
    fps: total > 0 ? (intervals.length * 1000) / total : 0,
    droppedPct: (100 * dropped) / expected,
    p95: percentile(intervals, 95),
    max: max(intervals),
  };
}
