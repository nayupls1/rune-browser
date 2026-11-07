// The user's settings, loaded from the server and saved back (debounced) on change.
import { createEffect, createRoot, createSignal } from "solid-js";
import { topics } from "../../shared/hub";
import { searchEngineOf } from "../../shared/browser";
import { defaultSettings, type Settings } from "../../shared/settings";
import { api } from "./api";
import { watchTopic } from "./realtime";
import { applyCachedTheme, applyGlobalTheme, systemDark } from "./theme";

const [settings, setSettingsSignal] = createSignal<Settings>(defaultSettings());
const [settingsLoaded, setSettingsLoaded] = createSignal(false);
export { settings, settingsLoaded };

/** The search engine of the browser settings: its name and URL (%s for the words). */
export const searchEngine = () => searchEngineOf(settings().browser);

// Safe mode leaves the theme out (a broken one could make the UI unusable).
if (!window.rune.safeMode) applyCachedTheme();

createRoot(() => {
  createEffect(() => {
    systemDark(); // re-apply when the OS switches between light and dark
    if (settingsLoaded()) applyGlobalTheme(window.rune.safeMode ? { mode: settings().theme.mode } : settings().theme);
  });
});

export async function loadSettings() {
  try {
    setSettingsSignal(await api.getSettings());
  } finally {
    setSettingsLoaded(true);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

// Settings restored from History.
watchTopic(topics.settings, (msg) => {
  if (msg.type === "settings" && saveTimer === undefined) setSettingsSignal(msg.settings);
});

/** Updates settings immediately in the UI and saves them shortly after. */
export function updateSettings(update: (current: Settings) => Settings) {
  const next = update(structuredClone(settings()));
  setSettingsSignal(next);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    api.saveSettings(next).catch((err) => console.error("Saving settings failed:", err));
  }, 300);
}
