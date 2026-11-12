// User settings (Settings tab). Decoding fills in defaults for anything unset,
// so older saved settings keep working when options are added.
import { Effect, Schema } from "effect";
import { providerIds } from "./api";
import { BrowserSettings } from "./browser";

const withDefault = <S extends Schema.Top>(value: S["Encoded"]) =>
  Schema.withDecodingDefaultKey<S>(Effect.succeed(value));

export const HexColor = Schema.String.check(
  Schema.isPattern(/^#[0-9a-fA-F]{6}$/, { message: 'must be a hex color like "#c2461f"' }),
);

export const Radius = Schema.Literals(["none", "sm", "md", "lg"]);
export type Radius = typeof Radius.Type;
export const FontStyle = Schema.Literals(["sans", "serif", "mono", "rounded"]);
export type FontStyle = typeof FontStyle.Type;

/** Visual theme. Unset fields fall back to the base palette of the mode. */
const themeFields = {
  accent: Schema.optionalKey(HexColor),
  background: Schema.optionalKey(HexColor),
  surface: Schema.optionalKey(HexColor),
  text: Schema.optionalKey(HexColor),
  radius: Schema.optionalKey(Radius),
  font: Schema.optionalKey(FontStyle),
};

export const Theme = Schema.Struct({ mode: Schema.optionalKey(Schema.Literals(["light", "dark"])), ...themeFields });
export type Theme = typeof Theme.Type;

export const GlobalTheme = Schema.Struct({
  mode: Schema.Literals(["system", "light", "dark"]).pipe(withDefault("system")),
  ...themeFields,
});
export type GlobalTheme = typeof GlobalTheme.Type;

const ProviderSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(withDefault(true)),
  /** Path to the CLI; empty to find it on PATH (Claude: the bundled one). */
  binaryPath: Schema.String.check(Schema.isMaxLength(4000)).pipe(withDefault("")),
});
export type ProviderSettings = typeof ProviderSettings.Type;

/** Hours a tab may go unused before tab cleanup closes it (0: never). */
const CloseAfterHours = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 * 365 }));
/** What Settings offer (other values, set by hand, are shown as they are). */
export const CLOSE_AFTER_CHOICES = [0, 12, 24, 72, 168] as const;

const Instructions = Schema.String.check(Schema.isMaxLength(10_000)).pipe(withDefault(""));

export const Settings = Schema.Struct({
  theme: GlobalTheme.pipe(withDefault({})),
  agent: Schema.Struct({
    /** Defaults for new tabs. */
    provider: Schema.Literals(providerIds).pipe(withDefault("claude")),
    /** null = the provider's default. */
    model: Schema.NullOr(Schema.String).pipe(withDefault(null)),
    effort: Schema.NullOr(Schema.String).pipe(withDefault(null)),
    /** Appended to the website agent's system prompt. */
    webInstructions: Instructions,
    /** Show tool activity ("Customized example.com") in the chat. */
    showToolMessages: Schema.Boolean.pipe(withDefault(true)),
    /** ask: agents ask before anything beyond their tab (customizing sites, acting on sites, reading other tabs…). full: they don't; it's still logged. */
    permissions: Schema.Literals(["ask", "full"]).pipe(withDefault("ask")),
  }).pipe(withDefault({})),
  providers: Schema.Struct({
    claude: ProviderSettings.pipe(withDefault({})),
    codex: ProviderSettings.pipe(withDefault({})),
    opencode: ProviderSettings.pipe(withDefault({})),
  }).pipe(withDefault({})),
  /** What a browser lets you set (Settings' Browser group): search, startup, privacy, site settings, fonts… */
  browser: BrowserSettings.pipe(withDefault({})),
  web: Schema.Struct({
    /** Apply site customizations (CSS/JS overrides) in web tabs. */
    overrides: Schema.Boolean.pipe(withDefault(true)),
    /** Keep web tabs' recent network traffic (in memory, bounded) for the Network panel and the website agent. */
    recordNetwork: Schema.Boolean.pipe(withDefault(true)),
    /** Learn the APIs sites call (shapes only, never values) into the API map. Needs recordNetwork. */
    apiMap: Schema.Boolean.pipe(withDefault(true)),
    /** Sites the API map leaves out (a host covers its subdomains). */
    apiMapOff: Schema.Array(Schema.String.check(Schema.isMaxLength(253)))
      .check(Schema.isMaxLength(500))
      .pipe(withDefault([])),
    /** Open http:// pages over HTTPS when they can be, and warn before showing them unencrypted (shared/insecure.ts). */
    warnInsecure: Schema.Boolean.pipe(withDefault(true)),
    /** Hosts the user allowed over HTTP, without a warning. */
    insecureAllowed: Schema.Array(Schema.String.check(Schema.isMaxLength(253)))
      .check(Schema.isMaxLength(1000))
      .pipe(withDefault([])),
  }).pipe(withDefault({})),
  tabs: Schema.Struct({
    /**
     * Where the tabs are: a horizontal tab bar at the top, like Chrome's (the default), or the
     * vertical sidebar. Existing profiles keep the vertical sidebar (db/Db.ts).
     */
    layout: Schema.Literals(["horizontal", "vertical"]).pipe(withDefault("horizontal")),
    /** Tabs not used for this many minutes are unloaded (their page closes, its state is kept); 0 = never. */
    unloadAfterMinutes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 * 60 })).pipe(withDefault(30)),
    /** Tabs not used for this many hours are closed (tab cleanup: lib/cleanup.ts); 0 = never. Workspaces can set their own. */
    closeAfterHours: CloseAfterHours.pipe(withDefault(0)),
  }).pipe(withDefault({})),
  /** Changed keyboard shortcuts, by action ("tab.close" → ["Ctrl+W"]); [] turns one off. The rest keep their defaults. */
  shortcuts: Schema.Record(
    Schema.String.check(Schema.isMaxLength(100)),
    Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(Schema.isMaxLength(10)),
  ).pipe(withDefault({})),
  /**
   * First-run setup (components/Onboarding.tsx): pending shows it. New profiles are written pending (db/Db.ts);
   * profiles from before it count as set up. "Run setup again" in Settings → About makes it pending again.
   */
  onboarding: Schema.Literals(["pending", "completed", "skipped"]).pipe(withDefault("completed")),
  mods: Schema.Struct({
    /** Galleries to browse mods from: URLs of JSON files listing mods ({ "mods": [...] } or an array). */
    galleries: Schema.Array(Schema.String.check(Schema.isMaxLength(2000)))
      .check(Schema.isMaxLength(20))
      .pipe(withDefault([])),
  }).pipe(withDefault({})),
});
export type Settings = typeof Settings.Type;

export const decodeSettings = Schema.decodeUnknownSync(Settings);

/** A workspace's own settings, on top of the global ones. */
export const WorkspaceSettings = Schema.Struct({
  /** Default agent for new tabs in the workspace; null = the global default. */
  agent: Schema.NullOr(
    Schema.Struct({
      provider: Schema.Literals(providerIds),
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
    }),
  ).pipe(withDefault(null)),
  /** Tab cleanup in this workspace: hours unused before a tab closes (0: never); null = the global setting. */
  closeAfterHours: Schema.NullOr(CloseAfterHours).pipe(withDefault(null)),
  /** Added after the global instructions in the workspace's tabs. */
  webInstructions: Instructions,
});
export type WorkspaceSettings = typeof WorkspaceSettings.Type;

export const decodeWorkspaceSettings = Schema.decodeUnknownSync(WorkspaceSettings);

export const defaultSettings = (): Settings => decodeSettings({});
