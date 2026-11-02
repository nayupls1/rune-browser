import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { crashReport, describeExitCode, issueUrl, linesSince, logLine, redactPaths } from "../src/main/crashReport";

describe("crash reports", () => {
  test("Windows exit codes read like Windows shows them", () => {
    // child-process-gone gives them as signed 32-bit numbers.
    expect(describeExitCode(-1073741819, "win32")).toBe("0xC0000005 (access violation)");
    expect(describeExitCode(0xc0000409, "win32")).toBe("0xC0000409 (stack buffer overrun)");
    expect(describeExitCode(0xc0001234, "win32")).toBe("0xC0001234");
    expect(describeExitCode(1, "win32")).toBe("1");
    expect(describeExitCode(139, "linux")).toBe("139");
    expect(describeExitCode(null, "win32")).toBe("none");
  });

  test("the user's home folder (their name) is taken out, however it's written", () => {
    const home = "C:\\Users\\Jane Doe";
    expect(redactPaths("at C:\\Users\\Jane Doe\\AppData\\x.js and c:/users/jane doe/y", home)).toBe(
      "at ~\\AppData\\x.js and ~/y",
    );
    expect(redactPaths("/home/jane/.config/rune", "/home/jane")).toBe("~/.config/rune");
  });

  test("a report has the versions, what happened and recent events, without paths or tokens", () => {
    const report = crashReport(
      {
        version: "0.1.0",
        electron: "45.2.1",
        chrome: "140.0",
        os: "win32 10.0.26100 x64",
        what: "Rune Browser closed unexpectedly",
        log: [
          logLine("GPU process gone: crashed, exit code 0xC0000005 (access violation)"),
          logLine("Uncaught error at C:\\Users\\Jane\\app.js: Bearer abc.def-123"),
        ],
      },
      "C:\\Users\\Jane",
    );
    expect(report).toContain("Rune Browser 0.1.0 (Electron 45.2.1, Chromium 140.0)");
    expect(report).toContain("What happened: Rune Browser closed unexpectedly");
    expect(report).toContain("0xC0000005");
    expect(report).not.toContain("Jane");
    expect(report).not.toContain("abc.def-123");
  });

  test("the GitHub issue is the bug report form, filled in, and short enough for a URL", () => {
    const fields = { version: "0.1.0", platform: "win32", osDetails: "10.0.26100 x64", what: "Rune Browser crashed" };
    const url = new URL(
      issueUrl("https://github.com/o/r/issues", "Rune Browser crashed", "line one\nline two", fields),
    );
    expect(url.pathname).toBe("/o/r/issues/new");
    // The form's field ids (.github/ISSUE_TEMPLATE/bug_report.yml).
    const form = readFileSync(".github/ISSUE_TEMPLATE/bug_report.yml", "utf8");
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    for (const id of ["what", "version", "os", "os-details", "extra"]) {
      expect(form).toContain(`id: ${id}`);
      expect(url.searchParams.get(id)).toBeTruthy();
    }
    expect(url.searchParams.get("title")).toBe("Rune Browser crashed");
    expect(url.searchParams.get("os")).toBe("Windows");
    expect(form).toContain("- Windows");
    expect(url.searchParams.get("extra")).toContain("line one\nline two");

    const events = Array.from({ length: 400 }, (_, i) => `event ${i} ${"x".repeat(40)}`);
    const long = ["head 1", "head 2", "head 3", "head 4", "head 5", ...events].join("\n");
    const cut = issueUrl("https://github.com/o/r/issues/", "t", long, fields);
    expect(cut.length).toBeLessThanOrEqual(7000);
    const extra = new URL(cut).searchParams.get("extra")!;
    expect(extra).toContain("head 5");
    expect(extra).toContain("event 399");
    expect(extra).not.toContain("event 0 ");
  });

  test("log lines are one line each, and only this run's are picked", () => {
    expect(logLine("a\n  b", new Date("2026-01-01T00:00:00Z"))).toBe("[2026-01-01T00:00:00.000Z] a ⏎ b");
    const log = [
      logLine("old", new Date("2026-01-01T00:00:00Z")),
      logLine("new 1", new Date("2026-01-02T00:00:00Z")),
      "not a log line",
      logLine("new 2", new Date("2026-01-03T00:00:00Z")),
    ].join("\n");
    const lines = linesSince(log, Date.parse("2026-01-02T00:00:00Z"));
    expect(lines.map((l) => l.split("] ")[1])).toEqual(["new 1", "new 2"]);
    expect(linesSince(log, 0, 1)).toHaveLength(1);
  });
});
