import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  AUTOSTART_FILE,
  autostartDesktopEntry,
  autostartPath,
  BACKGROUND_ARG,
  isOwnAutostart,
  launchCommand,
  loginItemSettings,
} from "../src/main/autostart";
import { linksFromArgs } from "../src/main/links";
import { xdgDirs } from "../src/main/mimeapps";
import { BrowserSettings, defaultBrowserSettings, runsInBackground } from "../src/shared/browser";
import { settingsCategoryOf } from "../src/shared/internalPages";
import { LINUX_DESKTOP_FILE } from "../src/shared/defaultBrowser";

const decode = Schema.decodeUnknownSync(BrowserSettings);

describe("background settings", () => {
  test("keep running is on by default (like Chrome), open at login off", () => {
    expect(defaultBrowserSettings().background).toEqual({ keepRunning: true, openAtLogin: false });
  });

  test("settings saved before the setting existed get the defaults; saved ones are kept", () => {
    expect(decode({ push: { service: "off" } }).background).toEqual({ keepRunning: true, openAtLogin: false });
    expect(decode({ background: { openAtLogin: true } }).background).toEqual({ keepRunning: true, openAtLogin: true });
    expect(decode({ background: { keepRunning: false } }).background.keepRunning).toBe(false);
    expect(() => decode({ background: { keepRunning: "yes" } })).toThrow();
  });

  test("it runs in the background while the setting is on and push is (there's something to receive)", () => {
    const b = defaultBrowserSettings();
    expect(runsInBackground(b)).toBe(true);
    expect(runsInBackground({ ...b, push: { service: "custom", server: "https://ntfy.example.com" } })).toBe(true);
    // Your own server not typed in yet: still on (it may be in a moment).
    expect(runsInBackground({ ...b, push: { service: "custom", server: "" } })).toBe(true);
    expect(runsInBackground({ ...b, push: { service: "off", server: "" } })).toBe(false);
    expect(runsInBackground({ ...b, background: { keepRunning: false, openAtLogin: true } })).toBe(false);
  });
});

test("chrome://settings/system opens Settings → General → System", () => {
  expect(settingsCategoryOf("system", ["browser-system", "general"])).toBe("browser-system");
});

describe("open at login", () => {
  test("Linux: the autostart file goes in the user's autostart folder, named like the installed .desktop file", () => {
    expect(AUTOSTART_FILE).toBe(LINUX_DESKTOP_FILE);
    expect(autostartPath(xdgDirs({}, "/home/me"))).toBe("/home/me/.config/autostart/rune-browser.desktop");
    expect(autostartPath(xdgDirs({ XDG_CONFIG_HOME: "/cfg" }, "/home/me"))).toBe("/cfg/autostart/rune-browser.desktop");
    // A relative XDG_CONFIG_HOME is ignored, as the spec says.
    expect(autostartPath(xdgDirs({ XDG_CONFIG_HOME: "cfg" }, "/home/me"))).toBe(
      "/home/me/.config/autostart/rune-browser.desktop",
    );
  });

  test("what starts it: the AppImage, the installed app, or Electron with the app's folder", () => {
    const base = { execPath: "/opt/Rune Browser/rune-browser", appPath: "/opt/Rune Browser/resources/app.asar" };
    expect(launchCommand({ ...base, packaged: true })).toEqual(["/opt/Rune Browser/rune-browser"]);
    expect(launchCommand({ ...base, packaged: false })).toEqual([base.execPath, base.appPath]);
    expect(launchCommand({ ...base, packaged: true, appImage: "/home/me/Apps/Rune.AppImage" })).toEqual([
      "/home/me/Apps/Rune.AppImage",
    ]);
  });

  test("the autostart file starts it in the background, with every path quoted as the Exec key wants", () => {
    const entry = autostartDesktopEntry({
      command: ["/home/me/My Apps/Rune 100%.AppImage"],
      icon: "rune-browser",
    });
    const lines = entry.split("\n");
    expect(lines[0]).toBe("[Desktop Entry]");
    expect(lines).toContain("Type=Application");
    expect(lines).toContain("Name=Rune Browser");
    expect(lines).toContain("Icon=rune-browser");
    expect(lines).toContain("Terminal=false");
    expect(lines).toContain("X-GNOME-Autostart-enabled=true");
    expect(lines).toContain(`Exec="/home/me/My Apps/Rune 100%%.AppImage" ${BACKGROUND_ARG}`);
    expect(entry.endsWith("\n")).toBe(true);
    // Electron and the app's folder (a run from the repo): two arguments.
    const dev = autostartDesktopEntry({ command: ["/repo/electron", "/repo/app"], icon: "rune-browser" });
    expect(dev).toContain(`Exec="/repo/electron" "/repo/app" ${BACKGROUND_ARG}\n`);
  });

  test("only Rune Browser's own autostart file is replaced or removed", () => {
    expect(isOwnAutostart(autostartDesktopEntry({ command: ["/usr/bin/rune-browser"], icon: "x" }))).toBe(true);
    expect(isOwnAutostart("[Desktop Entry]\nType=Application\nExec=rune-browser --some-flag\n")).toBe(false);
    expect(isOwnAutostart("[Desktop Entry]\nComment=X-Rune-Autostart=true\n")).toBe(false);
  });

  test("macOS and Windows: a login item that starts it in the background", () => {
    const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\rune-browser\\Rune Browser.exe";
    expect(loginItemSettings({ openAtLogin: true, packaged: true, execPath: exe, appPath: "unused" })).toEqual({
      openAtLogin: true,
      path: exe,
      args: [BACKGROUND_ARG],
    });
    expect(
      loginItemSettings({
        openAtLogin: false,
        packaged: false,
        execPath: "C:\\e\\electron.exe",
        appPath: "C:\\r\\app",
      }),
    ).toEqual({ openAtLogin: false, path: "C:\\e\\electron.exe", args: ['"C:\\r\\app"', BACKGROUND_ARG] });
  });

  test("the background flag is never taken for a link or a file to open", () => {
    expect(linksFromArgs(["/usr/bin/rune-browser", BACKGROUND_ARG], "/", () => true)).toEqual([]);
  });
});
