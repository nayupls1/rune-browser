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
