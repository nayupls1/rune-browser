import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { APP_USER_MODEL_ID, DEV_APP_USER_MODEL_ID, taskbarDetails } from "../src/main/taskbar";

describe("Windows taskbar", () => {
  test("the installed app's ID is the installer's (its shortcuts carry electron-builder's appId)", () => {
    const appId = readFileSync("electron-builder.yml", "utf8").match(/^appId:\s*(\S+)\s*$/m)?.[1];
    expect(appId).toBe(APP_USER_MODEL_ID);
  });

  test("the installed app's windows show and relaunch its own executable", () => {
    const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\rune-browser\\rune-browser.exe";
    expect(taskbarDetails({ packaged: true, execPath: exe, appPath: "unused", iconPath: "unused" })).toEqual({
      appId: APP_USER_MODEL_ID,
      appIconPath: exe,
      appIconIndex: 0,
      relaunchCommand: `"${exe}"`,
      relaunchDisplayName: "Rune Browser",
    });
  });

  test("runs from the repo have their own ID, Rune's icon and relaunch the repo", () => {
    const details = taskbarDetails({
      packaged: false,
      execPath: "C:\\repo\\node_modules\\electron\\dist\\electron.exe",
      appPath: "C:\\repo",
      iconPath: "C:\\repo\\dist\\electron\\icon.ico",
    });
    expect(details.appId).toBe(DEV_APP_USER_MODEL_ID);
    expect(details.appId).not.toBe(APP_USER_MODEL_ID);
    expect(details.appIconPath).toBe("C:\\repo\\dist\\electron\\icon.ico");
    expect(details.relaunchCommand).toBe('"C:\\repo\\node_modules\\electron\\dist\\electron.exe" "C:\\repo"');
  });
});
