// rune://flags (shared/flags.ts): what the user turned on or off is kept in
// <userData>/flags.json and applied as Chromium switches before the app is
// ready, like Chrome applies chrome://flags at startup. Safe mode skips them.
import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanFlagState, flagSwitches, type FlagState } from "../shared/flags";

const flagsFile = () => join(app.getPath("userData"), "flags.json");

export function readFlags(): FlagState {
  try {
    return cleanFlagState(JSON.parse(readFileSync(flagsFile(), "utf8")), process.platform);
  } catch {
    return {};
  }
}

export function writeFlags(state: FlagState) {
  writeFileSync(flagsFile(), JSON.stringify(cleanFlagState(state, process.platform), null, 2));
}

/** Adds to a comma-separated switch (enable-features…) instead of replacing what's there. */
function appendList(name: string, values: string[]) {
  if (!values.length) return;
  const current = app.commandLine.getSwitchValue(name);
  app.commandLine.appendSwitch(name, [...(current ? current.split(",") : []), ...values].join(","));
}

/** Applies the saved flags (call before the app is ready). Returns what was applied. */
export function applyFlags(safeMode: boolean): FlagState {
  if (safeMode) return {};
  const state = readFlags();
  const { switches, enableFeatures, disableFeatures } = flagSwitches(state, process.platform);
  for (const [name, value] of switches) {
    // A switch given on the command line wins, like in Chrome.
    if (app.commandLine.hasSwitch(name)) continue;
    if (value === undefined) app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, value);
  }
  appendList("enable-features", enableFeatures);
  appendList("disable-features", disableFeatures);
  return state;
}
