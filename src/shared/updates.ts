// Updates of Rune Browser itself (main/updates.ts), from its GitHub releases.

/** Stable releases only, or the daily builds too. */
export type UpdateChannel = "stable" | "daily";

export type UpdateStatus =
  /** Runs from source, or from a package that can't update itself. */
  | { state: "unsupported"; reason: string }
  /** Up to date (or not checked yet). */
  | { state: "idle" }
  | { state: "checking" }
  /** A newer release to download by hand (macOS until builds are signed). */
  | { state: "available"; version: string; url: string }
  | { state: "downloading"; version: string; percent: number }
  /** Downloaded: installed on the next restart. */
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

export interface UpdateInfo {
  /** The running version. */
  version: string;
  channel: UpdateChannel;
  /** When the last check finished (ISO), null before the first one. */
  checkedAt: string | null;
  status: UpdateStatus;
}

/** A release's version (`v0.2.1-daily.20261031.42` → its parts), null if it isn't one of ours. */
function parseVersion(text: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

/**
 * SemVer order (negative: `a` is older). A pre-release is older than its own
 * release (0.2.1-daily… < 0.2.1) and newer than everything before it (0.2.0).
 * Numeric parts compare as numbers, so the daily builds of a version go by date and run.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const numeric = /^\d+$/;
    if (numeric.test(p) && numeric.test(q)) return Number(p) - Number(q);
    if (numeric.test(p) !== numeric.test(q)) return numeric.test(p) ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether a version is a daily build (has a pre-release part). */
export const isPrerelease = (version: string) => !!parseVersion(version)?.pre.length;

/** A copy that never chose a channel: a daily build stays on the daily builds. */
export const defaultChannel = (version: string): UpdateChannel => (isPrerelease(version) ? "daily" : "stable");

/**
 * The newest release a channel gets, from the releases' tags (`v0.2.0`,
 * `v0.2.1-daily.20261031.42`): stable ones only, or the daily builds too, by
 * version rather than by date, so a daily copy moves to a newer daily build and to a newer
 * stable release alike. Null if there's none.
 */
export function newestRelease(tags: readonly string[], channel: UpdateChannel): string | null {
  let best: string | null = null;
  for (const tag of tags) {
    if (!parseVersion(tag) || (channel === "stable" && isPrerelease(tag))) continue;
    if (!best || compareVersions(tag, best) > 0) best = tag;
  }
  return best;
}

/** The release tags in GitHub's releases feed (`releases.atom`), newest first. */
export function tagsFromFeed(xml: string): string[] {
  return [...xml.matchAll(/\/releases\/tag\/([^"'<>\s/]+)/g)].map((m) => decodeURIComponent(m[1]!));
}
