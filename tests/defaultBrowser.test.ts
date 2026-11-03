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
import { appImageDesktopEntry, desktopExecArg, linksFromArgs } from "../src/main/links";
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
