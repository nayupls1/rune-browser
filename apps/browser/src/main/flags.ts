// rune://flags (shared/flags.ts): what the user turned on or off is kept in
// <userData>/flags.json and applied as Chromium switches before the app is
// ready, like Chrome applies chrome://flags at startup. Safe mode skips them.
import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanFlagState, flags, flagSwitches, type FlagState } from "../shared/flags";

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

/**
 * Applies the saved flags (call before the app is ready). Returns what was applied: a flag
 * whose switch was also given on the command line isn't (the command line wins, like in Chrome).
 */
export function applyFlags(safeMode: boolean): FlagState {
  if (safeMode) return {};
  const applied: FlagState = {};
  for (const [id, value] of Object.entries(readFlags())) {
    const { switches, enableFeatures, disableFeatures } = flagSwitches({ [id]: value }, process.platform);
    // Any of its switches (--enable-quic for a disabled QUIC too) on the command line.
    const names = flags.find((f) => f.id === id)?.options.flatMap((o) => (o.switches ?? []).map(([n]) => n)) ?? [];
    if (names.some((name) => app.commandLine.hasSwitch(name))) continue;
    for (const [name, switchValue] of switches) {
      if (switchValue === undefined) app.commandLine.appendSwitch(name);
      else app.commandLine.appendSwitch(name, switchValue);
    }
    appendList("enable-features", enableFeatures);
    appendList("disable-features", disableFeatures);
    applied[id] = value;
  }
  return applied;
}

/**
 * Chromium features Rune Browser turns off (call before the app is ready, after applyFlags), unless
 * --enable-features on the command line turns them on.
 *
 * - RenderDocument: a new frame (and compositor surface) for every page a tab goes to. A Chrome tab is
 *   drawn by the browser itself, but a web tab is a <webview> inside Rune Browser's window, so the
 *   window's page has to pick up the new surface first, and the compositor waits for that (up to four
 *   frames). Without it, the next page was on screen 15–30% sooner.
 */
const TURNED_OFF = ["RenderDocument"];

export function applyDefaultFeatures() {
  const enabled = app.commandLine.getSwitchValue("enable-features").split(",");
  appendList(
    "disable-features",
    TURNED_OFF.filter((name) => !enabled.includes(name)),
  );
}
