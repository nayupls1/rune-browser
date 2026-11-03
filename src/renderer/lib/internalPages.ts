// rune:// (and chrome://) addresses typed in the address bar or the command bar
// open Rune Browser's internal pages (shared/internalPages.ts), which are shown in
// Settings; the address bar shows them as rune:// addresses.
import { internalUrlOf, parseInternalUrl, settingsCategoryOf, URLS_VIEW } from "../../shared/internalPages";
import { toast } from "../components/Toast";
import { settingsSections } from "./settingsSections";
import { newWebTab, openSettings, selectApp, SETTINGS_VIEW, settingsSection } from "./store";

const categories = () => settingsSections.filter((s) => !s.view).map((s) => s.id);

/** Opens the internal page an address names; false if it isn't an internal address. */
export function openInternalPage(input: string): boolean {
  const parsed = parseInternalUrl(input);
  if (!parsed) return false;
  const target = parsed.page?.target;
  if (!target) {
    toast({ message: `${parsed.url} isn't a page in Rune Browser. These are.`, kind: "error" });
    void selectApp(URLS_VIEW);
  } else if ("newTab" in target) void newWebTab();
  else if ("view" in target) void selectApp(target.view);
  else {
    const category = settingsCategoryOf(parsed.path, categories()) || target.settings;
    void openSettings(category || undefined);
  }
  return true;
}

/** The rune:// address of a page shown in Settings (`view`: its pseudo tab id). */
export function internalUrlOfView(view: string) {
  if (view !== SETTINGS_VIEW) return internalUrlOf({ view });
  return internalUrlOf({ settings: settingsSection() });
}
