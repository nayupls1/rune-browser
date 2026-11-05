import { describe, expect, test } from "bun:test";
import { YAML } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LINUX_DEFAULT_TYPES,
  LINUX_DESKTOP_FILE,
  LINUX_MIME_TYPES,
  WEB_FILE_EXTENSIONS,
  WEB_SCHEMES,
  WINDOWS_PROG_ID,
  WINDOWS_REGISTERED_NAME,
} from "../src/shared/defaultBrowser";
import { appImageDesktopEntry, desktopExecArg, linksFromArgs, withoutLinks } from "../src/main/links";
import { defaultFor, mimeappsFiles, withDefault, xdgDirs } from "../src/main/mimeapps";
import { fileUrl } from "../src/shared/web";

// As the system has them (C:\home\me\… on Windows).
const at = (path: string) => resolve("/home/me", path);
const files = new Set([at("page.html"), at("docs/report.pdf"), at("notes.txt"), at("/tmp/a b#1.svg")]);
const isFile = (path: string) => files.has(path);
const links = (argv: string[], cwd = "/home/me") => linksFromArgs(argv, cwd, isFile);

describe("links Rune Browser is started with", () => {
  test("web links, but not the executable, the app's folder or switches", () => {
    expect(
      links([
        "/opt/Rune Browser/rune-browser",
        ".",
        "--no-sandbox",
        "--ozone-platform=headless",
        "https://example.com/a?b=c#d",
        "HTTP://Example.com",
      ]),
    ).toEqual(["https://example.com/a?b=c#d", "http://example.com/"]);
  });

  test("after --, everything is a link or file, never a switch", () => {
    expect(links(["C:\\rune-browser.exe", "--", "https://example.com/"])).toEqual(["https://example.com/"]);
    expect(links(["rune-browser", "--", "--gpu-launcher=calc"])).toEqual([]);
  });

  test("web files that exist, by path (relative to the launch's folder) or file:// URL", () => {
    expect(links(["page.html", "docs/report.pdf", "/tmp/a b#1.svg", "file:///home/me/page.html"])).toEqual([
      fileUrl(at("page.html")),
      fileUrl(at("docs/report.pdf")),
      fileUrl(at("/tmp/a b#1.svg")),
      fileUrl(at("page.html")),
    ]);
    expect(fileUrl(at("/tmp/a b#1.svg"))).toEndWith("/tmp/a%20b%231.svg");
    // A file:// URL keeps its query and #anchor.
    expect(links(["file:///home/me/page.html?v=1#install"])).toEqual([`${fileUrl(at("page.html"))}?v=1#install`]);
  });

  test("not other files, missing ones, remote file:// URLs or other schemes", () => {
    expect(
      links([
        "notes.txt",
        "missing.html",
        "file://server/share/page.html",
        "mailto:me@example.com",
        "javascript:alert(1)",
        "ftp://example.com/page.html",
        "data:text/html,hi",
      ]),
    ).toEqual([]);
  });

  test("a restart keeps the switches, not the links (they're open already)", () => {
    expect(
      withoutLinks(
        [".", "--no-sandbox", "https://example.com/", "page.html", "notes.txt", "--", "https://example.org/"],
        "/home/me",
        isFile,
      ),
    ).toEqual([".", "--no-sandbox", "notes.txt"]);
  });

  test("a mistaken flood of links is capped", () => {
    expect(links(Array.from({ length: 50 }, (_, i) => `https://example.com/${i}`))).toHaveLength(20);
  });
});

describe("an AppImage's .desktop file", () => {
  test("the AppImage's path is one quoted, escaped argument of Exec", () => {
    expect(desktopExecArg("/home/me/Apps/Rune Browser.AppImage")).toBe('"/home/me/Apps/Rune Browser.AppImage"');
    // Quoting escapes `"`, `` ` ``, `$` and `\` with a backslash; the string rule then doubles backslashes.
    expect(desktopExecArg('/a/"b"/$c/`d`/e\\f/100%.AppImage')).toBe(
      '"/a/\\\\"b\\\\"/\\\\$c/\\\\`d\\\\`/e\\\\\\\\f/100%%.AppImage"',
    );
  });

  test("opens links (%U) and says what it opens", () => {
    const entry = appImageDesktopEntry({
      appImage: "/apps/rune.AppImage",
      icon: "/icons/rune.png",
      mimeTypes: LINUX_MIME_TYPES,
    });
    expect(entry).toContain('Exec="/apps/rune.AppImage" %U\n');
    expect(entry).toContain("Icon=/icons/rune.png\n");
    expect(entry).toContain("Categories=Network;WebBrowser;\n");
    expect(entry).toContain(`MimeType=${LINUX_MIME_TYPES.join(";")};\n`);
    expect(entry).toContain("X-Rune-AppImage=true\n");
  });
});

describe("the installers register what Rune Browser opens", () => {
  const builder = YAML.parse(readFileSync("electron-builder.yml", "utf8")) as {
    linux: { mimeTypes: string[] };
    mac: { protocols: { schemes: string[] }[]; fileAssociations: { ext: string | string[]; rank: string }[] };
  };
  const nsis = readFileSync("build/installer.nsh", "utf8");

  test("Linux: the .desktop file's MIME types, and its name", () => {
    expect(builder.linux.mimeTypes).toEqual(LINUX_MIME_TYPES);
    expect(LINUX_MIME_TYPES).toEqual(expect.arrayContaining(LINUX_DEFAULT_TYPES));
    expect(JSON.parse(readFileSync("package.json", "utf8")).desktopName).toBe(LINUX_DESKTOP_FILE);
  });

  test("macOS: the URL schemes and file types, without taking files over", () => {
    expect(builder.mac.protocols.flatMap((p) => p.schemes)).toEqual([...WEB_SCHEMES]);
    expect(builder.mac.fileAssociations.flatMap((f) => f.ext)).toEqual([...WEB_FILE_EXTENSIONS]);
    expect(builder.mac.fileAssociations.every((f) => f.rank === "Alternate")).toBe(true);
  });

  test("Windows: the installer registers and the uninstaller removes every file type and scheme", () => {
    expect(nsis).toContain(`!define RUNE_PROG_ID "${WINDOWS_PROG_ID}"`);
    expect(nsis).toContain(`!define RUNE_REGISTERED_NAME "${WINDOWS_REGISTERED_NAME}"`);
    const added = [...nsis.matchAll(/runeAddFileType "(\w+)"/g)].map((m) => m[1]);
    const removed = [...nsis.matchAll(/runeRemoveFileType "(\w+)"/g)].map((m) => m[1]);
    expect(added).toEqual([...WEB_FILE_EXTENSIONS]);
    expect(removed).toEqual([...WEB_FILE_EXTENSIONS]);
    const schemes = [...nsis.matchAll(/\\URLAssociations" "(\w+)"/g)].map((m) => m[1]);
    expect(schemes).toEqual([...WEB_SCHEMES]);
    // The schemes are in the browser's key, which the uninstaller deletes whole, with the ProgID and its listing.
    const uninstall = nsis.slice(nsis.indexOf("!macro customUnInstall"));
    expect(uninstall).toContain('DeleteRegKey SHELL_CONTEXT "${RUNE_CLIENT_KEY}"');
    expect(uninstall).toContain('DeleteRegKey SHELL_CONTEXT "Software\\Classes\\${RUNE_PROG_ID}"');
    expect(uninstall).toContain(
      'DeleteRegValue SHELL_CONTEXT "Software\\RegisteredApplications" "${RUNE_REGISTERED_NAME}"',
    );
    // Links can't smuggle in Chromium switches.
    expect(nsis).toContain(`'"$appExe" -- "%1"'`);
  });
});

describe("Linux's mimeapps.list", () => {
  const types = ["x-scheme-handler/http", "x-scheme-handler/https", "text/html"];

  test("read in the spec's order: the desktop's own file, the user's, the system's, then applications/", () => {
    const dirs = xdgDirs({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME", XDG_DATA_DIRS: "/usr/share" }, "/home/me");
    expect(mimeappsFiles(dirs)).toEqual([
      "/home/me/.config/ubuntu-mimeapps.list",
      "/home/me/.config/gnome-mimeapps.list",
      "/home/me/.config/mimeapps.list",
      "/etc/xdg/ubuntu-mimeapps.list",
      "/etc/xdg/gnome-mimeapps.list",
      "/etc/xdg/mimeapps.list",
      "/home/me/.local/share/applications/ubuntu-mimeapps.list",
      "/home/me/.local/share/applications/gnome-mimeapps.list",
      "/home/me/.local/share/applications/mimeapps.list",
      "/usr/share/applications/ubuntu-mimeapps.list",
      "/usr/share/applications/gnome-mimeapps.list",
      "/usr/share/applications/mimeapps.list",
    ]);
    // No desktop (a bare window manager) and relative paths, which the spec ignores.
    const bare = xdgDirs({ XDG_CONFIG_HOME: "relative", XDG_DATA_DIRS: "rel:/opt/share" }, "/home/me");
    expect(bare.configHome).toBe("/home/me/.config");
    expect(bare.dataDirs).toEqual(["/opt/share"]);
    expect(bare.desktops).toEqual([]);
  });

  test("the first default that's installed wins", () => {
    const user = "[Default Applications]\nx-scheme-handler/https=gone.desktop;firefox.desktop;\n";
    const system = "[Default Applications]\nx-scheme-handler/https=rune-browser.desktop;\n";
    const installed = (d: string) => d !== "gone.desktop";
    expect(defaultFor([null, user, system], "x-scheme-handler/https", installed)).toBe("firefox.desktop");
    expect(defaultFor([null, system], "x-scheme-handler/https", installed)).toBe(LINUX_DESKTOP_FILE);
    expect(defaultFor([null, null], "x-scheme-handler/https", installed)).toBeNull();
    // Added associations aren't defaults.
    expect(
      defaultFor(["[Added Associations]\nx-scheme-handler/https=a.desktop;\n"], "x-scheme-handler/https", installed),
    ).toBeNull();
  });

  test("making it the default: a new file", () => {
    expect(withDefault("", LINUX_DESKTOP_FILE, types)).toBe(
      [
        "[Default Applications]",
        "x-scheme-handler/http=rune-browser.desktop;",
        "x-scheme-handler/https=rune-browser.desktop;",
        "text/html=rune-browser.desktop;",
        "",
        "[Added Associations]",
        "x-scheme-handler/http=rune-browser.desktop;",
        "x-scheme-handler/https=rune-browser.desktop;",
        "text/html=rune-browser.desktop;",
        "",
      ].join("\n"),
    );
  });

  test("making it the default: first for its types, everything else kept", () => {
    const before = [
      "# my defaults",
      "[Added Associations]",
      "text/html=firefox.desktop;",
      "",
      "[Default Applications]",
      "x-scheme-handler/https=firefox.desktop;rune-browser.desktop;",
      "application/pdf=org.gnome.Evince.desktop;",
      "",
      "[Removed Associations]",
      "text/html=rune-browser.desktop;other.desktop;",
      "image/png=rune-browser.desktop;",
      "",
    ].join("\n");
    const after = withDefault(before, LINUX_DESKTOP_FILE, types);
    expect(after).toBe(
      [
        "# my defaults",
        "[Added Associations]",
        "text/html=rune-browser.desktop;firefox.desktop;",
        "x-scheme-handler/http=rune-browser.desktop;",
        "x-scheme-handler/https=rune-browser.desktop;",
        "",
        "[Default Applications]",
        "x-scheme-handler/https=rune-browser.desktop;firefox.desktop;",
        "application/pdf=org.gnome.Evince.desktop;",
        "x-scheme-handler/http=rune-browser.desktop;",
        "text/html=rune-browser.desktop;",
        "",
        "[Removed Associations]",
        "text/html=other.desktop;",
        "image/png=rune-browser.desktop;",
        "",
      ].join("\n"),
    );
    // A type listed twice reads as its last line (as GLib does); making it the default leaves one line.
    const twice =
      "[Default Applications]\nx-scheme-handler/https=firefox.desktop;\nx-scheme-handler/https=chromium.desktop;\n";
    expect(defaultFor([twice], "x-scheme-handler/https", () => true)).toBe("chromium.desktop");
    const once = withDefault(twice, LINUX_DESKTOP_FILE, ["x-scheme-handler/https"]);
    expect(once).toContain(
      "[Default Applications]\nx-scheme-handler/https=rune-browser.desktop;firefox.desktop;chromium.desktop;\n\n",
    );
    expect(defaultFor([once], "x-scheme-handler/https", () => true)).toBe(LINUX_DESKTOP_FILE);
    // Again: nothing changes.
    expect(withDefault(after, LINUX_DESKTOP_FILE, types)).toBe(after);
    // And it reads back as the default.
    expect(defaultFor([after], "x-scheme-handler/https", () => true)).toBe(LINUX_DESKTOP_FILE);
  });
});
