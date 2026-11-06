// Where the tabs are (Settings → Appearance): new profiles start with horizontal tabs,
// profiles from before there was a choice keep the vertical sidebar (db/Db.ts).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { decodeSettings } from "../src/shared/settings";
import { readConfig } from "../src/server/Config";
import { Settings } from "../src/server/db/Settings";
import { core } from "../src/server/services";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Starts the server's services on a data dir (migrating its database), and reads the settings. */
async function layoutAfterStart(dataDir: string) {
  const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        return (yield* (yield* Settings).get()).tabs.layout;
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "rune-layout-"));
  dirs.push(dir);
  return dir;
};

/** A database as an older Rune Browser left it: its tables, and settings without a layout (or none). */
function olderProfile(dir: string, settings?: object) {
  const db = new Database(join(dir, "rune.sqlite"));
  db.run("CREATE TABLE apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT)");
  db.run("CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)");
  if (settings) db.run("INSERT INTO settings (id, value) VALUES (1, ?)", [JSON.stringify(settings)]);
  db.close();
}

test("defaults to horizontal tabs", () => {
  expect(decodeSettings({}).tabs.layout).toBe("horizontal");
});

test("a new profile starts with horizontal tabs, and keeps them on the next start", async () => {
  const dir = dataDir();
  expect(await layoutAfterStart(dir)).toBe("horizontal");
  expect(await layoutAfterStart(dir)).toBe("horizontal");
});

test("an older profile keeps the vertical sidebar, with or without saved settings", async () => {
  const withSettings = dataDir();
  olderProfile(withSettings, { tabs: { unloadAfterMinutes: 10 }, theme: { mode: "dark" } });
  expect(await layoutAfterStart(withSettings)).toBe("vertical");
  const db = new Database(join(withSettings, "rune.sqlite"));
  const saved = JSON.parse(db.query<{ value: string }, []>("SELECT value FROM settings").get()!.value);
  db.close();
  // The rest of its settings are left as they were.
  expect(saved).toEqual({ tabs: { unloadAfterMinutes: 10, layout: "vertical" }, theme: { mode: "dark" } });

  const without = dataDir();
  olderProfile(without);
  expect(await layoutAfterStart(without)).toBe("vertical");
});

test("a layout chosen later stays chosen", async () => {
  const dir = dataDir();
  olderProfile(dir, { tabs: { layout: "horizontal" } });
  expect(await layoutAfterStart(dir)).toBe("horizontal");
  expect(await layoutAfterStart(dir)).toBe("horizontal");
});
