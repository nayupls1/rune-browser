// First-run setup (components/Onboarding.tsx): its steps, when it shows, and the other
// browsers on this computer to bring things over from, with what each has.
import type { BookmarkSource } from "./bookmarks";
import type { ImportedBrowserSettings } from "./browser";
import type { BrowserProfile } from "./extensions";
import type { Settings } from "./settings";

export type OnboardingStep = "import" | "layout" | "default" | "push" | "agent";

/**
 * Notifications from closed tabs (web push through ntfy.sh) aren't in Rune yet: the step is built but left out.
 * TODO(push): once the push setting lands (`browser.push: { service: "ntfy" | "custom" | "off", server?: string }` in
 * shared/browser.ts), drop this flag, show the step and save its choice there.
 */
export const PUSH_STEP = false;

/** The steps, in order. */
export const onboardingSteps = (push = PUSH_STEP): OnboardingStep[] =>
  push ? ["import", "layout", "default", "push", "agent"] : ["import", "layout", "default", "agent"];

/** Whether a window shows the setup: while it's pending, never in a private window or in safe mode. */
export const showsOnboarding = (
  settings: Pick<Settings, "onboarding">,
  window: { private: boolean; safeMode: boolean },
) => settings.onboarding === "pending" && !window.private && !window.safeMode;

/** A browser profile to import from, with what it has of each kind (each found on its own: main and the server). */
export interface ImportProfile {
  /** Its browser and profile, the same in every kind. */
  id: string;
  browser: string;
  profile: string;
  bookmarks?: BookmarkSource;
  settings?: { key: string; found: ImportedBrowserSettings };
  extensions?: BrowserProfile;
}

/** The extensions of a profile Import offers: those turned on there that aren't the browser's own or here already. */
export const importableExtensions = (profile: BrowserProfile | undefined) =>
  (profile?.extensions ?? []).filter((e) => e.enabledThere && !e.byDefault && !e.installed);

/** Whether a settings profile has anything to bring. */
const hasSettings = (found: ImportedBrowserSettings) => Object.values(found).some((v) => v !== undefined);

/**
 * The profiles of other browsers, one each, with their bookmarks, settings and extensions put together by browser
 * and profile name. Profiles with nothing to bring are left out; the one with the most comes first.
 */
export function groupImportProfiles(
  bookmarks: readonly BookmarkSource[],
  settings: readonly { key: string; browser: string; profile: string; found: ImportedBrowserSettings }[],
  extensions: readonly BrowserProfile[],
): ImportProfile[] {
  const byId = new Map<string, ImportProfile>();
  const entry = (browser: string, profile: string) => {
    const id = `${browser}\u0000${profile}`;
    let found = byId.get(id);
    if (!found) byId.set(id, (found = { id, browser, profile }));
    return found;
  };
  for (const b of bookmarks) if (b.count > 0) entry(b.browser, b.profile).bookmarks = b;
  for (const s of settings)
    if (hasSettings(s.found)) entry(s.browser, s.profile).settings = { key: s.key, found: s.found };
  for (const e of extensions) if (importableExtensions(e).length) entry(e.browser, e.profile).extensions = e;
  const weight = (p: ImportProfile) =>
    (p.bookmarks?.count ?? 0) + importableExtensions(p.extensions).length * 5 + (p.settings ? 1 : 0);
  return [...byId.values()].sort((a, b) => weight(b) - weight(a));
}
