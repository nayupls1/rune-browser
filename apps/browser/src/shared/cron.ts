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

const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Common expressions in words ("Every day at 08:00"); others as they are. */
export function describeCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  const fixed = (s: string) => /^\d+$/.test(s);
  if (/^\*\/\d+$/.test(minute) && hour === "*" && day === "*" && month === "*" && weekday === "*")
    return `Every ${minute.slice(2)} minutes`;
  if (fixed(minute) && hour === "*" && day === "*" && month === "*" && weekday === "*")
    return `Every hour at :${pad(Number(minute))}`;
  if (fixed(minute) && /^\*\/\d+$/.test(hour) && day === "*" && month === "*" && weekday === "*")
    return `Every ${hour.slice(2)} hours at :${pad(Number(minute))}`;
  if (!fixed(minute) || !fixed(hour)) return expression;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (day === "*" && month === "*" && weekday === "*") return `Every day at ${time}`;
  if (day === "*" && month === "*" && weekday === "1-5") return `Weekdays at ${time}`;
  if (day === "*" && month === "*" && /^[0-7]$/.test(weekday))
    return `Every ${WEEKDAYS[Number(weekday) % 7]} at ${time}`;
  if (fixed(day) && month === "*" && weekday === "*") return `Monthly on day ${day} at ${time}`;
  return expression;
}
