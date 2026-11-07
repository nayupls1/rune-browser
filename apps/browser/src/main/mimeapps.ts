// Linux's default apps, as the freedesktop.org spec keeps them: `mimeapps.list`
// files, whose [Default Applications] section says which .desktop file opens a
// MIME type or a link's scheme (x-scheme-handler/https). Every desktop and
// xdg-open read them, so Rune Browser reads and writes them itself and doesn't
// depend on xdg-utils being installed (main/defaultBrowser.ts).
// https://specifications.freedesktop.org/mime-apps-spec/latest/
// Linux paths (also where the tests run on Windows).
import { posix } from "node:path";

const { join } = posix;

export interface XdgDirs {
  configHome: string;
  configDirs: string[];
  dataHome: string;
  dataDirs: string[];
  /** XDG_CURRENT_DESKTOP's names ("GNOME", "KDE"…), lowercased. */
  desktops: string[];
}

/** The XDG folders from the environment, with the spec's defaults. */
export function xdgDirs(env: Record<string, string | undefined>, home: string): XdgDirs {
  const list = (value: string | undefined, fallback: string) =>
    (value || fallback).split(":").filter((dir) => dir.startsWith("/"));
  return {
    configHome: env.XDG_CONFIG_HOME?.startsWith("/") ? env.XDG_CONFIG_HOME : join(home, ".config"),
    configDirs: list(env.XDG_CONFIG_DIRS, "/etc/xdg"),
    dataHome: env.XDG_DATA_HOME?.startsWith("/") ? env.XDG_DATA_HOME : join(home, ".local", "share"),
    dataDirs: list(env.XDG_DATA_DIRS, "/usr/local/share:/usr/share"),
    desktops: (env.XDG_CURRENT_DESKTOP ?? "")
      .split(":")
      .map((d) => d.trim().toLowerCase())
      .filter((d) => /^[\w-]+$/.test(d)),
  };
}

/**
 * The mimeapps.list files in the order they're read, the first one that names
 * a default winning: the user's config (the desktop's own file first), the
 * system's, then the older places under applications/.
 */
export function mimeappsFiles(dirs: XdgDirs): string[] {
  const inDir = (dir: string) => [
    ...dirs.desktops.map((d) => join(dir, `${d}-mimeapps.list`)),
    join(dir, "mimeapps.list"),
  ];
  return [
    ...inDir(dirs.configHome),
    ...dirs.configDirs.flatMap(inDir),
    ...inDir(join(dirs.dataHome, "applications")),
    ...dirs.dataDirs.flatMap((dir) => inDir(join(dir, "applications"))),
  ];
}

/**
 * The .desktop files a section lists for a type, in order (`a.desktop;b.desktop;`). A type
 * listed twice counts as its last line, as GLib (GNOME, gio) reads it.
 */
export function listedFor(text: string, section: string, type: string): string[] | null {
  let current = "";
  let found: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = header[1]!;
      continue;
    }
    if (current !== section) continue;
    const eq = line.indexOf("=");
    if (eq === -1 || line.slice(0, eq).trim() !== type) continue;
    found = line
      .slice(eq + 1)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return found;
}

/**
 * Which .desktop file opens a type, from the files in reading order (their
 * contents, null where there's none): the first default that's installed.
 */
export function defaultFor(files: readonly (string | null)[], type: string, installed: (desktop: string) => boolean) {
  for (const text of files) {
    if (text === null) continue;
    for (const desktop of listedFor(text, "Default Applications", type) ?? []) if (installed(desktop)) return desktop;
  }
  return null;
}

/**
 * A mimeapps.list with `desktop` as the default for each type (first, before
 * the others it listed), and among the apps added for them. The rest of the file
 * (comments, other sections and types) stays as it was.
 */
export function withDefault(text: string, desktop: string, types: readonly string[]): string {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const isHeader = (line: string) => /^\s*\[.+\]\s*$/.test(line);
  /** The lines in the section (every group of that name: GLib reads them as one, later lines winning) that are the type's. */
  const linesOf = (section: string, type: string) => {
    const at: number[] = [];
    let inside = false;
    lines.forEach((line, i) => {
      if (isHeader(line)) inside = line.trim() === `[${section}]`;
      else if (inside && line.split("=")[0]!.trim() === type) at.push(i);
    });
    return at;
  };
  const put = (section: string) => {
    if (!lines.some((l) => l.trim() === `[${section}]`)) {
      if (lines.length && lines.at(-1)!.trim() !== "") lines.push("");
      lines.push(`[${section}]`);
    }
    for (const type of types) {
      // Every line for the type (a file can list one twice): the first becomes the one, the rest go.
      const at = linesOf(section, type);
      // The last line first: it's the one GLib used, so it stays next in line after Rune Browser.
      const listed = [...at].reverse().flatMap((i) => listedFor(`[x]\n${lines[i]}`, "x", type) ?? []);
      const others = [...new Set(listed)].filter((d) => d !== desktop);
      const line = `${type}=${[desktop, ...others].join(";")};`;
      if (at.length) {
        lines[at[0]!] = line;
        for (const i of at.slice(1).reverse()) lines.splice(i, 1);
        continue;
      }
      // At the end of the section's first group, before the blank lines that end it.
      const start = lines.findIndex((l) => l.trim() === `[${section}]`);
      let end = lines.findIndex((l, i) => i > start && isHeader(l));
      if (end === -1) end = lines.length;
      while (end - 1 > start && lines[end - 1]!.trim() === "") end--;
      lines.splice(end, 0, line);
    }
  };
  put("Default Applications");
  put("Added Associations");
  // Removed for a type once (from "Open with"): it's back.
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (/^\[.+\]$/.test(line)) removed = line === "[Removed Associations]";
    const type = line.split("=")[0]!.trim();
    if (!removed || !types.includes(type)) continue;
    const rest = (listedFor(`[x]\n${line}`, "x", type) ?? []).filter((d) => d !== desktop);
    lines[i] = `${type}=${rest.join(";")}${rest.length ? ";" : ""}`;
  }
  return `${lines.join("\n")}\n`;
}
