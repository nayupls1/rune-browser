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

/** How many ways each value of U can come out for samples of n and m without ties (exact distribution). */
const uCounts = new Map<string, number[]>();
function countsOfU(n: number, m: number): number[] {
  const key = `${n},${m}`;
  const cached = uCounts.get(key);
  if (cached) return cached;
  let counts: number[];
  if (n === 0 || m === 0) counts = [1];
  else {
    // Either the largest value is from the first sample (it beats all m of the second) or from the second.
    const a = countsOfU(n - 1, m);
    const b = countsOfU(n, m - 1);
    counts = Array.from({ length: n * m + 1 }, (_, u) => (u >= m ? (a[u - m] ?? 0) : 0) + (b[u] ?? 0));
  }
  uCounts.set(key, counts);
  return counts;
}

/**
 * Mann–Whitney U test, two-sided: the probability of samples at least this far apart if both came from the
 * same distribution. It makes no assumption about the shape of the noise (frame times and load times are
 * anything but normal). Exact for small samples (ties get mid-ranks), normal approximation beyond.
 */
export function mannWhitneyP(a: number[], b: number[]): number {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 1;
  const all = [...a.map((v) => ({ v, first: true })), ...b.map((v) => ({ v, first: false }))].sort((x, y) => x.v - y.v);
  let rankSum = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.v === all[i]!.v) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (all[k]!.first) rankSum += rank;
    i = j + 1;
  }
  const u1 = rankSum - (n * (n + 1)) / 2;
  const u = Math.min(u1, n * m - u1);
  if (n <= 12 && m <= 12) {
    const counts = countsOfU(n, m);
    const total = sum(counts);
    let below = 0;
    for (let k = 0; k <= Math.floor(u + 1e-9); k++) below += counts[k]!;
    return Math.min(1, (2 * below) / total);
  }
  const mu = (n * m) / 2;
  const sigma = Math.sqrt((n * m * (n + m + 1)) / 12);
  const z = (u - mu + 0.5) / sigma;
  return Math.min(1, 2 * normalCdf(z));
}

function normalCdf(z: number) {
  // Abramowitz and Stegun 7.1.26.
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z < 0 ? (1 - erf) / 2 : (1 + erf) / 2;
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
