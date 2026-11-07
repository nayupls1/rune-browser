// What Rune Browser tells the user when it crashed (main/crashes.ts): the
// report they can copy or file as a GitHub issue. Kept free of Electron so the
// unit tests can check it. Reports never carry the user's paths (their name is
// in their home folder) or tokens, and the issue is only opened for them to
// read and send themselves.
import { redactTokens } from "../shared/network";

/** Windows' exit codes for crashes (NTSTATUS), as they show up in `child-process-gone`. */
const WINDOWS_CODES: Record<number, string> = {
  0xc0000005: "access violation",
  0xc0000409: "stack buffer overrun",
  0xc00000fd: "stack overflow",
  0xc0000374: "heap corruption",
  0xc0000017: "out of memory",
  0xe0000008: "out of memory",
  0x80000003: "breakpoint (a failed check)",
  0xc000001d: "illegal instruction",
  0xc0000142: "the process failed to start",
};

/** An exit code as Windows shows it (0xC0000005, access violation); plain numbers elsewhere. */
export function describeExitCode(code: number | null | undefined, platform: string = process.platform) {
  if (code === null || code === undefined) return "none";
  const unsigned = code >>> 0;
  const known = WINDOWS_CODES[unsigned];
  if (platform === "win32" && (known || unsigned > 0xffff))
    return `0x${unsigned.toString(16).toUpperCase().padStart(8, "0")}${known ? ` (${known})` : ""}`;
  return String(code);
}

/** Takes the user's home folder (and so their name) out of a text: `~` instead. */
export function redactPaths(text: string, home: string) {
  if (!home || home.length < 3) return text;
  const variants = new Set([home, home.replaceAll("\\", "/"), home.replaceAll("/", "\\")]);
  let out = text;
  for (const v of variants) out = out.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "~");
  return out;
}

export interface CrashInfo {
  version: string;
  electron: string;
  chrome: string;
  /** e.g. "win32 10.0.26100 x64". */
  os: string;
  /** What happened, in a sentence. */
  what: string;
  /** Recent lines of the crash log (oldest first). */
  log: string[];
}

/** The report the user copies or files: what happened, versions, recent events. */
export function crashReport(info: CrashInfo, home: string) {
  const lines = [
    `Rune Browser ${info.version} (Electron ${info.electron}, Chromium ${info.chrome})`,
    `OS: ${info.os}`,
    `What happened: ${info.what}`,
    ...(info.log.length ? ["", "Recent events:", ...info.log] : []),
  ];
  return redactTokens(redactPaths(lines.join("\n"), home));
}

/** URLs longer than this are cut by browsers or refused by GitHub. */
const MAX_URL = 7000;

/** The bug report form's operating systems (.github/ISSUE_TEMPLATE/bug_report.yml). */
const FORM_OS: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

export interface IssueFields {
  version: string;
  /** process.platform. */
  platform: string;
  /** e.g. "10.0.26100 x64". */
  osDetails: string;
  /** What happened, in a sentence. */
  what: string;
}

/**
 * A new GitHub issue on the bug report form, with the report filled in (blank
 * issues are off). The oldest events go first when it's too long for a URL.
 */
export function issueUrl(issuesUrl: string, title: string, report: string, fields: IssueFields) {
  const make = (r: string) => {
    const params = new URLSearchParams({
      template: "bug_report.yml",
      title,
      what: `${fields.what}\n\n(What were you doing when it happened?)`,
      version: fields.version,
      ...(FORM_OS[fields.platform] ? { os: FORM_OS[fields.platform]! } : {}),
      "os-details": fields.osDetails,
      extra: ["```", r, "```"].join("\n"),
    });
    return `${issuesUrl.replace(/\/+$/, "")}/new?${params.toString()}`;
  };
  let lines = report.split("\n");
  let url = make(report);
  // Keeps the head (versions, what happened) and the newest events.
  const head = Math.min(lines.length, 5);
  while (url.length > MAX_URL && lines.length > head) {
    lines = [...lines.slice(0, head), "…", ...lines.slice(head + 2)];
    url = make(lines.join("\n"));
  }
  return url.length > MAX_URL ? make(report.slice(0, 1500)) : url;
}

/** A crash log line: `[ISO time] message`, one line. */
export const logLine = (message: string, at = new Date()) =>
  `[${at.toISOString()}] ${message.replace(/\s*\n\s*/g, " ⏎ ")}`;

/** The log lines written at `since` (ms) or later, the newest `max` of them. */
export function linesSince(log: string, since: number, max = 30) {
  return log
    .split("\n")
    .filter((line) => {
      const at = Date.parse(line.match(/^\[([^\]]+)\]/)?.[1] ?? "");
      return Number.isFinite(at) && at >= since;
    })
    .slice(-max);
}
