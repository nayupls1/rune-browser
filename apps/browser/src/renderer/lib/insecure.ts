// Which http:// pages web tabs open without a warning (shared/insecure.ts): the
// switch and the sites allowed in Settings, and the sites allowed until Rune
// Browser restarts ("Continue to site"). The main process gets the same policy
// for what pages navigate to themselves (main/web.ts).
import { createEffect, createRoot, createSignal } from "solid-js";
import type { InsecurePolicy } from "../../shared/insecure";
import { settings, settingsLoaded, updateSettings } from "./settings";

const [sessionAllowed, setSessionAllowed] = createSignal<string[]>([]);

export const insecurePolicy = (): InsecurePolicy => ({
  enabled: settings().web.warnInsecure,
  allowed: [...settings().web.insecureAllowed, ...sessionAllowed()],
});

const push = () => window.rune.web.setInsecurePolicy(insecurePolicy());

/** Opens `host` over HTTP from now on: until Rune Browser restarts, or for good (listed in Settings → Web tabs). */
export function allowInsecure(host: string, always: boolean) {
  if (!host) return;
  // A private window doesn't remember the site: it's allowed until Rune Browser restarts.
  if (always && !window.rune.window.private) {
    updateSettings((s) => ({
      ...s,
      web: { ...s.web, insecureAllowed: [...new Set([...s.web.insecureAllowed, host])] },
    }));
  } else if (!sessionAllowed().includes(host)) {
    setSessionAllowed((hosts) => [...hosts, host]);
  }
  // Before the tab loads the page, so the main process lets its redirects through.
  push();
}

/** Warns about `host` again (Settings → Web tabs). */
export function disallowInsecure(host: string) {
  setSessionAllowed((hosts) => hosts.filter((h) => h !== host));
  updateSettings((s) => ({
    ...s,
    web: { ...s.web, insecureAllowed: s.web.insecureAllowed.filter((h) => h !== host) },
  }));
  push();
}

createRoot(() => {
  createEffect(() => {
    if (settingsLoaded()) push();
  });
});
