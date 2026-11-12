// First-run setup (components/Onboarding.tsx): new profiles get it, older ones don't, scripts with a throwaway
// profile skip it (db/Db.ts, Config.ts); when a window shows it; the browsers it offers to import from.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, ManagedRuntime } from "effect";
import type { ImportCandidate } from "../src/shared/extensions";
import { groupImportProfiles, onboardingSteps, PUSH_STEP, showsOnboarding } from "../src/shared/onboarding";
import { decodeSettings } from "../src/shared/settings";
import { readConfig } from "../src/server/Config";
import { Settings } from "../src/server/db/Settings";
import { core } from "../src/server/services";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "rune-onboarding-"));
  dirs.push(dir);
  return dir;
};

/** Starts the server's services on a data dir (migrating its database) and returns what the settings say. */
async function onboardingAfterStart(dir: string, env: Record<string, string> = {}, save?: "completed" | "skipped") {
  const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dir, PORT: "1", ...env })));
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const settings = yield* Settings;
        if (save) yield* settings.save({ ...(yield* settings.get()), onboarding: save });
        return (yield* settings.get()).onboarding;
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

test("a new profile gets the setup, and keeps it pending until it's done or skipped", async () => {
  const dir = dataDir();
  expect(await onboardingAfterStart(dir)).toBe("pending");
  expect(await onboardingAfterStart(dir)).toBe("pending");
  expect(await onboardingAfterStart(dir, {}, "completed")).toBe("completed");
  // It doesn't come back on the next start.
  expect(await onboardingAfterStart(dir)).toBe("completed");
});

test("a new profile with settings written by a script first still gets it", async () => {
  // e2e writes the tab layout into a fresh profile before starting.
  const dir = dataDir();
  const db = new Database(join(dir, "rune.sqlite"));
  db.run("CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)");
  db.run(`INSERT INTO settings (id, value) VALUES (1, '{"tabs":{"layout":"vertical"}}')`);
  db.close();
  expect(await onboardingAfterStart(dir)).toBe("pending");
});

test("RUNE_SKIP_ONBOARDING starts a new profile without it", async () => {
  const dir = dataDir();
  expect(await onboardingAfterStart(dir, { RUNE_SKIP_ONBOARDING: "1" })).toBe("skipped");
  // Only a new profile: an existing one is left as it is.
  const other = dataDir();
  expect(await onboardingAfterStart(other)).toBe("pending");
  expect(await onboardingAfterStart(other, { RUNE_SKIP_ONBOARDING: "1" })).toBe("pending");
});

test("profiles from before it count as set up", async () => {
  const dir = dataDir();
  const db = new Database(join(dir, "rune.sqlite"));
  db.run("CREATE TABLE apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT)");
  db.run("CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)");
  db.run(`INSERT INTO settings (id, value) VALUES (1, '{"theme":{"mode":"dark"}}')`);
  db.close();
  expect(await onboardingAfterStart(dir)).toBe("completed");
  expect(decodeSettings({}).onboarding).toBe("completed");
});

test("shown while pending, never in private windows or safe mode", () => {
  const normal = { private: false, safeMode: false };
  expect(showsOnboarding({ onboarding: "pending" }, normal)).toBe(true);
  expect(showsOnboarding({ onboarding: "completed" }, normal)).toBe(false);
  expect(showsOnboarding({ onboarding: "skipped" }, normal)).toBe(false);
  expect(showsOnboarding({ onboarding: "pending" }, { private: true, safeMode: false })).toBe(false);
  expect(showsOnboarding({ onboarding: "pending" }, { private: false, safeMode: true })).toBe(false);
});

test("the notifications step waits for web push", () => {
  expect(PUSH_STEP).toBe(false);
  expect(onboardingSteps()).toEqual(["import", "layout", "default", "agent"]);
  expect(onboardingSteps(true)).toEqual(["import", "layout", "default", "push", "agent"]);
});

const extension = (id: string, over: Partial<ImportCandidate> = {}): ImportCandidate => ({
  id,
  name: id,
  version: "1.0",
  description: "",
  icon: null,
  enabledThere: true,
  byDefault: false,
  unpacked: false,
  installed: false,
  hasSettings: false,
  unsupported: [],
  ...over,
});

test("browsers to import from: each profile once, with what it has, the fullest first", () => {
  const profiles = groupImportProfiles(
    [
      { id: "b1", browser: "Chromium", profile: "Work", count: 2 },
      { id: "b2", browser: "Firefox", profile: "default-release", count: 40 },
      { id: "b3", browser: "Brave", profile: "Default", count: 0 },
    ],
    [
      { key: "s1", browser: "Chromium", profile: "Work", found: { fonts: { size: 18 } } },
      { key: "s2", browser: "Brave", profile: "Default", found: {} },
    ],
    [
      { key: "e1", browser: "Chromium", profile: "Work", extensions: [extension("a"), extension("b")] },
      // Only extensions that came with the browser, or are here already: nothing to bring.
      {
        key: "e2",
        browser: "Brave",
        profile: "Default",
        extensions: [extension("c", { byDefault: true }), extension("d", { installed: true })],
      },
    ],
  );
  expect(profiles.map((p) => [p.browser, p.profile])).toEqual([
    ["Firefox", "default-release"],
    ["Chromium", "Work"],
  ]);
  const work = profiles[1]!;
  expect(work.bookmarks?.id).toBe("b1");
  expect(work.settings?.key).toBe("s1");
  expect(work.extensions?.key).toBe("e1");
  expect(profiles[0]!.settings).toBeUndefined();
});
