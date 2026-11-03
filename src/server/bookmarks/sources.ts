// Other browsers' bookmarks on this computer, to import: Chromium-based ones
// keep a `Bookmarks` file (JSON) per profile, Firefox-based ones the
// `places.sqlite` database, which is copied aside first (Firefox keeps it
// locked while it runs). Other browsers export an HTML file, imported as such.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  chromeBookmarks,
  countImported,
  firefoxBookmarks,
  type BookmarkSource,
  type FirefoxRow,
  type ImportedBookmarks,
} from "../../shared/bookmarks";
import { browserDirs, firefoxDirs } from "../../shared/browserDirs";

interface Found {
  source: BookmarkSource;
  read: () => ImportedBookmarks;
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** By the file's real path, so a symlinked profile isn't offered twice. */
const idOf = (path: string) => {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // as given
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
};

function chromiumProfiles(): Found[] {
  const found: Found[] = [];
  for (const { browser, dir } of browserDirs()) {
    if (!existsSync(dir)) continue;
    const state = readJson(join(dir, "Local State")) as {
      profile?: { info_cache?: Record<string, { name?: string }> };
    } | null;
    const names = state?.profile?.info_cache ?? {};
    let folders = Object.keys(names);
    if (!folders.length) {
      try {
        folders = readdirSync(dir).filter((f) => f === "Default" || /^Profile \d+$/.test(f));
      } catch {
        folders = [];
      }
    }
    for (const folder of folders) {
      const file = join(dir, folder, "Bookmarks");
      if (!existsSync(file)) continue;
      const read = () => chromeBookmarks(readJson(file));
      const data = read();
      found.push({
        source: {
          id: idOf(file),
          browser,
          profile: names[folder]?.name || folder,
          count: countImported(data.bar) + countImported(data.other),
        },
        read,
      });
    }
  }
  return found;
}

/** profiles.ini's profiles: their names and folders. */
function iniProfiles(dir: string): { name: string; path: string }[] {
  let text: string;
  try {
    text = readFileSync(join(dir, "profiles.ini"), "utf8");
  } catch {
    return [];
  }
  const out: { name: string; path: string }[] = [];
  for (const section of text.split(/^\[/m).slice(1)) {
    if (!/^Profile/i.test(section)) continue;
    const value = (key: string) => new RegExp(`^${key}=(.*)$`, "mi").exec(section)?.[1]?.trim();
    const path = value("Path");
    if (!path) continue;
    const relative = value("IsRelative") !== "0" && !isAbsolute(path);
    out.push({ name: value("Name") || path, path: relative ? join(dir, path) : path });
  }
  return out;
}

/** Firefox's bookmarks, from a copy of its database (it may be running, and keeps the file locked). */
function readPlaces(file: string): ImportedBookmarks {
  const temp = mkdtempSync(join(tmpdir(), "rune-places-"));
  try {
    const copy = join(temp, "places.sqlite");
    copyFileSync(file, copy);
    // What it wrote last may still be in the write-ahead log.
    if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${copy}-wal`);
    const db = new Database(copy);
    try {
      const rows = db
        .query(
          `SELECT b.id, b.type, b.parent, b.position, b.title, p.url, b.dateAdded, b.guid
           FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk`,
        )
        .all() as FirefoxRow[];
      return firefoxBookmarks(rows);
    } finally {
      db.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function firefoxProfiles(): Found[] {
  const found: Found[] = [];
  for (const { browser, dir } of firefoxDirs()) {
    for (const profile of iniProfiles(dir)) {
      const file = join(profile.path, "places.sqlite");
      if (!existsSync(file)) continue;
      const read = () => readPlaces(file);
      let count = 0;
      try {
        const data = read();
        count = countImported(data.bar) + countImported(data.other);
      } catch {
        continue; // not a database we can read
      }
      found.push({ source: { id: idOf(file), browser, profile: profile.name, count }, read });
    }
  }
  return found;
}

/** Every browser profile with bookmarks (the same file found twice counts once). */
export function bookmarkSources(): Found[] {
  const seen = new Set<string>();
  return [...chromiumProfiles(), ...firefoxProfiles()].filter((f) => {
    if (seen.has(f.source.id)) return false;
    seen.add(f.source.id);
    return f.source.count > 0;
  });
}
