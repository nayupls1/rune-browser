// Links and files Rune Browser is started with: from other apps once it's the
// default browser (main/defaultBrowser.ts), a file opened with it, or a URL
// given on the command line.
import { extname, resolve } from "node:path";
import { WEB_FILE_EXTENSIONS } from "../shared/defaultBrowser";
import { fileUrl } from "../shared/web";

/** More than this at once is a mistake (or an attack), not links to read. */
const MAX_LINKS = 20;

const isWebFile = (path: string) =>
  (WEB_FILE_EXTENSIONS as readonly string[]).includes(extname(path).slice(1).toLowerCase());

/** The URL of a web link (http, https), normalized; null for anything else. */
export function webLink(text: string): string | null {
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    return new URL(text).href;
  } catch {
    return null;
  }
}

/**
 * The links and web files in a command line, as URLs to open in tabs. Switches
 * are skipped (Electron's and Chromium's own, before a `--`), and so is
 * anything else that isn't a web link or an existing web file (the executable,
 * the app's folder when run from source). Relative paths are from `cwd`.
 */
export function linksFromArgs(argv: readonly string[], cwd: string, isFile: (path: string) => boolean): string[] {
  const links: string[] = [];
  let positional = false;
  for (const arg of argv) {
    if (links.length >= MAX_LINKS) break;
    if (!positional && arg === "--") {
      positional = true;
      continue;
    }
    if (!positional && arg.startsWith("-")) continue;
    const link = webLink(arg) ?? fileLink(arg, cwd, isFile);
    if (link) links.push(link);
  }
  return links;
}

/** A web file (a path or file:// URL) as a file:// URL, if it exists. */
export function fileLink(arg: string, cwd: string, isFile: (path: string) => boolean): string | null {
  let path = arg;
  if (/^file:\/\//i.test(arg)) {
    try {
      const url = new URL(arg);
      if (url.host && url.host !== "localhost") return null;
      path = decodeURIComponent(url.pathname);
      // file:///C:/… is C:\… on Windows.
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]+:/i.test(arg) && !/^[a-z]:[\\/]/i.test(arg)) {
    // Another scheme (mailto:, javascript:…): not ours.
    return null;
  }
  if (!isWebFile(path)) return null;
  const absolute = resolve(cwd, path);
  return isFile(absolute) ? fileUrl(absolute) : null;
}

/**
 * The .desktop file of an AppImage, written when it's made the default browser
 * (an AppImage installs none of its own). `X-Rune-AppImage` marks it as ours,
 * so it follows the AppImage when that moves.
 */
export function appImageDesktopEntry(options: { appImage: string; icon: string; mimeTypes: readonly string[] }) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Rune Browser",
    "GenericName=Web Browser",
    "Comment=A browser where coding agents build your own small apps",
    `Exec=${desktopExecArg(options.appImage)} %U`,
    `Icon=${options.icon}`,
    "Terminal=false",
    "Categories=Network;WebBrowser;",
    `MimeType=${options.mimeTypes.join(";")};`,
    "StartupWMClass=rune-browser",
    "X-Rune-AppImage=true",
    "",
  ].join("\n");
}

/**
 * A path as one argument of a .desktop file's Exec: quoted, with the quoting
 * rule's escapes, then the string rule's (backslashes doubled), and % as %%.
 */
export function desktopExecArg(path: string) {
  const quoted = `"${path.replace(/[\\"`$]/g, "\\$&")}"`;
  return quoted.replace(/\\/g, "\\\\").replace(/%/g, "%%");
}
