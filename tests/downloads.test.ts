import { describe, expect, test } from "bun:test";
import {
  canRetry,
  dayLabel,
  downloadDanger,
  downloadSite,
  downloadStatus,
  formatBytes,
  formatTimeLeft,
  groupByDay,
  isDangerousFile,
  isInsecureUrl,
  keptUrl,
  matchesDownload,
  needsDecision,
  numberedName,
  restoreDownloads,
  safeFilename,
  savedDownload,
  secondsLeft,
  uniqueFilename,
  type DownloadInfo,
} from "../src/shared/downloads";

const download = (over: Partial<DownloadInfo> = {}): DownloadInfo => ({
  id: "d1",
  url: "https://files.example.com/report.pdf",
  pageUrl: "https://www.example.com/reports",
  filename: "report.pdf",
  path: "/home/me/Downloads/report.pdf",
  mime: "application/pdf",
  totalBytes: 10_000_000,
  receivedBytes: 4_000_000,
  state: "progressing",
  paused: false,
  danger: null,
  unconfirmedPath: null,
  kept: false,
  discarded: false,
  error: null,
  workspaceId: "default",
  partition: "persist:web",
  startedAt: new Date(2026, 10, 2, 12).getTime(),
  endedAt: null,
  ...over,
});

describe("risky downloads", () => {
  test("programs, installers and scripts for every platform are dangerous; documents aren't", () => {
    for (const name of [
      "setup.exe",
      "Installer.MSI",
      "run.bat",
      "app.dmg",
      "pkg.deb",
      "tool.AppImage",
      "x.sh",
      "a.jar",
    ])
      expect([name, isDangerousFile(name)]).toEqual([name, true]);
    for (const name of ["report.pdf", "photo.jpg", "notes.txt", "archive.zip", "data.tar.gz", "README", "exe"])
      expect([name, isDangerousFile(name)]).toEqual([name, false]);
  });

  test("insecure: http and ftp anywhere but this computer, blob: of an http page too", () => {
    expect(isInsecureUrl("http://example.com/file.zip")).toBe(true);
    expect(isInsecureUrl("ftp://example.com/file.zip")).toBe(true);
    expect(isInsecureUrl("blob:http://example.com/0b6c-11")).toBe(true);
    expect(isInsecureUrl("https://example.com/file.zip")).toBe(false);
    expect(isInsecureUrl("blob:https://example.com/0b6c-11")).toBe(false);
    expect(isInsecureUrl("http://localhost:3000/export.csv")).toBe(false);
    expect(isInsecureUrl("http://127.0.0.1:5173/export.csv")).toBe(false);
    expect(isInsecureUrl("http://app.localhost/x")).toBe(false);
    expect(isInsecureUrl("http://[::1]:8080/x")).toBe(false);
    expect(isInsecureUrl("file:///home/me/x.zip")).toBe(false);
    expect(isInsecureUrl("data:text/plain,hi")).toBe(false);
    expect(isInsecureUrl(null)).toBe(false);
    expect(isInsecureUrl("not a url")).toBe(false);
  });

  test("a risky type first, then the file's or the page's site", () => {
    expect(downloadDanger({ filename: "setup.exe", url: "https://example.com/setup.exe" })).toBe("file");
    expect(downloadDanger({ filename: "setup.exe", url: "http://example.com/setup.exe" })).toBe("file");
    expect(downloadDanger({ filename: "a.zip", url: "http://example.com/a.zip" })).toBe("insecure");
    expect(
      downloadDanger({ filename: "a.zip", url: "https://cdn.example.com/a.zip", initiator: "http://example.com" }),
    ).toBe("insecure");
    expect(
      downloadDanger({ filename: "a.zip", url: "https://cdn.example.com/a.zip", pageUrl: "http://example.com/p" }),
    ).toBe("insecure");
    expect(downloadDanger({ filename: "a.zip", url: "https://example.com/a.zip", initiator: "" })).toBeNull();
  });

  test("only what's running or finished waits for a decision", () => {
    expect(needsDecision(download({ danger: "file" }))).toBe(true);
    expect(needsDecision(download({ danger: "file", state: "completed" }))).toBe(true);
    expect(needsDecision(download({ danger: "file", kept: true }))).toBe(false);
    expect(needsDecision(download({ danger: "file", discarded: true, state: "cancelled" }))).toBe(false);
    expect(needsDecision(download({ danger: "insecure", state: "interrupted" }))).toBe(false);
    expect(needsDecision(download())).toBe(false);
  });
});

describe("file names", () => {
  test("numbered like Chromium's, before the extension (a .tar.gz stays whole)", () => {
    expect(numberedName("report.pdf", 0)).toBe("report.pdf");
    expect(numberedName("report.pdf", 1)).toBe("report (1).pdf");
    expect(numberedName("data.tar.gz", 2)).toBe("data (2).tar.gz");
    expect(numberedName("README", 1)).toBe("README (1)");
    expect(numberedName(".bashrc", 1)).toBe(".bashrc (1)");
  });

  test("the first free name", () => {
    const taken = new Set(["report.pdf", "report (1).pdf"]);
    expect(uniqueFilename("report.pdf", (n) => taken.has(n))).toBe("report (2).pdf");
    expect(uniqueFilename("new.pdf", (n) => taken.has(n))).toBe("new.pdf");
  });

  test("safe on every platform, never empty", () => {
    expect(safeFilename("a/b\\c:d*e?.txt")).toBe("a_b_c_d_e_.txt");
    expect(safeFilename("  ..hidden.  ")).toBe("hidden");
    expect(safeFilename("")).toBe("download");
    expect(safeFilename("...")).toBe("download");
    expect(safeFilename("CON.txt")).toBe("_CON.txt");
    expect(safeFilename("nul")).toBe("_nul");
    expect(safeFilename("console.log")).toBe("console.log");
    // Too long: shortened, keeping its type (so a risky one is still caught).
    const long = safeFilename(`${"a".repeat(150)} ${"b".repeat(60)}.exe`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith(".exe")).toBe(true);
    expect(isDangerousFile(long)).toBe(true);
    // ...by bytes: 100 Japanese characters are 300 bytes.
    const japanese = safeFilename(`${"報".repeat(100)}.pdf`);
    expect(new TextEncoder().encode(japanese).length).toBeLessThanOrEqual(200);
    expect(japanese.endsWith("報.pdf")).toBe(true);
  });
});

describe("progress", () => {
  test("sizes, speed and time left read like Chromium's", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1500)).toBe("1.5 kB");
    expect(formatBytes(4_000_000)).toBe("4.0 MB");
    expect(formatBytes(25_000_000)).toBe("25 MB");
    expect(formatBytes(999_950)).toBe("1.0 MB");
    expect(formatTimeLeft(4.2)).toBe("5 s left");
    expect(formatTimeLeft(180)).toBe("3 min left");
    expect(formatTimeLeft(3600 + 20 * 60)).toBe("1 h 20 min left");
    expect(formatTimeLeft(7200)).toBe("2 h left");
    expect(secondsLeft(download({ speed: 1_000_000 }))).toBe(6);
    expect(secondsLeft(download({ speed: 0 }))).toBeNull();
    expect(secondsLeft(download({ totalBytes: 0, speed: 100 }))).toBeNull();
  });

  test("a status line for every state", () => {
    expect(downloadStatus(download({ speed: 1_000_000 }))).toBe("1.0 MB/s · 4.0 MB of 10 MB, 6 s left");
    expect(downloadStatus(download({ totalBytes: 0, speed: 0 }))).toBe("4.0 MB");
    expect(downloadStatus(download({ paused: true }))).toBe("Paused · 4.0 MB of 10 MB");
    expect(downloadStatus(download({ state: "completed", receivedBytes: 10_000_000, exists: true }))).toBe("10 MB");
    expect(downloadStatus(download({ state: "completed", exists: false }))).toBe("Deleted");
    expect(downloadStatus(download({ state: "cancelled" }))).toBe("Cancelled");
    expect(downloadStatus(download({ state: "interrupted", error: "Network error" }))).toBe("Failed: Network error");
    expect(downloadStatus(download({ danger: "file" }))).toBe("This type of file can harm your computer");
    expect(downloadStatus(download({ danger: "insecure" }))).toBe("Downloaded from a site without HTTPS");
    expect(downloadStatus(download({ danger: "file", error: "Couldn't save the file: EACCES" }))).toBe(
      "Couldn't save the file: EACCES",
    );
    expect(downloadStatus(download({ danger: "file", discarded: true, state: "cancelled" }))).toBe("Discarded");
    expect(downloadStatus(download({ path: "", receivedBytes: 0 }))).toBe("Starting…");
  });
});

describe("the list", () => {
  test("the site, searching by name, site or address", () => {
    expect(downloadSite(download())).toBe("files.example.com");
    expect(downloadSite(download({ url: "blob:https://www.example.com/abc" }))).toBe("example.com");
    expect(downloadSite(download({ url: "data:text/plain,x", pageUrl: "https://example.org/p" }))).toBe("example.org");
    expect(downloadSite(download({ url: "file:///home/me/a.bin", pageUrl: null }))).toBe("This computer");
    expect(matchesDownload(download(), "REPORT")).toBe(true);
    expect(matchesDownload(download(), "files.example")).toBe(true);
    expect(matchesDownload(download(), "/reports")).toBe(true);
    expect(matchesDownload(download(), "invoice")).toBe(false);
    expect(matchesDownload(download(), "  ")).toBe(true);
  });

  test("by day, newest first", () => {
    const now = new Date(2026, 10, 2, 18).getTime();
    const list = [
      download({ id: "old", startedAt: new Date(2026, 9, 20, 9).getTime() }),
      download({ id: "today", startedAt: new Date(2026, 10, 2, 9).getTime() }),
      download({ id: "yesterday", startedAt: new Date(2026, 10, 1, 23).getTime() }),
      download({ id: "later-today", startedAt: new Date(2026, 10, 2, 17).getTime() }),
    ];
    const groups = groupByDay(list, now);
    expect(
      groups.map((g) => [g.label === "Today" || g.label === "Yesterday" ? g.label : "date", g.items.map((d) => d.id)]),
    ).toEqual([
      ["Today", ["later-today", "today"]],
      ["Yesterday", ["yesterday"]],
      ["date", ["old"]],
    ]);
    expect(dayLabel(new Date(2025, 0, 5).getTime(), now)).toContain("2025");
  });

  test("restored after a restart: what was running failed, with a reason; junk is dropped", () => {
    const now = 1_000;
    const saved = [
      savedDownload(download({ id: "running", speed: 5, canResume: true })),
      savedDownload(download({ id: "done", state: "completed", endedAt: 500, exists: true })),
      { id: 3 },
      null,
      "x",
    ];
    const restored = restoreDownloads(saved, now);
    expect(restored.map((d) => [d.id, d.state, d.error, d.endedAt])).toEqual([
      ["running", "interrupted", "Rune Browser was closed", now],
      ["done", "completed", null, 500],
    ]);
    expect("speed" in restored[0]!).toBe(false);
    expect(restoreDownloads({ not: "a list" })).toEqual([]);
  });

  test("what can be retried, and data: addresses aren't kept whole", () => {
    expect(canRetry(download())).toBe(true);
    expect(canRetry(download({ url: "file:///home/me/a.bin" }))).toBe(true);
    expect(canRetry(download({ url: "blob:https://example.com/abc" }))).toBe(false);
    const data = `data:application/octet-stream;base64,${"A".repeat(100_000)}`;
    expect(keptUrl(data).length).toBeLessThan(100);
    expect(canRetry(download({ url: keptUrl(data) }))).toBe(false);
    const long = `https://example.com/?q=${"x".repeat(9000)}`;
    expect(canRetry(download({ url: keptUrl(long) }))).toBe(false);
    expect(keptUrl("https://example.com/a")).toBe("https://example.com/a");
  });
});
