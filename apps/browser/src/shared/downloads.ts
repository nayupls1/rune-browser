// Downloads, like Chromium's: what a download is (the main process runs them,
// main/downloads.ts; the renderer shows them, components/Downloads.tsx), which
// ones are risky, file names that don't overwrite, and how progress reads.

export type DownloadState = "progressing" | "completed" | "cancelled" | "interrupted";

/** Why a download needs the user's OK before it's kept: a file type that can run code, or a site without HTTPS. */
export type DownloadDanger = "file" | "insecure";

export interface DownloadInfo {
  id: string;
  /** What was downloaded (after redirects). */
  url: string;
  /** The page it was downloaded from, if any. */
  pageUrl: string | null;
  filename: string;
  /** Where it's saved ("" until a save dialog was answered). A risky download waiting for an OK is in `unconfirmedPath`. */
  path: string;
  mime: string;
  /** 0 when the site didn't say. */
  totalBytes: number;
  receivedBytes: number;
  state: DownloadState;
  paused: boolean;
  /** Set while the user hasn't kept or discarded a risky download. */
  danger: DownloadDanger | null;
  /** A risky download's file until it's kept (it's saved under a name that can't run). */
  unconfirmedPath: string | null;
  /** The user kept a risky download before it finished: it gets its real name when it does. */
  kept: boolean;
  /** Discarded as risky (cancelled, its file deleted). */
  discarded: boolean;
  error: string | null;
  /** The web tabs' workspace it came from (null: Rune Browser itself). */
  workspaceId: string | null;
  /** The session's partition, to retry in the same session ("" is Rune Browser's own). */
  partition: string;
  startedAt: number;
  endedAt: number | null;
  /** Live only: bytes per second right now. */
  speed?: number;
  /** Live only: whether a paused or failed download can go on where it stopped. */
  canResume?: boolean;
  /** Finished downloads: whether the file is still there. */
  exists?: boolean;
}

export type DownloadAction = "pause" | "resume" | "cancel" | "open" | "show" | "retry" | "remove" | "keep" | "discard";

/** What the main process tells the window: downloads that changed, and ones that are gone from the list. */
export interface DownloadsChange {
  updated: DownloadInfo[];
  removed: string[];
}

// --- Risky files -------------------------------------------------------------------

/**
 * File types that run code when opened (Chromium's dangerous types, for every
 * platform: programs, installers, scripts, shortcuts and packages).
 */
const DANGEROUS_TYPES = new Set(
  [
    // Windows
    "exe msi msix msixbundle msp mst appx appxbundle appref-ms application bat cmd com cpl dll gadget hta inf",
    "jse lnk msc pif ps1 ps1xml ps2 psc1 psm1 reg scf scr shb shs sys vb vbe vbs ws wsc wsf wsh xbap url",
    // macOS
    "app command dmg mpkg pkg scpt terminal tool workflow",
    // Linux
    "appimage bash csh deb desktop flatpak flatpakref ksh rpm run sh snap zsh",
    // Everywhere
    "apk crx jar jnlp xapk",
  ]
    .join(" ")
    .split(" "),
);

/** The file's type ("tar.gz" counts as "gz"), lower case, without the dot. */
export const fileType = (filename: string) => {
  const match = /\.([^./\\]+)$/.exec(filename.trim());
  return match ? match[1]!.toLowerCase() : "";
};

export const isDangerousFile = (filename: string) => DANGEROUS_TYPES.has(fileType(filename));

const loopbackHost = (host: string) =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  /^127(\.\d{1,3}){3}$/.test(host) ||
  host === "[::1]" ||
  host === "::1";

/** Whether a URL (or an origin) is fetched without encryption: http: (also blob: of an http: page), not this computer. */
export function isInsecureUrl(url: string | null | undefined) {
  if (!url) return false;
  try {
    let parsed = new URL(url);
    if (parsed.protocol === "blob:" || parsed.protocol === "filesystem:") parsed = new URL(parsed.pathname);
    return (parsed.protocol === "http:" || parsed.protocol === "ftp:") && !loopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

/** Why a download needs the user's OK first, if it does: a risky file type first, then an insecure site. */
export function downloadDanger(input: {
  filename: string;
  url: string;
  initiator?: string | null;
  pageUrl?: string | null;
}): DownloadDanger | null {
  if (isDangerousFile(input.filename)) return "file";
  if (isInsecureUrl(input.url) || isInsecureUrl(input.initiator) || isInsecureUrl(input.pageUrl)) return "insecure";
  return null;
}

// --- File names ----------------------------------------------------------------------

const MAX_NAME_BYTES = 200;
const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** A file name that's safe on every platform (no folders, no reserved characters), never empty. */
export function safeFilename(name: string) {
  const trim = (text: string) => text.replace(/^[.\s]+|[.\s]+$/g, "");
  let cleaned = trim(name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_"));
  // Too long (file systems take 255 bytes, and Japanese takes 3 a character): the end of the name goes,
  // never its type (a long "….exe" stays an .exe).
  if (byteLength(cleaned) > MAX_NAME_BYTES) {
    const ext = /\.[^.\s]{1,12}$/.exec(cleaned)?.[0] ?? "";
    const stem = Array.from(cleaned.slice(0, cleaned.length - ext.length));
    while (stem.length && byteLength(stem.join("") + ext) > MAX_NAME_BYTES) stem.pop();
    cleaned = trim(stem.join("")) + ext;
  }
  // Windows keeps these names for devices (CON, NUL, COM1…), with any extension.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(cleaned)) return `_${cleaned}`;
  return cleaned || "download";
}

/** "report.pdf" → "report (1).pdf", like Chromium; "a.tar.gz" → "a (1).tar.gz". */
export function numberedName(filename: string, n: number) {
  if (n === 0) return filename;
  const match = /^(.+?)((?:\.tar)?\.[^./\\]{1,12})$/i.exec(filename);
  return match ? `${match[1]} (${n})${match[2]}` : `${filename} (${n})`;
}

/** The first of "name", "name (1)", "name (2)"… in a folder that isn't taken. */
export function uniqueFilename(filename: string, taken: (name: string) => boolean) {
  for (let n = 0; n < 10_000; n++) {
    const name = numberedName(filename, n);
    if (!taken(name)) return name;
  }
  return numberedName(filename, Date.now());
}

// --- How it reads ------------------------------------------------------------------

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  // 999.95 kB reads as 1.0 MB, not "1000 kB".
  while (value >= 999.5 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "5 s left", "3 min left", "1 h 20 min left". */
export function formatTimeLeft(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.ceil(seconds);
  if (s < 60) return `${s} s left`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min left` : `${hours} h left`;
}

/** Seconds until it's done at the current speed (null when that can't be known). */
export function secondsLeft(d: Pick<DownloadInfo, "totalBytes" | "receivedBytes" | "speed">) {
  if (!d.totalBytes || !d.speed || d.speed <= 0) return null;
  return Math.max(0, d.totalBytes - d.receivedBytes) / d.speed;
}

/** 0–1, or null when the size isn't known. */
export const downloadProgress = (d: Pick<DownloadInfo, "totalBytes" | "receivedBytes">) =>
  d.totalBytes > 0 ? Math.min(1, d.receivedBytes / d.totalBytes) : null;

/** Waiting for the user to keep or discard it. */
export const needsDecision = (d: DownloadInfo) =>
  !!d.danger && !d.kept && !d.discarded && (d.state === "progressing" || d.state === "completed");

/** A line about where it's at, like Chromium's ("1.2 MB/s · 3 MB of 10 MB, 6 s left"). */
export function downloadStatus(d: DownloadInfo) {
  if (d.discarded) return "Discarded";
  // Keeping it failed (couldn't move it to its name): why.
  if (needsDecision(d) && d.error) return d.error;
  if (needsDecision(d))
    return d.danger === "file" ? "This type of file can harm your computer" : "Downloaded from a site without HTTPS";
  if (d.state === "cancelled") return "Cancelled";
  if (d.state === "interrupted") return d.error ? `Failed: ${d.error}` : "Failed";
  if (d.state === "completed") return d.exists === false ? "Deleted" : formatBytes(d.totalBytes || d.receivedBytes);
  if (!d.path && !d.receivedBytes) return "Starting…";
  const amount = d.totalBytes
    ? `${formatBytes(d.receivedBytes)} of ${formatBytes(d.totalBytes)}`
    : formatBytes(d.receivedBytes);
  if (d.paused) return `Paused · ${amount}`;
  const left = secondsLeft(d);
  const speed = d.speed ? `${formatBytes(d.speed)}/s · ` : "";
  return `${speed}${amount}${left !== null ? `, ${formatTimeLeft(left)}` : ""}`;
}

/** The site a download came from, as shown ("example.com"). */
export function downloadSite(d: Pick<DownloadInfo, "url" | "pageUrl">) {
  for (const url of [d.url, d.pageUrl]) {
    if (!url) continue;
    try {
      const parsed = new URL(url.startsWith("blob:") ? url.slice(5) : url);
      if (parsed.hostname) return parsed.hostname.replace(/^www\./, "");
      if (parsed.protocol === "file:") return "This computer";
    } catch {}
  }
  return "";
}

/** Whether it can be downloaded again (data: and blob: addresses are gone once their page is). */
export const canRetry = (d: Pick<DownloadInfo, "url">) => /^(https?|ftp|file):/i.test(d.url) && !d.url.endsWith("…");

/** The address kept for a download: data: addresses can be megabytes, so only their start. */
export const keptUrl = (url: string) =>
  /^data:/i.test(url) ? `${url.slice(0, 60)}…` : url.length > 8192 ? `${url.slice(0, 8192)}…` : url;

/** Whether a download matches a search (its name, site or address). */
export function matchesDownload(d: DownloadInfo, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [d.filename, d.url, d.pageUrl ?? "", downloadSite(d)].some((text) => text.toLowerCase().includes(q));
}

const dayStart = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday" or the date, for the page's groups. */
export function dayLabel(t: number, now = Date.now()) {
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(t).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(new Date(t).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Downloads by day, newest first. */
export function groupByDay(list: DownloadInfo[], now = Date.now()) {
  const groups: { label: string; items: DownloadInfo[] }[] = [];
  for (const d of [...list].sort((a, b) => b.startedAt - a.startedAt)) {
    const label = dayLabel(d.startedAt, now);
    const last = groups.at(-1);
    if (last?.label === label) last.items.push(d);
    else groups.push({ label, items: [d] });
  }
  return groups;
}

/** How many downloads the list keeps (the oldest finished ones go first). */
export const MAX_DOWNLOADS = 1000;

/**
 * Downloads saved by an earlier run: what was still going stopped with Rune
 * Browser (it's failed now, and can be retried). Unknown entries are dropped.
 */
export function restoreDownloads(saved: unknown, now = Date.now()): DownloadInfo[] {
  if (!Array.isArray(saved)) return [];
  const out: DownloadInfo[] = [];
  for (const raw of saved) {
    if (!raw || typeof raw !== "object") continue;
    const d = raw as Partial<DownloadInfo>;
    if (typeof d.id !== "string" || typeof d.url !== "string" || typeof d.filename !== "string") continue;
    const state: DownloadState =
      d.state === "completed" || d.state === "cancelled" || d.state === "interrupted" ? d.state : "interrupted";
    const stopped = state === "interrupted" && d.state !== "interrupted";
    out.push({
      id: d.id,
      url: d.url,
      pageUrl: typeof d.pageUrl === "string" ? d.pageUrl : null,
      filename: d.filename,
      path: typeof d.path === "string" ? d.path : "",
      mime: typeof d.mime === "string" ? d.mime : "",
      totalBytes: typeof d.totalBytes === "number" ? d.totalBytes : 0,
      receivedBytes: typeof d.receivedBytes === "number" ? d.receivedBytes : 0,
      state,
      paused: false,
      danger: d.danger === "file" || d.danger === "insecure" ? d.danger : null,
      unconfirmedPath: typeof d.unconfirmedPath === "string" ? d.unconfirmedPath : null,
      kept: d.kept === true,
      discarded: d.discarded === true,
      error: stopped ? "Rune Browser was closed" : typeof d.error === "string" ? d.error : null,
      workspaceId: typeof d.workspaceId === "string" ? d.workspaceId : null,
      partition: typeof d.partition === "string" ? d.partition : "",
      startedAt: typeof d.startedAt === "number" ? d.startedAt : now,
      endedAt: typeof d.endedAt === "number" ? d.endedAt : stopped ? now : null,
    });
  }
  return out.slice(0, MAX_DOWNLOADS);
}

/** What's saved of a download (not the live speed or whether its file is there). */
export function savedDownload(d: DownloadInfo): DownloadInfo {
  const { speed: _speed, canResume: _canResume, exists: _exists, ...saved } = d;
  return saved;
}
