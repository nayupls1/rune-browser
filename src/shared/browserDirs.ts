// Where other browsers keep their data on this computer: Chromium-based ones
// (a user data folder with "Local State" and the profiles) and Firefox-based
// ones (a folder with profiles.ini). Node only: the main process imports
// extensions from these, the server bookmarks.
import { homedir } from "node:os";
import { join } from "node:path";

/** A browser's user data folder (the one with "Local State" and the profiles). */
export interface BrowserDir {
  browser: string;
  dir: string;
}

/** Where Chromium-based browsers keep their data, per platform. RUNE_BROWSER_DIRS ("Name=/path;…") replaces the list (tests). */
export function browserDirs(): BrowserDir[] {
  const override = process.env.RUNE_BROWSER_DIRS;
  if (override !== undefined) {
    return override
      .split(";")
      .filter(Boolean)
      .map((pair) => ({ browser: pair.slice(0, pair.indexOf("=")), dir: pair.slice(pair.indexOf("=") + 1) }));
  }
  const home = homedir();
  const list: [string, string][] = [];
  if (process.platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    list.push(
      ["Google Chrome", join(base, "Google", "Chrome")],
      ["Chrome Beta", join(base, "Google", "Chrome Beta")],
      ["Chrome Canary", join(base, "Google", "Chrome Canary")],
      ["Chromium", join(base, "Chromium")],
      ["Brave", join(base, "BraveSoftware", "Brave-Browser")],
      ["Microsoft Edge", join(base, "Microsoft Edge")],
      ["Vivaldi", join(base, "Vivaldi")],
      ["Arc", join(base, "Arc", "User Data")],
    );
  } else if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    list.push(
      ["Google Chrome", join(base, "Google", "Chrome", "User Data")],
      ["Chrome Beta", join(base, "Google", "Chrome Beta", "User Data")],
      ["Chrome Canary", join(base, "Google", "Chrome SxS", "User Data")],
      ["Chromium", join(base, "Chromium", "User Data")],
      ["Brave", join(base, "BraveSoftware", "Brave-Browser", "User Data")],
      ["Microsoft Edge", join(base, "Microsoft", "Edge", "User Data")],
      ["Vivaldi", join(base, "Vivaldi", "User Data")],
    );
  } else {
    const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    const flatpak = (appId: string, path: string) => join(home, ".var", "app", appId, "config", path);
    list.push(
      ["Google Chrome", join(config, "google-chrome")],
      ["Chrome Beta", join(config, "google-chrome-beta")],
      ["Chrome Dev", join(config, "google-chrome-unstable")],
      ["Chromium", join(config, "chromium")],
      ["Brave", join(config, "BraveSoftware", "Brave-Browser")],
      ["Brave Beta", join(config, "BraveSoftware", "Brave-Browser-Beta")],
      ["Brave Nightly", join(config, "BraveSoftware", "Brave-Browser-Nightly")],
      ["Microsoft Edge", join(config, "microsoft-edge")],
      ["Edge Beta", join(config, "microsoft-edge-beta")],
      ["Edge Dev", join(config, "microsoft-edge-dev")],
      ["Vivaldi", join(config, "vivaldi")],
      ["Thorium", join(config, "thorium")],
      ["Google Chrome (Flatpak)", flatpak("com.google.Chrome", "google-chrome")],
      ["Chromium (Flatpak)", flatpak("org.chromium.Chromium", "chromium")],
      ["Brave (Flatpak)", flatpak("com.brave.Browser", join("BraveSoftware", "Brave-Browser"))],
      ["Microsoft Edge (Flatpak)", flatpak("com.microsoft.Edge", "microsoft-edge")],
      ["Vivaldi (Flatpak)", flatpak("com.vivaldi.Vivaldi", "vivaldi")],
      ["Chromium (Snap)", join(home, "snap", "chromium", "common", "chromium")],
    );
  }
  return list.map(([browser, dir]) => ({ browser, dir }));
}

/** Where Firefox and browsers built on it keep their profiles (profiles.ini). RUNE_FIREFOX_DIRS ("Name=/path;…") replaces the list (tests). */
export function firefoxDirs(): BrowserDir[] {
  const override = process.env.RUNE_FIREFOX_DIRS;
  if (override !== undefined) {
    return override
      .split(";")
      .filter(Boolean)
      .map((pair) => ({ browser: pair.slice(0, pair.indexOf("=")), dir: pair.slice(pair.indexOf("=") + 1) }));
  }
  const home = homedir();
  const list: [string, string][] = [];
  if (process.platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    list.push(
      ["Firefox", join(base, "Firefox")],
      ["Zen", join(base, "zen")],
      ["LibreWolf", join(base, "librewolf")],
      ["Floorp", join(base, "Floorp")],
      ["Waterfox", join(base, "Waterfox")],
    );
  } else if (process.platform === "win32") {
    const base = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    list.push(
      ["Firefox", join(base, "Mozilla", "Firefox")],
      ["Zen", join(base, "zen")],
      ["LibreWolf", join(base, "librewolf")],
      ["Floorp", join(base, "Floorp")],
      ["Waterfox", join(base, "Waterfox")],
    );
  } else {
    const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    const flatpak = (appId: string, path: string) => join(home, ".var", "app", appId, path);
    list.push(
      ["Firefox", join(home, ".mozilla", "firefox")],
      ["Firefox", join(config, "mozilla", "firefox")],
      ["Firefox (Snap)", join(home, "snap", "firefox", "common", ".mozilla", "firefox")],
      ["Firefox (Flatpak)", flatpak("org.mozilla.firefox", join(".mozilla", "firefox"))],
      ["Firefox (Flatpak)", flatpak("org.mozilla.firefox", join("config", "mozilla", "firefox"))],
      ["Zen", join(home, ".zen")],
      ["Zen", join(config, "zen")],
      ["Zen (Flatpak)", flatpak("app.zen_browser.zen", ".zen")],
      ["LibreWolf", join(home, ".librewolf")],
      ["LibreWolf", join(config, "librewolf", "librewolf")],
      ["LibreWolf (Flatpak)", flatpak("io.gitlab.librewolf-community", ".librewolf")],
      ["Floorp", join(home, ".floorp")],
      ["Waterfox", join(home, ".waterfox")],
    );
  }
  return list.map(([browser, dir]) => ({ browser, dir }));
}
