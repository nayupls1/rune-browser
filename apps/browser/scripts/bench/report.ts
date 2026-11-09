// Turns a run's results into a report: each metric's median in Rune and in Chrome, how far apart they are
// (and whether that's more than the noise between runs), where Rune is past what users notice, and what
// changed since a baseline run.
import type { BrowserName } from "./browsers";
import type { Entry, Metric } from "./results";
import { geomean, median, separation } from "./stats";

export interface Environment {
  date: string;
  commit: string;
  os: string;
  cpu: string;
  memoryGB: number;
  headed: boolean;
  viewport: string;
  runs: number;
  browsers: Partial<Record<BrowserName, { version: string; gpu: string }>>;
}

export interface Saved {
  version: 1;
  env: Environment;
  entries: Entry[];
  notes: string[];
}

/** Rune against Chrome (or now against before): > 1 means worse, whichever way the metric is better. */
export function badness(m: Metric, value: number, reference: number) {
  if (!(reference > 0) || !(value > 0)) return NaN;
  return m.better === "lower" ? value / reference : reference / value;
}

/** Is a difference real: beyond the noise between runs, and not a rounding-sized one. */
function significant(m: Metric, a: number[], b: number[], ratio: number) {
  // A run or two can't tell noise from a difference.
  if (a.length < 3 || b.length < 3) return false;
  const tiny = { ms: 2, MB: 2, "%": 0.5, fps: 1, count: 0.5, score: 0.01 }[m.unit];
  return Math.abs(median(a) - median(b)) > tiny && Math.abs(ratio - 1) > 0.05 && separation(a, b) > 2;
}

export interface Row {
  metric: Metric;
  rune?: number;
  chrome?: number;
  /** Rune vs Chrome (> 1: Rune is worse). */
  ratio?: number;
  vsChrome?: "worse" | "better" | "same";
  overBudget: boolean;
  baseline?: number;
  /** Now vs the baseline (> 1: worse now). */
  change?: number;
  vsBaseline?: "regressed" | "improved" | "same";
}

export function rows(entries: Entry[], baseline?: Entry[]): Row[] {
  const before = new Map((baseline ?? []).map((e) => [e.metric.id, e]));
  return entries.map(({ metric, values }) => {
    const r = values.rune;
    const c = values.chrome;
    const row: Row = { metric, overBudget: false };
    if (r?.length) row.rune = median(r);
    if (c?.length) row.chrome = median(c);
    if (r?.length && c?.length) {
      row.ratio = badness(metric, row.rune!, row.chrome!);
      row.vsChrome = significant(metric, r, c, row.ratio) ? (row.ratio > 1 ? "worse" : "better") : "same";
    }
    if (metric.budget !== undefined && row.rune !== undefined)
      row.overBudget = metric.better === "lower" ? row.rune > metric.budget : row.rune < metric.budget;
    const b = before.get(metric.id)?.values.rune;
    if (r?.length && b?.length) {
      row.baseline = median(b);
      row.change = badness(metric, row.rune!, row.baseline);
      row.vsBaseline = significant(metric, r, b, row.change) ? (row.change > 1 ? "regressed" : "improved") : "same";
    }
    return row;
  });
}

const fmt = (v: number | undefined, unit: string) => {
  if (v === undefined || !Number.isFinite(v)) return "–";
  const digits = unit === "score" ? 3 : Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${unit === "count" || unit === "score" ? "" : unit}`.trim();
};
const times = (ratio: number | undefined) => {
  if (ratio === undefined || !Number.isFinite(ratio)) return "–";
  if (ratio >= 1) return `${ratio.toFixed(2)}× worse`;
  return `${(1 / ratio).toFixed(2)}× better`;
};

/** Geometric mean of Rune vs Chrome over a set of rows: one number for "how does Rune compare". */
export function score(list: Row[]) {
  return geomean(list.filter((r) => r.ratio !== undefined).map((r) => r.ratio!));
}

export function markdown(saved: Saved, baseline?: Saved) {
  const all = rows(saved.entries, baseline?.entries);
  const env = saved.env;
  const out: string[] = [];
  out.push(`# Rune Browser benchmarks`, "");
  out.push(
    `${env.date} · commit \`${env.commit}\` · ${env.os} · ${env.cpu} · ${env.memoryGB} GB · ${env.headed ? "windows on screen" : "headless"} · viewport ${env.viewport} · ${env.runs} runs (median)`,
    "",
  );
  for (const [name, b] of Object.entries(env.browsers)) out.push(`- **${name}**: ${b.version} — GPU: ${b.gpu}`);
  out.push("");

  const groups = [...new Set(all.map((r) => r.metric.group))];
  const comparable = all.filter((r) => r.ratio !== undefined);
  if (comparable.length) {
    out.push(`## Rune vs Chrome`, "");
    out.push(
      `Geometric mean of Rune ÷ Chrome over every metric both have, oriented so that **above 1.00 means Rune is worse**.`,
      "",
    );
    out.push(`| Area | Rune vs Chrome | Metrics | Rune worse | Rune better |`, `| --- | --- | --- | --- | --- |`);
    out.push(
      `| **All** | **${times(score(comparable))}** | ${comparable.length} | ${comparable.filter((r) => r.vsChrome === "worse").length} | ${comparable.filter((r) => r.vsChrome === "better").length} |`,
    );
    for (const g of groups) {
      const list = comparable.filter((r) => r.metric.group === g);
      if (list.length)
        out.push(
          `| ${g} | ${times(score(list))} | ${list.length} | ${list.filter((r) => r.vsChrome === "worse").length} | ${list.filter((r) => r.vsChrome === "better").length} |`,
        );
    }
    out.push("");
    const worst = comparable
      .filter((r) => r.vsChrome === "worse")
      .sort((a, b) => b.ratio! - a.ratio!)
      .slice(0, 15);
    if (worst.length) {
      out.push(`### Where Rune is furthest behind`, "", `| Metric | Rune | Chrome | |`, `| --- | --- | --- | --- |`);
      for (const r of worst)
        out.push(
          `| ${r.metric.label} | ${fmt(r.rune, r.metric.unit)} | ${fmt(r.chrome, r.metric.unit)} | ${times(r.ratio)} |`,
        );
      out.push("");
    }
  }

  const over = all.filter((r) => r.overBudget);
  if (over.length) {
    out.push(`## Past what users notice`, "");
    out.push(`Rune's median beyond the point where people notice (a hitch, a wait, a stutter).`, "");
    out.push(`| Metric | Rune | Noticeable at | Chrome |`, `| --- | --- | --- | --- |`);
    for (const r of over)
      out.push(
        `| ${r.metric.label} | **${fmt(r.rune, r.metric.unit)}** | ${r.metric.better === "lower" ? "> " : "< "}${fmt(r.metric.budget, r.metric.unit)} | ${fmt(r.chrome, r.metric.unit)} |`,
      );
    out.push("");
  }

  if (baseline) {
    const changed = all.filter((r) => r.vsBaseline === "regressed" || r.vsBaseline === "improved");
    out.push(`## Since the baseline`, "");
    out.push(
      `Baseline: ${baseline.env.date}, commit \`${baseline.env.commit}\`. Changes beyond the noise between runs.`,
      "",
    );
    if (!changed.length) out.push("Nothing changed beyond the noise.", "");
    else {
      out.push(`| Metric | Before | Now | Change |`, `| --- | --- | --- | --- |`);
      for (const r of changed.sort((a, b) => b.change! - a.change!))
        out.push(
          `| ${r.vsBaseline === "regressed" ? "🔴" : "🟢"} ${r.metric.label} | ${fmt(r.baseline, r.metric.unit)} | ${fmt(r.rune, r.metric.unit)} | ${times(r.change)} |`,
        );
      out.push("");
    }
  }

  out.push(`## All results`, "");
  for (const g of groups) {
    out.push(`### ${g}`, "");
    out.push(
      `| Metric | Rune | Chrome | Rune vs Chrome | Noticeable at${baseline ? " | vs baseline" : ""} |`,
      `| --- | --- | --- | --- | ---${baseline ? " | ---" : ""} |`,
    );
    for (const r of all.filter((x) => x.metric.group === g)) {
      const vs = r.ratio === undefined ? "–" : r.vsChrome === "same" ? `≈ (${times(r.ratio)})` : times(r.ratio);
      const budget =
        r.metric.budget === undefined
          ? ""
          : `${r.metric.better === "lower" ? ">" : "<"} ${fmt(r.metric.budget, r.metric.unit)}`;
      const base =
        r.change === undefined
          ? "–"
          : r.vsBaseline === "same"
            ? "≈"
            : `${r.vsBaseline === "regressed" ? "🔴" : "🟢"} ${times(r.change)}`;
      out.push(
        `| ${r.metric.label} | ${r.overBudget ? "⚠️ " : ""}${fmt(r.rune, r.metric.unit)} | ${fmt(r.chrome, r.metric.unit)} | ${vs} | ${budget}${baseline ? ` | ${base}` : ""} |`,
      );
    }
    out.push("");
  }
  if (saved.notes.length) out.push(`## Notes`, "", ...saved.notes.map((n) => `- ${n}`), "");
  return out.join("\n");
}

/** A short summary for the terminal. */
export function summary(saved: Saved, baseline?: Saved) {
  const all = rows(saved.entries, baseline?.entries);
  const lines: string[] = [];
  const comparable = all.filter((r) => r.ratio !== undefined);
  if (comparable.length) {
    lines.push(`Rune vs Chrome, all ${comparable.length} shared metrics: ${times(score(comparable))}`);
    for (const g of [...new Set(comparable.map((r) => r.metric.group))])
      lines.push(`  ${g.padEnd(28)} ${times(score(comparable.filter((r) => r.metric.group === g)))}`);
  }
  const over = all.filter((r) => r.overBudget);
  if (over.length) {
    lines.push("", `Past what users notice (${over.length}):`);
    for (const r of over.slice(0, 20))
      lines.push(
        `  ⚠ ${r.metric.label}: ${fmt(r.rune, r.metric.unit)} (noticeable at ${fmt(r.metric.budget, r.metric.unit)})`,
      );
  }
  const regressed = all.filter((r) => r.vsBaseline === "regressed");
  const improved = all.filter((r) => r.vsBaseline === "improved");
  if (baseline) {
    lines.push("", `Since the baseline: ${regressed.length} regressed, ${improved.length} improved`);
    for (const r of regressed)
      lines.push(
        `  🔴 ${r.metric.label}: ${fmt(r.baseline, r.metric.unit)} → ${fmt(r.rune, r.metric.unit)} (${times(r.change)})`,
      );
    for (const r of improved)
      lines.push(
        `  🟢 ${r.metric.label}: ${fmt(r.baseline, r.metric.unit)} → ${fmt(r.rune, r.metric.unit)} (${times(r.change)})`,
      );
  }
  return { text: lines.join("\n"), regressed };
}
