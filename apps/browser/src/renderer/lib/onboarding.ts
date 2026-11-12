// First-run setup (components/Onboarding.tsx): whether this window shows it, and ending or starting it again.
import { showsOnboarding } from "../../shared/onboarding";
import { settings, settingsLoaded, updateSettings } from "./settings";

/** This window shows the setup now (a new profile, or "Run setup again"); never private windows or safe mode. */
export const onboardingShown = () =>
  settingsLoaded() &&
  showsOnboarding(settings(), { private: window.rune.window.private, safeMode: window.rune.safeMode });

/** Ends it: walked through (completed) or skipped. It doesn't come back unless asked to. */
export const finishOnboarding = (how: "completed" | "skipped") => updateSettings((s) => ({ ...s, onboarding: how }));

/** Settings → About → "Run setup again". */
export const runSetupAgain = () => updateSettings((s) => ({ ...s, onboarding: "pending" }));
