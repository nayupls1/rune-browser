// What a benchmark run collects: metrics (with what's better, and the point where users notice), and the
// values each browser got for them, run after run.
import type { BrowserName } from "./browsers";

export type Unit = "ms" | "MB" | "%" | "fps" | "count" | "score";

export interface Metric {
  id: string;
  label: string;
  unit: Unit;
  better: "lower" | "higher";
  /** Past this, people notice (a hitch, a wait, a stutter): from RAIL, Core Web Vitals and frame budgets. */
  budget?: number;
  /** For the report's sections. */
  group: string;
}

export interface Entry {
  metric: Metric;
  values: Partial<Record<BrowserName, number[]>>;
}

export class Results {
  readonly entries = new Map<string, Entry>();
  readonly notes: string[] = [];

  record(browser: BrowserName, metric: Metric, value: number) {
    if (!Number.isFinite(value)) return;
    const entry = this.entries.get(metric.id) ?? { metric, values: {} };
    (entry.values[browser] ??= []).push(value);
    this.entries.set(metric.id, entry);
  }

  note(text: string) {
    if (!this.notes.includes(text)) this.notes.push(text);
  }

  toJSON() {
    return { entries: [...this.entries.values()], notes: this.notes };
  }
}

/** Budgets: where users start to notice. */
export const BUDGET = {
  /** RAIL: a response within 100 ms feels immediate. */
  response: 100,
  /** A keystroke should show within a few frames. */
  keystroke: 50,
  /** A frame at 60 Hz. */
  frame: 1000 / 60,
  /** A long task: input that arrives meanwhile waits. */
  longTask: 50,
  /** The UI stopping for this long is a visible hitch. */
  hitch: 100,
  fcp: 1800,
  lcp: 2500,
  cls: 0.1,
  tbt: 200,
  droppedFrames: 5,
  /** A browser doing nothing shouldn't keep a core busier than this (battery, fans). */
  idleCpu: 1,
} as const;

export const metric = (
  group: string,
  id: string,
  label: string,
  unit: Unit,
  better: "lower" | "higher" = "lower",
  budget?: number,
): Metric => ({ group, id, label, unit, better, budget });
