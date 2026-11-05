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

const Instructions = Schema.String.check(Schema.isMaxLength(10_000)).pipe(withDefault(""));

export const Settings = Schema.Struct({
  theme: GlobalTheme.pipe(withDefault({})),
  agent: Schema.Struct({
    /** Defaults for new tabs. */
    provider: Schema.Literals(providerIds).pipe(withDefault("claude")),
    /** null = the provider's default. */
    model: Schema.NullOr(Schema.String).pipe(withDefault(null)),
    effort: Schema.NullOr(Schema.String).pipe(withDefault(null)),
    /** Appended to the app builder's system prompt. */
    instructions: Instructions,
    /** Appended to the website agent's system prompt. */
    webInstructions: Instructions,
    /** Show tool activity ("Edited src/App.tsx") in the chat. */
    showToolMessages: Schema.Boolean.pipe(withDefault(true)),
    /** ask: agents ask before anything beyond their tab (customizing sites, other apps, schedules, acting on sites…). full: they don't; it's still logged. */
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
    /** Tabs not used for this many minutes are unloaded (their page closes, its state is kept); 0 = never. */
    unloadAfterMinutes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 24 * 60 })).pipe(withDefault(30)),
  }).pipe(withDefault({})),
  /** Changed keyboard shortcuts, by action ("tab.close" → ["Ctrl+W"]); [] turns one off. The rest keep their defaults. */
  shortcuts: Schema.Record(
    Schema.String.check(Schema.isMaxLength(100)),
    Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(Schema.isMaxLength(10)),
  ).pipe(withDefault({})),
  mods: Schema.Struct({
    /** Galleries to browse mods from: URLs of JSON files listing mods ({ "mods": [...] } or an array). */
    galleries: Schema.Array(Schema.String.check(Schema.isMaxLength(2000)))
      .check(Schema.isMaxLength(20))
      .pipe(withDefault([])),
  }).pipe(withDefault({})),
  apps: Schema.Struct({
    /** How app processes are isolated. auto: bubblewrap when it's installed. */
    sandbox: Schema.Literals(["auto", "bwrap", "none"]).pipe(withDefault("auto")),
    /** The shell app commands run in: "auto" (sh; Bun's shell on Windows), "bun", a detected shell's id or a path. */
    shell: Schema.String.check(Schema.isMaxLength(1000)).pipe(withDefault("auto")),
    /** Show the toolchains installed in your home folder (mise, nvm, rustup…) to the sandbox, read-only. */
    sandboxToolchains: Schema.Boolean.pipe(withDefault(true)),
    /** More folders the sandbox may read (absolute paths). */
    sandboxReadOnly: Schema.Array(Schema.String.check(Schema.isMaxLength(4000)))
      .check(Schema.isMaxLength(50))
      .pipe(withDefault([])),
    /** Start an app's server when its tab is opened. */
    autoStart: Schema.Boolean.pipe(withDefault(true)),
    /** Build and switch to the finished app when the agent is done. */
    autoPublish: Schema.Boolean.pipe(withDefault(false)),
    /** AI for apps: their servers can ask a model through Rune Browser, on the user's own subscription. */
    ai: Schema.Struct({
      enabled: Schema.Boolean.pipe(withDefault(true)),
      provider: Schema.Literals(providerIds).pipe(withDefault("claude")),
      /** null = the provider's default. */
      model: Schema.NullOr(Schema.String).pipe(withDefault(null)),
      effort: Schema.NullOr(Schema.String).pipe(withDefault(null)),
      /** Requests per app and day. */
      dailyLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })).pipe(withDefault(200)),
    }).pipe(withDefault({})),
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
  /** Added after the global instructions in the workspace's tabs. */
  instructions: Instructions,
  webInstructions: Instructions,
});
export type WorkspaceSettings = typeof WorkspaceSettings.Type;

export const decodeWorkspaceSettings = Schema.decodeUnknownSync(WorkspaceSettings);

export const defaultSettings = (): Settings => decodeSettings({});
