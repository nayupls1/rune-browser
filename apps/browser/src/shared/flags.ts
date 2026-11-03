// rune://flags: a chosen set of Chromium's experimental features (chrome://flags),
// with the same names. The main process applies them as command line switches at
// startup (main/flags.ts), so a change takes effect after a relaunch. Safe mode
// leaves them out, in case one keeps Rune Browser from starting.

export type FlagPlatform = "linux" | "darwin" | "win32";

export interface FlagOption {
  value: string;
  label: string;
  /** Command line switches, with their value if they have one. */
  switches?: [string, string?][];
  enableFeatures?: string[];
  disableFeatures?: string[];
}

export interface Flag {
  /** Chromium's name for it (chrome://flags/#<id>). */
  id: string;
  name: string;
  description: string;
  /** Only on these platforms (all when unset). */
  platforms?: FlagPlatform[];
  /** "default" (Chromium decides) comes first. */
  options: FlagOption[];
}

const DEFAULT: FlagOption = { value: "default", label: "Default" };

/** Default, Enabled, Disabled: a switch each way. */
const toggle = (enable: string, disable: string): FlagOption[] => [
  DEFAULT,
  { value: "enabled", label: "Enabled", switches: [[enable]] },
  { value: "disabled", label: "Disabled", switches: [[disable]] },
];
/** Default, Enabled, Disabled: a Chromium feature. */
const feature = (name: string): FlagOption[] => [
  DEFAULT,
  { value: "enabled", label: "Enabled", enableFeatures: [name] },
  { value: "disabled", label: "Disabled", disableFeatures: [name] },
];

export const flags: Flag[] = [
  {
    id: "ignore-gpu-blocklist",
    name: "Override software rendering list",
    description:
      "Overrides the built-in software rendering list and enables GPU acceleration on unsupported system configurations.",
    options: [DEFAULT, { value: "enabled", label: "Enabled", switches: [["ignore-gpu-blocklist"]] }],
  },
  {
    id: "enable-gpu-rasterization",
    name: "GPU rasterization",
    description: "Use the GPU to rasterize web content.",
    options: toggle("enable-gpu-rasterization", "disable-gpu-rasterization"),
  },
  {
    id: "enable-zero-copy",
    name: "Zero-copy rasterizer",
    description: "Raster threads write directly to GPU memory associated with tiles.",
    options: toggle("enable-zero-copy", "disable-zero-copy"),
  },
  {
    id: "disable-accelerated-video-decode",
    name: "Hardware-accelerated video decode",
    description: "Hardware-accelerated video decode where available.",
    options: [DEFAULT, { value: "disabled", label: "Disabled", switches: [["disable-accelerated-video-decode"]] }],
  },
  {
    id: "smooth-scrolling",
    name: "Smooth Scrolling",
    description: "Animate smoothly when scrolling page content.",
    platforms: ["linux", "win32"],
    options: toggle("enable-smooth-scrolling", "disable-smooth-scrolling"),
  },
  {
    id: "overlay-scrollbars",
    name: "Overlay Scrollbars",
    description: "Thin scrollbars that overlay the page and only show while scrolling.",
    platforms: ["linux", "win32"],
    options: feature("OverlayScrollbar"),
  },
  {
    id: "enable-force-dark",
    name: "Auto Dark Mode for Web Contents",
    description: "Automatically render all web contents using a dark theme.",
    options: feature("WebContentsForceDark"),
  },
  {
    id: "enable-parallel-downloading",
    name: "Parallel downloading",
    description: "Enable parallel downloading to accelerate download speed.",
    options: feature("ParallelDownloading"),
  },
  {
    id: "enable-quic",
    name: "Experimental QUIC protocol",
    description: "Enable experimental QUIC protocol support.",
    options: toggle("enable-quic", "disable-quic"),
  },
  {
    id: "enable-experimental-web-platform-features",
    name: "Experimental Web Platform features",
    description: "Enables experimental Web Platform features that are in development.",
    options: [
      DEFAULT,
      { value: "enabled", label: "Enabled", switches: [["enable-experimental-web-platform-features"]] },
    ],
  },
];

/** What's set, by flag id; flags left at default aren't in it. */
export type FlagState = Record<string, string>;

export const flagsFor = (platform: string) =>
  flags.filter((f) => !f.platforms || f.platforms.includes(platform as FlagPlatform));

/** Keeps the flags and values that exist (for this platform), dropping defaults. */
export function cleanFlagState(value: unknown, platform: string): FlagState {
  const out: FlagState = {};
  if (!value || typeof value !== "object") return out;
  for (const flag of flagsFor(platform)) {
    const chosen = (value as Record<string, unknown>)[flag.id];
    if (typeof chosen === "string" && chosen !== "default" && flag.options.some((o) => o.value === chosen))
      out[flag.id] = chosen;
  }
  return out;
}

export interface FlagSwitches {
  switches: [string, string?][];
  enableFeatures: string[];
  disableFeatures: string[];
}

/** The command line the flags make. */
export function flagSwitches(state: FlagState, platform: string): FlagSwitches {
  const out: FlagSwitches = { switches: [], enableFeatures: [], disableFeatures: [] };
  const clean = cleanFlagState(state, platform);
  for (const flag of flagsFor(platform)) {
    const option = flag.options.find((o) => o.value === clean[flag.id]);
    if (!option) continue;
    out.switches.push(...(option.switches ?? []));
    out.enableFeatures.push(...(option.enableFeatures ?? []));
    out.disableFeatures.push(...(option.disableFeatures ?? []));
  }
  return out;
}

/** rune://flags: the flags, what's set, and what the running Rune Browser started with. */
export interface FlagsInfo {
  state: FlagState;
  /** What was in effect at startup (a change needs a relaunch). */
  applied: FlagState;
  /** Started in safe mode: no flags applied. */
  safeMode: boolean;
}
