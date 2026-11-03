// Rune Browser as the system's default browser (main/defaultBrowser.ts): what
// it registers for, and whether it's the default. The installers declare the
// same schemes and files (electron-builder.yml, build/installer.nsh; a test
// keeps them in step).

/** Links Rune Browser opens from other apps. */
export const WEB_SCHEMES = ["http", "https"] as const;

/** Files it can be chosen for (Open with, default apps). */
export const WEB_FILE_EXTENSIONS = ["html", "htm", "xhtml", "shtml", "pdf", "svg", "webp"] as const;

/** The same files and links as Linux MIME types (the .desktop file's MimeType). */
export const LINUX_MIME_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "application/pdf",
  "image/svg+xml",
  "image/webp",
  ...WEB_SCHEMES.map((scheme) => `x-scheme-handler/${scheme}`),
];

/** What "Make default" hands to Rune Browser on Linux: links and web pages (other files stay with their apps). */
export const LINUX_DEFAULT_TYPES = [
  "x-scheme-handler/http",
  "x-scheme-handler/https",
  "text/html",
  "application/xhtml+xml",
];

/** package.json's desktopName: the .desktop file the deb installs. */
export const LINUX_DESKTOP_FILE = "rune-browser.desktop";

/** Windows: the name under RegisteredApplications and StartMenuInternet (build/installer.nsh). */
export const WINDOWS_REGISTERED_NAME = "Rune Browser";

/** Windows: the ProgID links and files are associated with (build/installer.nsh). */
export const WINDOWS_PROG_ID = "RuneBrowserHTML";

export type DefaultBrowserStatus =
  /** Runs from source, or the system has no way to choose it. */
  | { state: "unsupported"; reason: string }
  | { state: "default" }
  /**
   * How it becomes the default: Rune Browser sets it (Linux), the system asks
   * to confirm (macOS), or the user picks it in the system's settings (Windows).
   */
  | { state: "not-default"; how: "direct" | "confirm" | "settings" };
