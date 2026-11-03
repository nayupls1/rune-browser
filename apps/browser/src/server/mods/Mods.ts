// Installed mods (shared/mods.ts): installing one adds its page changes
// (marked with the mod, so they go with it) and applies its theme, keeping the
// theme it replaced; turning it off or removing it takes all of that back.
// Extensions are installed by the renderer (Electron's main process does
// that) and recorded here, so removing the mod removes the ones it brought.
// Every install, switch and removal is a snapshot and in Activity.
import { Context, Data, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { topics } from "../../shared/hub";
import {
  MOD_MAX_BYTES,
  newModId,
  parseMod,
  reviewMod,
  type GalleryResult,
  type InstalledMod,
  type Mod,
  type ModExtension,
  type ModReview,
} from "../../shared/mods";
import type { GlobalTheme } from "../../shared/settings";
import { pageChangeSpec } from "../../shared/web";
import { PageChanges, pageChangeError } from "../db/PageChanges";
import { Settings } from "../db/Settings";
import { History } from "../history/History";
import { Hub } from "../Hub";
import { Audit } from "../security/Audit";
import { builtInMods } from "./gallery";

export class ModError extends Data.TaggedError("ModError")<{
  readonly status: 400 | 404 | 502;
  readonly message: string;
}> {}

/** What installing a mod did, to take it back. */
interface ModState {
  /** The theme before the mod's was applied (while it's applied). */
  previousTheme?: GlobalTheme;
  themeApplied?: boolean;
  /** Extensions the mod installed (ones that were there already aren't removed with it). */
  extensions?: string[];
}

interface ModRow {
  id: string;
  mod: string;
  enabled: number;
  source: string;
  state: string;
  installed_at: string;
}

const toInstalled = (r: ModRow): InstalledMod => ({
  mod: JSON.parse(r.mod) as Mod,
  enabled: r.enabled === 1,
  source: r.source,
  installedAt: r.installed_at,
  installedExtensions: (JSON.parse(r.state) as ModState).extensions ?? [],
});

const sameTheme = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pageChanges = yield* PageChanges;
  const settings = yield* Settings;
  const history = yield* History;
  const hub = yield* Hub;
  const audit = yield* Audit;

  const row = (id: string) =>
    sql<ModRow>`SELECT * FROM mods WHERE id = ${id}`.pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0] ?? null),
    );
  const stateOf = (r: ModRow) => JSON.parse(r.state) as ModState;
  const saveState = (id: string, state: ModState) =>
    sql`UPDATE mods SET state = ${JSON.stringify(state)} WHERE id = ${id}`.pipe(Effect.orDie);
  const require = (id: string) =>
    row(id).pipe(
      Effect.flatMap((r) =>
        r ? Effect.succeed(r) : Effect.fail(new ModError({ status: 404, message: "That mod isn't installed." })),
      ),
    );

  const changed = Effect.all([
    hub.publish({ type: "page-changes", topic: topics.sites }),
    hub.publish({ type: "mods-changed", topic: topics.mods }),
  ]);
  const youDid = (action: string, mod: Mod, detail: string | null = null) =>
    audit.record({
      actor: "user",
      actorLabel: "You",
      action,
      target: mod.name,
      detail: detail ?? `${mod.id} v${mod.modVersion} by ${mod.author}`,
    });
  const snapshots = (summary: string, theme: boolean) =>
    Effect.all([
      history.record("sites", { actor: "user", actorLabel: "You", summary }),
      theme ? history.record("settings", { actor: "user", actorLabel: "You", summary }) : Effect.void,
    ]);

  /** Sets Rune Browser's theme and tells the renderer. */
  const setTheme = (theme: GlobalTheme) =>
    Effect.gen(function* () {
      const next = { ...(yield* settings.get()), theme };
      yield* settings.save(next);
      yield* hub.publish({ type: "settings", topic: topics.settings, settings: next });
    });

  /** Applies the mod's theme, remembering the one it replaces (unless it's applied already). */
  const applyTheme = (mod: Mod, state: ModState): Effect.Effect<ModState> =>
    Effect.gen(function* () {
      if (!mod.theme) return { ...state, themeApplied: false };
      const current = (yield* settings.get()).theme;
      const previousTheme = state.themeApplied ? state.previousTheme : current;
      if (!sameTheme(current, mod.theme)) yield* setTheme(mod.theme);
      return { ...state, previousTheme, themeApplied: true };
    });

  /** Puts the theme back, unless the user changed it since the mod applied it. */
  const restoreTheme = (mod: Mod, state: ModState): Effect.Effect<ModState> =>
    Effect.gen(function* () {
      if (!state.themeApplied) return state;
      if (state.previousTheme && sameTheme((yield* settings.get()).theme, mod.theme))
        yield* setTheme(state.previousTheme);
      return { extensions: state.extensions, themeApplied: false };
    });

  /** A mod from untrusted JSON, checked like the page changes the agent makes (scripts must parse). */
  const check = (json: unknown) =>
    Effect.gen(function* () {
      if (JSON.stringify(json ?? null).length > MOD_MAX_BYTES)
        return yield* new ModError({ status: 400, message: "The mod is too big." });
      const parsed = parseMod(json);
      if ("error" in parsed) return yield* new ModError({ status: 400, message: parsed.error });
      for (const [i, change] of parsed.mod.pageChanges.entries()) {
        const problem = pageChangeError(change);
        if (problem)
          return yield* new ModError({
            status: 400,
            message: `Page change ${i + 1} (“${change.title}”) is invalid: ${problem}`,
          });
      }
      return parsed.mod;
    });

  const list = sql<ModRow>`SELECT * FROM mods ORDER BY installed_at, id`.pipe(
    Effect.orDie,
    Effect.map((rows) => rows.map(toInstalled)),
  );

  return {
    list,

    check,

    /** What installing it does, and the version installed now, if any. */
    review: (json: unknown) =>
      Effect.gen(function* () {
        const mod = yield* check(json);
        const installed = yield* row(mod.id);
        return {
          mod,
          review: reviewMod(mod) satisfies ModReview,
          installed: installed ? toInstalled(installed) : null,
        };
      }),

    /** Installs a mod, or updates the installed one with the same id. */
    install: (json: unknown, source: string) =>
      Effect.gen(function* () {
        const mod = yield* check(json);
        const existing = yield* row(mod.id);
        let state: ModState = existing ? stateOf(existing) : {};
        if (existing) yield* pageChanges.removeMod(mod.id);
        for (const change of mod.pageChanges) yield* pageChanges.create(change, "user", undefined, mod.id);
        // An update without a theme puts back the one the old version replaced.
        state = mod.theme
          ? yield* applyTheme(mod, state)
          : existing
            ? yield* restoreTheme(JSON.parse(existing.mod) as Mod, state)
            : state;
        yield* sql`INSERT INTO mods (id, mod, enabled, source, state) VALUES (${mod.id}, ${JSON.stringify(mod)}, 1, ${source.slice(0, 500)}, ${JSON.stringify(state)})
          ON CONFLICT (id) DO UPDATE SET mod = excluded.mod, enabled = 1, source = excluded.source, state = excluded.state`.pipe(
          Effect.orDie,
        );
        yield* changed;
        yield* snapshots(`${existing ? "Updated" : "Installed"} the mod ${mod.name}`, !!mod.theme || !!existing);
        yield* youDid(
          existing ? "mod.update" : "mod.install",
          mod,
          `${mod.id} v${mod.modVersion} by ${mod.author}, from ${source.slice(0, 200)}`,
        );
        return toInstalled((yield* row(mod.id))!);
      }),

    setEnabled: (id: string, enabled: boolean) =>
      Effect.gen(function* () {
        const r = yield* require(id);
        const mod = JSON.parse(r.mod) as Mod;
        yield* pageChanges.setModEnabled(id, enabled);
        const state = enabled ? yield* applyTheme(mod, stateOf(r)) : yield* restoreTheme(mod, stateOf(r));
        yield* saveState(id, state);
        yield* sql`UPDATE mods SET enabled = ${enabled ? 1 : 0} WHERE id = ${id}`.pipe(Effect.orDie);
        yield* changed;
        yield* snapshots(`Turned ${enabled ? "on" : "off"} the mod ${mod.name}`, !!mod.theme);
        yield* youDid(enabled ? "mod.enable" : "mod.disable", mod);
        return toInstalled((yield* row(id))!);
      }),

    /** Removes a mod and what it did; returns it as it was (the renderer removes its extensions). */
    remove: (id: string) =>
      Effect.gen(function* () {
        const r = yield* require(id);
        const mod = JSON.parse(r.mod) as Mod;
        yield* restoreTheme(mod, stateOf(r));
        yield* pageChanges.removeMod(id);
        yield* sql`DELETE FROM mods WHERE id = ${id}`.pipe(Effect.orDie);
        yield* changed;
        yield* snapshots(`Removed the mod ${mod.name}`, !!mod.theme);
        yield* youDid("mod.remove", mod);
        return toInstalled(r);
      }),

    /** Records the extensions installing the mod added (the renderer installs them). */
    recordExtensions: (id: string, installed: readonly string[]) =>
      Effect.gen(function* () {
        const r = yield* require(id);
        const mod = JSON.parse(r.mod) as Mod;
        const known = new Set(mod.extensions.map((e) => e.id));
        const state = stateOf(r);
        yield* saveState(id, {
          ...state,
          extensions: [...new Set([...(state.extensions ?? []), ...installed.filter((e) => known.has(e))])],
        });
        yield* hub.publish({ type: "mods-changed", topic: topics.mods });
        return toInstalled((yield* row(id))!);
      }),

    /** A new mod from the user's own page changes, theme and Web Store extensions. */
    package: (input: {
      name: string;
      description: string;
      author: string;
      pageChangeIds: readonly string[];
      theme: boolean;
      extensions: readonly ModExtension[];
    }) =>
      Effect.gen(function* () {
        const all = yield* pageChanges.list();
        const chosen = input.pageChangeIds.map((id) => all.find((c) => c.id === id)).filter((c) => c !== undefined);
        if (chosen.length !== input.pageChangeIds.length)
          return yield* new ModError({ status: 400, message: "Some of those page changes don't exist anymore." });
        const mod = {
          format: "rune-mod",
          version: 1,
          id: newModId(input.name),
          name: input.name,
          description: input.description,
          author: input.author,
          modVersion: "1",
          pageChanges: chosen.map(pageChangeSpec),
          theme: input.theme ? (yield* settings.get()).theme : null,
          extensions: input.extensions,
        };
        return yield* check(mod);
      }),

    /** Rune Browser's example mods and the ones in the user's galleries (Settings → Mods). */
    gallery: Effect.gen(function* () {
      const result: GalleryResult = {
        entries: builtInMods.map((mod) => ({ mod, gallery: "Rune Browser" })),
        errors: [],
      };
      for (const url of (yield* settings.get()).mods.galleries) {
        const listed = yield* fetchJson(url).pipe(
          Effect.map((json) =>
            Array.isArray(json)
              ? json
              : Array.isArray((json as { mods?: unknown })?.mods)
                ? (json as { mods: unknown[] }).mods
                : null,
          ),
          Effect.catch((e: ModError) => Effect.succeed(e.message)),
        );
        if (!Array.isArray(listed)) {
          result.errors.push({ gallery: url, error: typeof listed === "string" ? listed : "It doesn't list mods." });
          continue;
        }
        let invalid = 0;
        for (const item of listed.slice(0, 200)) {
          const parsed = parseMod(item);
          if ("mod" in parsed) result.entries.push({ mod: parsed.mod, gallery: url });
          else invalid++;
        }
        if (invalid) result.errors.push({ gallery: url, error: `${invalid} of its mods are invalid and left out.` });
      }
      return result;
    }),

    /** A mod (or gallery) from a link. */
    fetchJson: (url: string) => fetchJson(url),
  };
});

/** JSON from an https URL (at most MOD_MAX_BYTES, 15 s). */
function fetchJson(url: string) {
  return Effect.tryPromise({
    try: async () => {
      const target = new URL(url);
      if (target.protocol !== "https:") throw new Error("Only https links can be used.");
      const res = await fetch(target, {
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`The link answered HTTP ${res.status}.`);
      const text = await res.text();
      if (text.length > MOD_MAX_BYTES) throw new Error("That's too big for a mod.");
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("The link isn't a mod (not JSON).");
      }
    },
    catch: (err) =>
      new ModError({
        status: 502,
        message:
          err instanceof Error
            ? err.name === "TimeoutError"
              ? "The link didn't answer in time."
              : err.message
            : String(err),
      }),
  });
}

export class Mods extends Context.Service<Mods, Effect.Success<typeof make>>()("rune/Mods") {}

export const layer = Layer.effect(Mods, make);
