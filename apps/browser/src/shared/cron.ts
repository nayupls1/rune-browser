// Cron expressions for schedules: "minute hour day-of-month month day-of-week"
// in local time, with *, lists (1,15), ranges (1-5) and steps (*/15, 8-18/2).
// When both day fields are restricted, either may match (as in cron).

interface Field {
  readonly values: ReadonlySet<number>;
  readonly any: boolean;
}

export interface Cron {
  readonly minute: Field;
  readonly hour: Field;
  readonly day: Field;
  readonly month: Field;
  readonly weekday: Field;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const NAMES = ["minute", "hour", "day of month", "month", "day of week"];

function parseField(text: string, [min, max]: [number, number], name: string): Field | string {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) return `Can't read the ${name} "${part}"`;
    const step = match[4] ? Number(match[4]) : 1;
    const from = match[1] === "*" ? min : Number(match[2]);
    const to = match[1] === "*" ? max : match[3] ? Number(match[3]) : match[4] ? max : from;
    if (from < min || to > max || from > to || step < 1) return `The ${name} must be between ${min} and ${max}`;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, any: text === "*" };
}

/** The expression, or what's wrong with it. */
export function parseCron(expression: string): Cron | string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return "A schedule has five parts: minute hour day month weekday (e.g. 0 8 * * 1-5)";
  const fields: Field[] = [];
  for (let i = 0; i < 5; i++) {
    const field = parseField(parts[i]!, RANGES[i]!, NAMES[i]!);
    if (typeof field === "string") return field;
    fields.push(field);
  }
  const weekday = fields[4]!;
  // 7 is Sunday too.
  if (weekday.values.has(7)) (weekday.values as Set<number>).add(0);
  return { minute: fields[0]!, hour: fields[1]!, day: fields[2]!, month: fields[3]!, weekday };
}

const dayMatches = (cron: Cron, date: Date) => {
  const dom = cron.day.values.has(date.getDate());
  const dow = cron.weekday.values.has(date.getDay());
  if (cron.day.any && cron.weekday.any) return true;
  if (cron.day.any) return dow;
  if (cron.weekday.any) return dom;
  return dom || dow;
};

/** The first time after `after` (to the minute) that the expression matches; null if none within ~4 years. */
export function nextCron(cron: Cron, after: Date): Date | null {
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = after.getTime() + 4 * 366 * 24 * 3600_000;
  while (t.getTime() <= limit) {
    if (!cron.month.values.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(cron, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hour.values.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minute.values.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

/** The shortest gap between runs in the next few days (to keep schedules from running too often). */
export function shortestGapMinutes(cron: Cron, from = new Date()): number {
  let previous = nextCron(cron, from);
  let shortest = Infinity;
  for (let i = 0; previous && i < 200; i++) {
    const next = nextCron(cron, previous);
    if (!next) break;
    shortest = Math.min(shortest, (next.getTime() - previous.getTime()) / 60_000);
    previous = next;
  }
  return shortest;
}

// --- Repeats: the friendly schedules the Schedules page offers, as cron expressions ---------------

/** A repeating schedule as people pick it. Times are "H:MM" (24 h, local). */
export type Repeat =
  | { every: "minutes"; n: number }
  | { every: "hours"; n: number; minute: number }
  | { every: "day"; time: string }
  | { every: "weekdays"; time: string }
  /** Days of the week: 0 is Sunday. */
  | { every: "week"; days: number[]; time: string }
  | { every: "month"; day: number; time: string };

export const MINUTE_STEPS = [5, 10, 15, 20, 30];
/** Hours that divide the day, so runs are evenly apart. */
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];

const clock = (time: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  const [h, min] = m ? [Number(m[1]), Number(m[2])] : [9, 0];
  return { h: Math.min(23, h), min: Math.min(59, min) };
};

/** The cron expression for a repeat. */
export function repeatToCron(repeat: Repeat): string {
  switch (repeat.every) {
    case "minutes":
      return `*/${repeat.n} * * * *`;
    case "hours":
      return `${repeat.minute} ${repeat.n === 1 ? "*" : `*/${repeat.n}`} * * *`;
    case "day":
    case "weekdays":
    case "week":
    case "month": {
      const { h, min } = clock(repeat.time);
      const days =
        repeat.every === "weekdays"
          ? "1-5"
          : repeat.every === "week"
            ? [...new Set(repeat.days)].sort((a, b) => a - b).join(",") || "*"
            : "*";
      return `${min} ${h} ${repeat.every === "month" ? repeat.day : "*"} * ${days}`;
    }
  }
}

const fixed = (s: string) => /^\d+$/.test(s);

/** The repeat a cron expression is, if it's one the page offers (null: a custom one). */
export function cronToRepeat(expression: string): Repeat | null {
  const parsed = parseCron(expression);
  if (typeof parsed === "string") return null;
  const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/) as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (month !== "*") return null;
  const step = (s: string) => (/^\*\/\d+$/.test(s) ? Number(s.slice(2)) : null);
  if (hour === "*" && day === "*" && weekday === "*") {
    const n = step(minute);
    if (n && 60 % n === 0) return { every: "minutes", n };
    if (fixed(minute)) return { every: "hours", n: 1, minute: Number(minute) };
    return null;
  }
  const hours = step(hour);
  if (hours && 24 % hours === 0 && fixed(minute) && day === "*" && weekday === "*")
    return { every: "hours", n: hours, minute: Number(minute) };
  if (!fixed(minute) || !fixed(hour)) return null;
  const time = `${Number(hour)}:${pad(Number(minute))}`;
  if (fixed(day) && weekday === "*") return { every: "month", day: Number(day), time };
  if (day !== "*") return null;
  const days = [...parsed.weekday.values].map((d) => d % 7);
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (weekday === "*" || set.length === 7) return { every: "day", time };
  if (set.join() === "1,2,3,4,5") return { every: "weekdays", time };
  return { every: "week", days: set, time };
}

const pad = (n: number) => String(n).padStart(2, "0");
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const ordinal = (n: number) => {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** "Monday", "Monday and Friday", "Monday, Wednesday and Friday" (the week starting on Monday). */
const dayList = (days: number[]) => {
  const names = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WEEKDAYS[d % 7]!);
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

/** A repeat in words: "Every weekday at 9:00", "Every 2 hours", "Every month on the 1st at 8:30". */
export function describeRepeat(repeat: Repeat): string {
  switch (repeat.every) {
    case "minutes":
      return `Every ${repeat.n} minutes`;
    case "hours": {
      const at = repeat.minute ? ` at :${pad(repeat.minute)}` : "";
      return repeat.n === 1 ? `Every hour${at}` : `Every ${repeat.n} hours${at}`;
    }
    case "day":
      return `Every day at ${repeat.time}`;
    case "weekdays":
      return `Every weekday at ${repeat.time}`;
    case "week":
      return `Every ${dayList(repeat.days)} at ${repeat.time}`;
    case "month":
      return `Every month on the ${ordinal(repeat.day)} at ${repeat.time}`;
  }
}

/** A cron expression in words when it's a repeat the page offers; others as they are. */
export function describeCron(expression: string): string {
  const repeat = cronToRepeat(expression);
  return repeat ? describeRepeat(repeat) : expression;
}
