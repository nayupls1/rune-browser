// Crashes: Chromium writes a crash report (a minidump, kept on this computer,
// never uploaded) for any of Rune Browser's processes that crashes, and what
// went wrong is logged in logs/crashes.log: processes that died and why (with
// Windows' exit codes, e.g. 0xC0000005, an access violation), the backend
// server stopping, errors the main process survived. When Rune Browser itself
// went down, the next start tells the user, and when something it can't do
// without stops (the server, the window's page), it says so right away. Either
// way they can copy the details or open a GitHub issue with them filled in
// (main/crashReport.ts keeps their paths and tokens out of it).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, clipboard, crashReporter, dialog, powerMonitor, shell, type BrowserWindow } from "electron";
import pkg from "../../package.json" with { type: "json" };
import { crashReport, describeExitCode, issueUrl, linesSince, logLine } from "./crashReport";

/** The log is cut to its newer half past this. */
const MAX_LOG = 512 * 1024;

export interface CrashDialog {
  title: string;
  /** What happened, for the user (the dialog's main text). */
  message: string;
  /** What happened, for the report (one sentence). */
  what: string;
  /** Include the log from this time on (ms). */
  since: number;
  /** A crash report file to point to. */
  dump?: string;
  /** An extra first button, e.g. restarting Rune Browser. */
  action?: { label: string; run: () => void };
}

export function setupCrashReports() {
  const userData = app.getPath("userData");
  const logDir = join(userData, "logs");
  const logFile = join(logDir, "crashes.log");
  const marker = join(userData, "running.json");
  const startedAt = Date.now();
  // Tests run offscreen: they log, but never show a dialog.
  const quiet = process.env.RUNE_OFFSCREEN === "1";

  // Under the profile in use (tests set their own userData after Electron picked the default).
  app.setPath("crashDumps", join(userData, "Crashpad"));
  try {
    crashReporter.start({ uploadToServer: false });
  } catch (err) {
    console.error("Couldn't start the crash reporter:", err);
  }

  function log(message: string) {
    try {
      mkdirSync(logDir, { recursive: true });
      if (existsSync(logFile) && statSync(logFile).size > MAX_LOG) {
        const text = readFileSync(logFile, "utf8");
        writeFileSync(logFile, text.slice(text.indexOf("\n", text.length / 2) + 1));
      }
      appendFileSync(logFile, `${logLine(message)}\n`);
    } catch {
      // Logging must never be what takes the app down.
    }
  }
  const readLog = () => {
    try {
      return readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
  };

  // --- This run --------------------------------------------------------------------------------------

  let previous: { startedAt?: number; version?: string } | null = null;
  try {
    previous = JSON.parse(readFileSync(marker, "utf8"));
  } catch {
    // quit cleanly last time (or never ran)
  }
  try {
    writeFileSync(marker, JSON.stringify({ startedAt, version: pkg.version }));
  } catch {
    // read-only profile: no crash detection on the next start
  }
  const cleanExit = () => rmSync(marker, { force: true });
  app.on("will-quit", cleanExit);
  // Windows shutting down or the user signing out isn't a crash.
  app.whenReady().then(() => powerMonitor.on("shutdown", cleanExit));

  app.on("child-process-gone", (_event, d) => {
    if (d.reason === "clean-exit") return;
    log(
      `${d.type}${d.name ? ` (${d.name})` : ""} process gone: ${d.reason}, exit code ${describeExitCode(d.exitCode)}`,
    );
  });
  app.on("render-process-gone", (_event, contents, d) => {
    if (d.reason === "clean-exit") return;
    // No URL: it's the user's browsing.
    log(`A page's process (${contents.getType()}) is gone: ${d.reason}, exit code ${describeExitCode(d.exitCode)}`);
  });

  // --- Telling the user ------------------------------------------------------------------------------

  const reportFor = (what: string, since: number) =>
    crashReport(
      {
        version: pkg.version,
        electron: process.versions.electron ?? "",
        chrome: process.versions.chrome ?? "",
        os: `${process.platform} ${process.getSystemVersion?.() ?? ""} ${process.arch}`,
        what,
        log: linesSince(readLog(), since),
      },
      homedir(),
    );

  let showing = false;
  async function show(win: BrowserWindow | undefined, d: CrashDialog) {
    log(`Told the user: ${d.what}`);
    if (quiet || showing) return;
    showing = true;
    try {
      const report = reportFor(d.what, d.since);
      const buttons = [
        ...(d.action ? [d.action.label] : []),
        "Copy details",
        "Report on GitHub",
        ...(d.dump ? ["Show crash report"] : []),
        "Close",
      ];
      let copied = false;
      for (;;) {
        const options: Electron.MessageBoxOptions = {
          type: "error",
          title: d.title,
          message: d.message,
          detail: copied ? `${report}\n\nCopied to the clipboard.` : report,
          buttons,
          defaultId: 0,
          cancelId: buttons.length - 1,
          noLink: true,
        };
        const target = win && !win.isDestroyed() ? win : undefined;
        const { response } = await (target ? dialog.showMessageBox(target, options) : dialog.showMessageBox(options));
        const picked = buttons[response];
        if (picked === "Copy details") {
          clipboard.writeText(report);
          copied = true;
          continue;
        }
        if (picked === "Report on GitHub")
          void shell.openExternal(
            issueUrl(pkg.bugs, d.title, report, {
              version: pkg.version,
              platform: process.platform,
              osDetails: `${process.getSystemVersion?.() ?? ""} ${process.arch}`.trim(),
              what: d.what,
            }),
          );
        else if (picked === "Show crash report" && d.dump) shell.showItemInFolder(d.dump);
        else if (d.action && picked === d.action.label) d.action.run();
        if (picked === "Show crash report") continue;
        return;
      }
    } finally {
      showing = false;
    }
  }

  /** The newest crash report written at `since` or later. */
  function dumpSince(since: number) {
    const found: { path: string; at: number }[] = [];
    const walk = (dir: string, depth: number) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const path = join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(path, depth + 1);
        else if (e.isFile() && e.name.endsWith(".dmp")) {
          const at = statSync(path).mtimeMs;
          if (at >= since) found.push({ path, at });
        }
      }
    };
    walk(app.getPath("crashDumps"), 0);
    return found.sort((a, b) => b.at - a.at)[0]?.path;
  }

  return {
    log,
    show,
    /** Before quitting on purpose without `will-quit` (app.exit). */
    cleanExit,
    /** Once the window is there: if Rune Browser went down last time, says so. */
    checkPreviousRun(win: BrowserWindow) {
      if (!previous?.startedAt) return;
      const since = previous.startedAt;
      const dump = dumpSince(since);
      // Killed (Task Manager, power cut) leaves no crash report: nothing to tell then.
      if (!dump) return log("The last run didn't quit cleanly (no crash report: it was probably closed from outside)");
      const tell = () =>
        show(win, {
          title: "Rune Browser closed unexpectedly",
          message: "Rune Browser crashed the last time it ran. Sending the details helps get it fixed.",
          what: `Rune Browser ${previous.version ?? ""} closed unexpectedly (crash report ${dump.split(/[\\/]/).pop()})`,
          since,
          dump,
        });
      // Over the window once it's on screen (it's created hidden).
      if (win.isVisible()) void tell();
      else win.once("show", () => void tell());
    },
  };
}

export type CrashReports = ReturnType<typeof setupCrashReports>;
