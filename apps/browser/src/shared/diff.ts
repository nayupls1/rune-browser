// Line diffs for the history view (Myers' algorithm). Common leading and
// trailing lines are trimmed first, and big or very different inputs give up
// rather than use a lot of memory: the caller shows "too large to show".

export interface DiffLine {
  type: " " | "+" | "-";
  text: string;
}

export interface Hunk {
  /** 1-based line numbers where the hunk starts, before and after. */
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

const MAX_LINES = 20_000;
const MAX_EDITS = 2_000;

/** The edit script turning `a` into `b`, or null if it's too big to compute. */
export function diffLines(a: string[], b: string[]): DiffLine[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);
  const head = a.slice(0, start).map((text): DiffLine => ({ type: " ", text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ type: " ", text }));
  const middle = myers(a.slice(start, endA), b.slice(start, endB));
  return middle ? [...head, ...middle, ...tail] : null;
}

function myers(a: string[], b: string[]): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  if (n + m > MAX_LINES) return null;
  if (!n || !m)
    return [...a.map((text): DiffLine => ({ type: "-", text })), ...b.map((text): DiffLine => ({ type: "+", text }))];
  // v[k] = furthest x on diagonal k. trace[d] keeps v for k in [-d, d] at the start of round d.
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
      let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) (x++, y++);
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const at = (k: number) => trace[d]![k + d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) (out.push({ type: " ", text: a[--x]! }), y--);
    if (x === prevX) out.push({ type: "+", text: b[--y]! });
    else out.push({ type: "-", text: a[--x]! });
  }
  // Round 0: the snake from the start.
  while (x > 0) out.push({ type: " ", text: a[--x]! });
  return out.reverse();
}

/** Groups an edit script into hunks with `context` unchanged lines around the changes. */
export function toHunks(lines: DiffLine[], context = 3): Hunk[] {
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: Hunk | null = null;
  let trailing = 0;
  // nextChange[i]: index of the first change after line i.
  const nextChange = new Array<number>(lines.length);
  for (let i = lines.length - 1, next = -1; i >= 0; i--) {
    nextChange[i] = next;
    if (lines[i]!.type !== " ") next = i;
  }
  lines.forEach((line, i) => {
    if (line.type !== " ") {
      if (!current) {
        const lead = lines.slice(Math.max(0, i - context), i).filter((l) => l.type === " ");
        current = { oldStart: oldLine - lead.length, newStart: newLine - lead.length, lines: [...lead] };
        hunks.push(current);
      }
      current.lines.push(line);
      trailing = 0;
    } else if (current) {
      // Keep going while the next change is close enough to share context.
      const next = nextChange[i]!;
      if (trailing < context || (next !== -1 && next - i <= context)) {
        current.lines.push(line);
        trailing++;
      } else current = null;
    }
    if (line.type !== "+") oldLine++;
    if (line.type !== "-") newLine++;
  });
  return hunks;
}
