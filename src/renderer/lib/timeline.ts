// The agent chat as a timeline (components/ChatTimeline.tsx): messages,
// runs of tool calls grouped and summed up, and where each turn ended.
import { parseToolActivity, type ChatMessage, type ToolActivity, type ToolKind } from "../../shared/api";

// --- Rows -------------------------------------------------------------------------------

export interface WorkEntry {
  id: number;
  activity: ToolActivity;
}

export type Row =
  | { type: "message"; message: ChatMessage }
  | { type: "work"; id: number; entries: WorkEntry[] }
  /**
   * A finished turn: "Worked for 42s" in place of its steps (tool calls,
   * replies on the way), which open from it. The final reply comes after it.
   */
  | { type: "turn-end"; id: number; ms: number; stopped: boolean; steps: Row[] };

/** Messages that come with your next message (they open a turn, before the `user` message itself). */
const opensTurn = (m: ChatMessage) => m.role === "user" || m.role === "context" || m.role === "attachments";

const STOPPED = "Stopped.";

/** What isn't folded into a finished turn's steps: requests for a secret, and files the agent showed. */
const staysInView = (r: Row) => r.type === "message" && (r.message.role === "secret" || r.message.role === "files");

/** Messages as rows, consecutive tool calls grouped. */
function plainRows(messages: readonly ChatMessage[], showTools: boolean): Row[] {
  const rows: Row[] = [];
  for (const m of messages) {
    if (m.role === "error" && m.content === STOPPED) continue;
    if (m.role === "tool") {
      if (!showTools) continue;
      const entry = { id: m.id, activity: parseToolActivity(m.content) };
      const prev = rows.at(-1);
      if (prev?.type === "work") prev.entries.push(entry);
      else rows.push({ type: "work", id: m.id, entries: [entry] });
      continue;
    }
    rows.push({ type: "message", message: m });
  }
  return rows;
}

/**
 * The timeline's rows. A finished turn shows your message, "Worked for …"
 * (its steps folded into it) and its outcome: the final reply and what came
 * after it (errors). Requests for a secret and files the agent showed stay in view. The turn still
 * running shows everything as it happens.
 */
export function buildRows(messages: readonly ChatMessage[], running: boolean, showTools: boolean): Row[] {
  // Split into turns: what opens one (context, attachments, your message), then the agent's part.
  const turns: { opening: ChatMessage[]; body: ChatMessage[] }[] = [{ opening: [], body: [] }];
  for (const m of messages) {
    const turn = turns.at(-1)!;
    if (!opensTurn(m)) turn.body.push(m);
    // A new turn once the agent answered (or your previous message is already there).
    else if (turn.body.length || turn.opening.some((o) => o.role === "user")) turns.push({ opening: [m], body: [] });
    else turn.opening.push(m);
  }
  const rows: Row[] = [];
  turns.forEach((turn, i) => {
    rows.push(...plainRows(turn.opening, showTools));
    const body = plainRows(turn.body, showTools);
    const user = turn.opening.find((m) => m.role === "user");
    const finished = i < turns.length - 1 || !running;
    if (!user || !finished || !turn.body.length) {
      rows.push(...body);
      return;
    }
    // The outcome: from the final reply on; without one, the errors after the last step.
    let from = body.findLastIndex((r) => r.type === "message" && r.message.role === "assistant");
    if (from === -1) from = body.findLastIndex((r) => r.type === "work") + 1;
    const steps = body.slice(0, from);
    const last = turn.body.at(-1)!;
    rows.push(
      {
        type: "turn-end",
        id: user.id,
        ms: Date.parse(last.createdAt) - Date.parse(user.createdAt),
        stopped: turn.body.some((m) => m.role === "error" && m.content === STOPPED),
        steps: steps.filter((r) => !staysInView(r)),
      },
      ...steps.filter(staysInView),
      ...body.slice(from),
    );
  });
  return rows;
}

// --- Formatting ---------------------------------------------------------------------------

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/** "ran 2 commands" for a kind and a count. */
const kindPhrases: Record<ToolKind, (n: number) => string> = {
  read: (n) => `read ${plural(n, "file", "files")}`,
  edit: (n) => `edited ${plural(n, "file", "files")}`,
  create: (n) => `created ${plural(n, "file", "files")}`,
  command: (n) => `ran ${plural(n, "command", "commands")}`,
  search: (n) => `searched ${times(n)}`,
  web: (n) => `used the web ${times(n)}`,
  page: (n) => `looked at the page ${times(n)}`,
  browse: (n) => `used the page ${times(n)}`,
  screenshot: (n) => `took ${plural(n, "screenshot", "screenshots")}`,
  inspect: (n) => `inspected the page ${times(n)}`,
  code: (n) => `ran ${plural(n, "script", "scripts")}`,
  performance: (n) => `measured ${times(n)}`,
  network: (n) => `checked the network ${times(n)}`,
  plan: () => "updated the plan",
  agent: (n) => `ran ${plural(n, "subagent", "subagents")}`,
  app: (n) => `worked on the app ${times(n)}`,
  customize: (n) => `customized ${times(n)}`,
  schedule: (n) => `changed schedules ${times(n)}`,
  snapshot: (n) => `used snapshots ${times(n)}`,
  secret: (n) => `handled ${plural(n, "secret", "secrets")}`,
  source: (n) => `used the attached code ${times(n)}`,
  tab: (n) => `looked at tabs ${times(n)}`,
  other: (n) => `used ${plural(n, "tool", "tools")}`,
};

const first: ToolKind[] = ["edit", "create", "command"];

/** "Edited 3 files, ran 2 commands and read 4 files": changes first, then in order of appearance; files counted once. */
export function summarize(entries: readonly WorkEntry[]): string {
  const counts = new Map<ToolKind, Set<string> | number>();
  for (const { activity } of entries) {
    const fileKind = activity.kind === "read" || activity.kind === "edit" || activity.kind === "create";
    const seen = counts.get(activity.kind) ?? (fileKind ? new Set<string>() : 0);
    counts.set(activity.kind, typeof seen === "number" ? seen + 1 : seen.add(activity.title));
  }
  // What changed things comes first.
  const order = (kind: ToolKind) => (first.includes(kind) ? first.indexOf(kind) : first.length);
  const parts = [...counts]
    .sort(([a], [b]) => order(a) - order(b))
    .map(([kind, n]) => kindPhrases[kind](typeof n === "number" ? n : n.size));
  const shown = parts.length > 3 ? [...parts.slice(0, 2), `${parts.length - 2} more`] : parts;
  const text = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0]!;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
