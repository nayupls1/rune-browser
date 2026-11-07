import { app } from "electron";

/**
 * Electron's own user agent, without Rune Browser's name: what Google's sign-in
 * gets (see `signInRule`), since it turns away a Chrome it can tell isn't one.
 * Read once, before `useChromeUserAgent` replaces the app's.
 */
export const signInUserAgent = app.userAgentFallback.replace(/ RuneBrowser\/\S+/gi, "");

/** A plain Chrome user agent: some sites turn away unknown browsers. */
export const chromeUserAgent = signInUserAgent.replace(/ Electron\/\S+/gi, "");

/**
 * Makes plain Chrome the user agent of everything, not only web sessions:
 * service workers (extensions' background workers, sites' workers) don't get a
 * session's `setUserAgent`, only the app's. LastPass's worker, seeing Electron,
 * took its desktop-app path and failed on `document`.
 */
export function useChromeUserAgent() {
  app.userAgentFallback = chromeUserAgent;
}
