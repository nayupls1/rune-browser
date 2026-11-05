// Settings' Browser group: what a browser like Chrome lets you set, named and
// grouped the way Chrome does (privacy and security, site settings, search
// engine, on startup, fonts and zoom, languages, downloads, performance,
// passwords, import, reset), apart from Rune Browser's own settings.
// The main process puts them into effect in web tabs (main/browser.ts).
import * as stylex from "@stylexjs/stylex";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import {
  applyImport,
  defaultBrowserSettings,
  describeImport,
  importParts,
  inheritedLabel,
  isSearchUrl,
  searchEngineOf,
  searchEngines,
  siteSettingKeys,
  siteSettings,
  type BrowserSettings,
  type ImportedBrowserSettings,
  type ImportPart,
  type SiteDecision,
  type SiteSettingKey,
} from "../../shared/browser";
import { clearRanges } from "../../shared/visits";
import { api } from "../lib/api";
import { setSiteSetting, siteShown, showSite, updateBrowser } from "../lib/browser";
import { ZOOM_FACTORS } from "../lib/pageTools";
import { settings, updateSettings } from "../lib/settings";
import { apps, currentWorkspace, newWebTab, openSettings, workspaces } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { openExtensionImport } from "./ExtensionImport";
import { openBookmarkImport } from "./BookmarksPage";
import { Icon } from "./Icon";
import { DefaultBrowserRow, InsecureRows, Row, Section, Segmented, Toggle, unloadChoices } from "./SettingsPage";
import { toast } from "./Toast";
import { Button, Checkbox, Input, Select } from "./ui";

const browser = () => settings().browser;
const setPart = <K extends keyof BrowserSettings>(key: K, value: Partial<BrowserSettings[K]>) =>
  updateBrowser((b) => ({ ...b, [key]: { ...b[key], ...value } }));

const percent = (factor: number) => `${Math.round(factor * 100)}%`;
/** The choices with the current value among them (one imported from another browser may not be). */
const withCurrent = (choices: readonly number[], current: number | undefined) =>
  current === undefined || choices.includes(current) ? [...choices] : [...choices, current].sort((a, b) => a - b);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The main process's view of the system: languages, dictionaries, the Downloads folder. */
const systemInfo = () => createResource(() => window.rune.browser.info())[0];

// --- Privacy and security -----------------------------------------------------------------------

export function PrivacySection() {
  const [history, setHistory] = createSignal(true);
  const [range, setRange] = createSignal<(typeof clearRanges)[number]["id"]>("all");
  const [cookies, setCookies] = createSignal(true);
  const [cache, setCache] = createSignal(true);
  const [everywhere, setEverywhere] = createSignal<"this" | "all">("this");
  const [clearing, setClearing] = createSignal(false);
  const nothing = () => !history() && !cookies() && !cache();
  const clear = async () => {
    const all = everywhere() === "all";
    const period = clearRanges.find((r) => r.id === range())!;
    const what = [
      history() ? `browsing history (${period.label.toLowerCase()})` : null,
      cookies() ? "cookies and other site data" : null,
      cache() ? "cached images and files" : null,
    ]
      .filter(Boolean)
      .join(", ")
      .replace(/, ([^,]*)$/, " and $1");
    const where = all ? "every workspace" : `the workspace ${currentWorkspace()?.name ?? ""}`.trim();
    if (!(await confirmDialog(`Clear ${what} of ${where}?`, { confirmLabel: "Clear data", danger: true }))) return;
    setClearing(true);
    try {
      const ids = all ? workspaces.map((w) => w.id) : [currentWorkspace()!.id];
      if (history())
        await api.clearVisits(
          all ? null : ids[0]!,
          period.ms === null ? null : new Date(Date.now() - period.ms).toISOString(),
        );
      if (cookies() || cache()) await window.rune.browser.clearData(ids, { cookies: cookies(), cache: cache() });
      toast({ message: "Browsing data cleared", kind: "success" });
    } catch (err) {
      toast({ title: "Clearing browsing data failed", message: String(err), kind: "error" });
    } finally {
      setClearing(false);
    }
  };
  return (
    <>
      <Section title="Clear browsing data" anchor="browser-clear">
        <Row
          label="Browsing history"
          description="The pages you visited: History and the address bar's suggestions."
          leading
        >
          <Checkbox checked={history()} onChange={(e) => setHistory(e.currentTarget.checked)} data-clear-history />
        </Row>
        <Row
          label="Cookies and other site data"
          description="Signs you out of most sites. Extensions keep their data."
          leading
        >
          <Checkbox checked={cookies()} onChange={(e) => setCookies(e.currentTarget.checked)} data-clear-cookies />
        </Row>
        <Row
          label="Cached images and files"
          description="Frees space; some sites load more slowly the next time."
          leading
        >
          <Checkbox checked={cache()} onChange={(e) => setCache(e.currentTarget.checked)} data-clear-cache />
        </Row>
        <Row label="Time range" description="History only. Cookies and cached files are always cleared in full.">
          <Select
            value={range()}
            onChange={(e) => setRange(e.currentTarget.value as (typeof clearRanges)[number]["id"])}
            xstyle={styles.select}
            data-clear-range
          >
            <For each={clearRanges}>{(r) => <option value={r.id}>{r.label}</option>}</For>
          </Select>
        </Row>
        <Row label="Apply to" description="Each workspace has its own history, cookies and logins.">
          <Segmented
            value={everywhere()}
            options={[
              ["this", "This workspace"],
              ["all", "All workspaces"],
            ]}
            onChange={setEverywhere}
          />
        </Row>
        <Row label="Clear the checked items" description="This can't be undone." always footer>
          <Button variant="danger" disabled={clearing() || nothing()} onClick={() => void clear()} data-clear-data>
            {clearing() ? "Clearing…" : "Clear now"}
          </Button>
        </Row>
      </Section>
      <Section title="Security" anchor="browser-security">
        <InsecureRows />
      </Section>
      <Section title="Cookies and tracking" anchor="browser-cookies">
        <Row
          label="Block third-party cookies"
          description="Keeps sites from following you through what other sites embed (ads, widgets). Some sign-ins and embedded content may stop working."
        >
          <span data-third-party-cookies>
            <Toggle
              checked={browser().privacy.thirdPartyCookies === "block"}
              onChange={(block) => setPart("privacy", { thirdPartyCookies: block ? "block" : "allow" })}
            />
          </span>
        </Row>
        <Row label='Send a "Do Not Track" request' description="Asks sites not to track you. Many sites ignore it.">
          <div data-do-not-track>
            <Toggle
              checked={browser().privacy.doNotTrack}
              onChange={(doNotTrack) => setPart("privacy", { doNotTrack })}
            />
          </div>
        </Row>
        <Row
          label="Site settings"
          description="What sites may use and do: location, camera, microphone, notifications, JavaScript, images, sound."
        >
          <Button onClick={() => void openSettings("browser-sites")}>
            Open <Icon name="chevron-right" size={14} />
          </Button>
        </Row>
      </Section>
    </>
  );
}

// --- Site settings ------------------------------------------------------------------------------

const defaultLabels: Record<string, string> = { ask: "Sites can ask", allow: "Allowed", block: "Don't allow" };

/** A site's own choice for a setting: the default, allow or block. */
function DecisionSelect(props: { site: string; setting: SiteSettingKey; compact?: boolean }) {
  const own = () => browser().sites[props.site]?.[props.setting] ?? "";
  return (
    <Select
      value={own()}
      onChange={(e) => setSiteSetting(props.site, props.setting, (e.currentTarget.value || undefined) as SiteDecision)}
      xstyle={props.compact ? styles.compactSelect : styles.select}
      data-site-setting={props.setting}
    >
      <option value="">{inheritedLabel(browser(), props.site, props.setting)}</option>
      {/* Screen sharing always asks, with its picker. */}
      <Show when={props.setting !== "screen"}>
        <option value="allow">Allow</option>
      </Show>
      <option value="block">Block</option>
    </Select>
  );
}

/** What a site's own settings change, in a few words. */
function siteSummary(site: string, cookies: number | undefined) {
  const own = browser().sites[site] ?? {};
  const parts = siteSettingKeys
    .filter((k) => own[k])
    .map((k) => `${siteSettings[k].label} ${own[k] === "allow" ? "allowed" : "blocked"}`);
  const zoom = browser().zoom.sites[site];
  if (zoom) parts.push(`Zoom ${percent(zoom)}`);
  if (cookies) parts.push(plural(cookies, "cookie"));
  return parts.join(" · ");
}

export function SiteSettingsSection() {
  // Back to all sites when you leave.
  onCleanup(() => showSite(null));
  return (
    <Show when={siteShown()} fallback={<SiteSettingsOverview />} keyed>
      {(site) => <SiteDetails site={site} />}
    </Show>
  );
}

function SiteSettingsOverview() {
  const [data] = createResource(
    () => currentWorkspace()?.id,
    (id) => window.rune.browser.siteData(id),
  );
  const [filter, setFilter] = createSignal("");
  const sites = createMemo(() => {
    const counts = new Map((data() ?? []).map((d) => [d.site, d.cookies]));
    const all = new Set([...Object.keys(browser().sites), ...Object.keys(browser().zoom.sites), ...counts.keys()]);
    const q = filter().trim().toLowerCase();
    return [...all]
      .filter((s) => !q || s.includes(q))
      .sort((a, b) => a.localeCompare(b))
      .map((site) => ({ site, summary: siteSummary(site, counts.get(site)) }));
  });
  const defaultsOf = (kind: "permission" | "content") => siteSettingKeys.filter((k) => siteSettings[k].kind === kind);
  return (
    <>
      <Section
        title="Permissions"
        anchor="browser-permissions"
        description="Sites ask the first time they need one of these. Change your answer here or from the address bar."
      >
        <For each={defaultsOf("permission")}>{(key) => <DefaultRow setting={key} />}</For>
      </Section>
      <Section title="Content" anchor="browser-content">
        <For each={defaultsOf("content")}>{(key) => <DefaultRow setting={key} />}</For>
      </Section>
      <Section title="All sites" anchor="browser-all-sites">
        <Row
          label="Sites with their own settings or data"
          description={`Cookies are those of the workspace ${currentWorkspace()?.name ?? ""}.`}
          wide
        >
          <Input
            value={filter()}
            placeholder="Search sites"
            onInput={(e) => setFilter(e.currentTarget.value)}
            data-site-filter
          />
          <div {...stylex.attrs(styles.siteList)}>
            <For each={sites()}>
              {(s) => (
                <button
                  type="button"
                  onClick={() => showSite(s.site)}
                  {...stylex.attrs(styles.siteRow)}
                  data-site-row={s.site}
                >
                  <span {...stylex.attrs(styles.siteName)}>{s.site}</span>
                  <span {...stylex.attrs(styles.siteSummary)}>{s.summary}</span>
                  <Icon name="chevron-right" size={14} {...stylex.attrs(styles.muted)} />
                </button>
              )}
            </For>
            <Show when={!sites().length}>
              <p {...stylex.attrs(styles.empty)}>
                {filter() ? "No site matches." : "No site has settings or data yet."}
              </p>
            </Show>
          </div>
        </Row>
      </Section>
    </>
  );
}

/** A setting's default for every site. */
function DefaultRow(props: { setting: SiteSettingKey }) {
  const info = () => siteSettings[props.setting];
  const choices = () => (info().kind === "permission" ? (["ask", "block"] as const) : (["allow", "block"] as const));
  return (
    <Row
      label={info().label}
      description={`Sites can ${info().about.charAt(0).toLowerCase()}${info().about.slice(1)}.`}
      dense
    >
      <span data-site-default={props.setting}>
        <Segmented
          value={browser().defaults[props.setting]}
          options={choices().map((c) => [c, defaultChoiceLabels[c]] as [typeof c, string])}
          onChange={(value) => updateBrowser((b) => ({ ...b, defaults: { ...b.defaults, [props.setting]: value } }))}
        />
      </span>
    </Row>
  );
}

const defaultChoiceLabels = { ask: "Ask", allow: "Allow", block: "Block" } as const;

/** One site: its settings, zoom, cookies and data. */
function SiteDetails(props: { site: string }) {
  const [data, { refetch }] = createResource(
    () => currentWorkspace()?.id,
    (id) => window.rune.browser.siteData(id),
  );
  const cookies = () => data()?.find((d) => d.site === props.site)?.cookies ?? 0;
  const deleteData = async () => {
    if (
      !(await confirmDialog(
        `Delete the cookies and data of ${props.site} in every workspace? It signs you out there.`,
        {
          confirmLabel: "Delete",
          danger: true,
        },
      ))
    )
      return;
    await window.rune.browser.clearSite(
      workspaces.map((w) => w.id),
      props.site,
    );
    await refetch();
    toast({ message: `Deleted the data of ${props.site}`, kind: "success" });
  };
  const reset = () =>
    updateBrowser((b) => {
      const sites = { ...b.sites };
      delete sites[props.site];
      const zooms = { ...b.zoom.sites };
      delete zooms[props.site];
      return { ...b, sites, zoom: { ...b.zoom, sites: zooms } };
    });
  return (
    <div {...stylex.attrs(styles.details)} data-site-details={props.site}>
      <button type="button" onClick={() => showSite(null)} {...stylex.attrs(styles.back)} data-site-back>
        <Icon name="arrow-left" size={14} /> All sites
      </button>
      <Section title={props.site} anchor="browser-site">
        <Row
          label="Cookies and site data"
          description={cookies() ? `${plural(cookies(), "cookie")} in this workspace` : "No cookies in this workspace"}
        >
          <Button variant="danger" onClick={() => void deleteData()} data-delete-site-data>
            Delete data
          </Button>
        </Row>
        <Row label="Zoom">
          <Select
            value={String(browser().zoom.sites[props.site] ?? "")}
            onChange={(e) =>
              updateBrowser((b) => {
                const sites = { ...b.zoom.sites };
                if (e.currentTarget.value) sites[props.site] = Number(e.currentTarget.value);
                else delete sites[props.site];
                return { ...b, zoom: { ...b.zoom, sites } };
              })
            }
            xstyle={styles.select}
            data-site-zoom
          >
            <option value="">Default ({percent(browser().zoom.default)})</option>
            <For each={withCurrent(ZOOM_FACTORS, browser().zoom.sites[props.site])}>
              {(f) => <option value={String(f)}>{percent(f)}</option>}
            </For>
          </Select>
        </Row>
        <For each={siteSettingKeys}>
          {(key) => (
            <Row label={siteSettings[key].label} description={siteSettings[key].about}>
              <DecisionSelect site={props.site} setting={key} />
            </Row>
          )}
        </For>
        <Row label="" description="Settings change on the next load of the site's pages.">
          <Button onClick={reset} data-reset-site>
            Reset site settings
          </Button>
        </Row>
      </Section>
    </div>
  );
}

// --- Search engine ------------------------------------------------------------------------------

export function SearchSection() {
  const search = () => browser().search;
  return (
    <Section title="Search engine" anchor="browser-search">
      <Row label="Used in the address bar" description="When what you type isn't an address.">
        <Select
          value={search().engine}
          onChange={(e) => setPart("search", { engine: e.currentTarget.value as BrowserSettings["search"]["engine"] })}
          xstyle={styles.select}
          data-search-engine
        >
          <For each={Object.entries(searchEngines)}>
            {([key, engine]) => <option value={key}>{engine.label}</option>}
          </For>
          <option value="custom">Other…</option>
        </Select>
      </Row>
      <Show when={search().engine === "custom"}>
        <Row label="Name">
          <Input
            value={search().name}
            placeholder="e.g. Wikipedia"
            onInput={(e) => setPart("search", { name: e.currentTarget.value.slice(0, 100) })}
            xstyle={styles.textInput}
            data-search-name
          />
        </Row>
        <Row
          label="URL with %s in place of the words"
          description={
            isSearchUrl(search().url)
              ? `Searching with ${searchEngineOf(browser()).label}`
              : "Until it's a web address with %s, DuckDuckGo searches."
          }
        >
          <Input
            value={search().url}
            placeholder="https://en.wikipedia.org/w/index.php?search=%s"
            onInput={(e) => setPart("search", { url: e.currentTarget.value.slice(0, 2000) })}
            xstyle={styles.textInput}
            data-search-url
          />
        </Row>
      </Show>
    </Section>
  );
}

// --- Default browser ----------------------------------------------------------------------------

export function DefaultBrowserSection() {
  return (
    <Section title="Default browser" anchor="browser-default">
      <DefaultBrowserRow />
    </Section>
  );
}

// --- On startup ---------------------------------------------------------------------------------

export function StartupSection() {
  const startup = () => browser().startup;
  const [adding, setAdding] = createSignal("");
  const addPage = () => {
    let url = adding().trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (url.length <= 2000 && !startup().pages.includes(url))
      setPart("startup", { pages: [...startup().pages, url].slice(0, 20) });
    setAdding("");
  };
  const currentPages = () =>
    apps
      .filter(
        (a) =>
          a.kind === "web" &&
          a.workspaceId === currentWorkspace()?.id &&
          /^https?:\/\//i.test(a.url ?? "") &&
          a.url!.length <= 2000,
      )
      .map((a) => a.url!)
      .slice(0, 20);
  const options: [BrowserSettings["startup"]["mode"], string, string][] = [
    ["continue", "Continue where you left off", "Your tabs, as you left them."],
    ["newTab", "Open the New Tab page", "A new tab on top of your tabs (they stay in the sidebar)."],
    ["pages", "Open a specific page or set of pages", "These pages, each in a tab (one already open is reused)."],
  ];
  return (
    <Section title="On startup" anchor="browser-startup">
      <For each={options}>
        {([mode, label, description]) => (
          <label {...stylex.attrs(styles.radioRow)}>
            <input
              type="radio"
              name="startup"
              checked={startup().mode === mode}
              onChange={() => setPart("startup", { mode })}
              {...stylex.attrs(styles.radio)}
              data-startup={mode}
            />
            <span {...stylex.attrs(styles.radioText)}>
              <span {...stylex.attrs(styles.rowLabel)}>{label}</span>
              <span {...stylex.attrs(styles.muted)}>{description}</span>
            </span>
          </label>
        )}
      </For>
      <Show when={startup().mode === "pages"}>
        <Row label="Pages" wide>
          <div {...stylex.attrs(styles.list)} data-startup-pages>
            <For each={startup().pages}>
              {(url) => (
                <div {...stylex.attrs(styles.listRow)}>
                  <span {...stylex.attrs(styles.listText)}>{url}</span>
                  <button
                    type="button"
                    title="Remove"
                    onClick={() => setPart("startup", { pages: startup().pages.filter((p) => p !== url) })}
                    {...stylex.attrs(styles.iconButton)}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              )}
            </For>
          </div>
          <form
            {...stylex.attrs(styles.inline)}
            onSubmit={(e) => {
              e.preventDefault();
              addPage();
            }}
          >
            <Input
              value={adding()}
              placeholder="Add a page: example.com"
              onInput={(e) => setAdding(e.currentTarget.value)}
              data-startup-add
            />
            <Button type="submit">Add</Button>
            <Button onClick={() => setPart("startup", { pages: currentPages() })} disabled={!currentPages().length}>
              Use current pages
            </Button>
          </form>
        </Row>
      </Show>
    </Section>
  );
}

// --- Fonts and zoom -----------------------------------------------------------------------------

const fontSizes: [number, string][] = [
  [9, "Very small"],
  [12, "Small"],
  [16, "Medium (recommended)"],
  [20, "Large"],
  [24, "Very large"],
];

/** The fonts installed here (for suggestions); empty where the page can't list them. */
const listFonts = async () => {
  try {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
    const list = query ? await query() : [];
    return [...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
};

export function AppearanceSection() {
  const [localFonts] = createResource(listFonts);
  const fonts = () => browser().fonts;
  const sizes = () =>
    fontSizes.some(([n]) => n === fonts().size)
      ? fontSizes
      : [[fonts().size, `${fonts().size} px`] as [number, string], ...fontSizes];
  const zoomed = () => Object.entries(browser().zoom.sites).sort(([a], [b]) => a.localeCompare(b));
  const family = (label: string, key: "standard" | "serif" | "sansSerif" | "fixed", generic: string) => (
    <Row label={label}>
      <Input
        value={fonts()[key]}
        placeholder="Default"
        list="browser-fonts"
        onChange={(e) => setPart("fonts", { [key]: e.currentTarget.value.trim().slice(0, 200) })}
        xstyle={styles.textInput}
        style={{ "font-family": fonts()[key] ? `"${fonts()[key]}", ${generic}` : generic }}
        data-font={key}
      />
    </Row>
  );
  return (
    <>
      <Section title="Fonts" anchor="browser-fonts">
        <Row label="Font size" description="Text on pages that don't set their own size.">
          <Select
            value={String(fonts().size)}
            onChange={(e) => setPart("fonts", { size: Number(e.currentTarget.value) })}
            xstyle={styles.select}
            data-font-size
          >
            <For each={sizes()}>{([n, label]) => <option value={String(n)}>{label}</option>}</For>
          </Select>
        </Row>
        {family("Standard font", "standard", "serif")}
        {family("Serif font", "serif", "serif")}
        {family("Sans-serif font", "sansSerif", "sans-serif")}
        {family("Fixed-width font", "fixed", "monospace")}
        <Row label="Minimum font size" description="Smaller text on pages is shown at this size.">
          <Select
            value={String(fonts().minimumSize)}
            onChange={(e) => setPart("fonts", { minimumSize: Number(e.currentTarget.value) })}
            xstyle={styles.select}
            data-font-minimum
          >
            <option value="0">None</option>
            <For each={withCurrent([6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24], fonts().minimumSize || undefined)}>
              {(n) => <option value={String(n)}>{n} px</option>}
            </For>
          </Select>
        </Row>
        <datalist id="browser-fonts">
          <For each={localFonts() ?? []}>{(f) => <option value={f} />}</For>
        </datalist>
      </Section>
      <Section title="Page zoom" anchor="browser-zoom">
        <Row label="Default zoom" description="For sites you haven't zoomed. Ctrl+0 goes back to it.">
          <Select
            value={String(browser().zoom.default)}
            onChange={(e) => setPart("zoom", { default: Number(e.currentTarget.value) })}
            xstyle={styles.select}
            data-default-zoom
          >
            <For each={withCurrent(ZOOM_FACTORS, browser().zoom.default)}>
              {(f) => <option value={String(f)}>{percent(f)}</option>}
            </For>
          </Select>
        </Row>
        <Show when={zoomed().length}>
          <Row label="Zoom levels" description="Sites you zoomed keep their zoom." wide>
            <div {...stylex.attrs(styles.list)} data-zoom-levels>
              <For each={zoomed()}>
                {([site, factor]) => (
                  <div {...stylex.attrs(styles.listRow)} data-zoom-level={site}>
                    <span {...stylex.attrs(styles.listText)}>{site}</span>
                    <span {...stylex.attrs(styles.muted)}>{percent(factor)}</span>
                    <button
                      type="button"
                      title="Remove"
                      onClick={() =>
                        updateBrowser((b) => {
                          const sites = { ...b.zoom.sites };
                          delete sites[site];
                          return { ...b, zoom: { ...b.zoom, sites } };
                        })
                      }
                      {...stylex.attrs(styles.iconButton)}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Row>
        </Show>
      </Section>
    </>
  );
}

// --- Languages ----------------------------------------------------------------------------------

const commonLanguages = [
  "en-US",
  "en-GB",
  "de",
  "fr",
  "es",
  "it",
  "pt-BR",
  "pt-PT",
  "nl",
  "sv",
  "da",
  "nb",
  "fi",
  "pl",
  "cs",
  "sk",
  "hu",
  "ro",
  "el",
  "tr",
  "ru",
  "uk",
  "he",
  "ar",
  "fa",
  "hi",
  "bn",
  "th",
  "vi",
  "id",
  "ms",
  "ja",
  "ko",
  "zh-CN",
  "zh-TW",
];

const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames([navigator.language], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

export function LanguagesSection() {
  const info = systemInfo();
  const languages = () => browser().languages;
  const preferred = () => (languages().preferred.length ? languages().preferred : (info()?.systemLanguages ?? []));
  const setPreferred = (list: string[]) => setPart("languages", { preferred: list.slice(0, 30) });
  const move = (i: number, by: -1 | 1) => {
    const list = [...preferred()];
    const [lang] = list.splice(i, 1);
    list.splice(i + by, 0, lang!);
    setPreferred(list);
  };
  const addable = () => commonLanguages.filter((l) => !preferred().includes(l));
  const dictionaries = () => info()?.spellcheckLanguages ?? [];
  const spellChosen = () => languages().spellcheckLanguages;
  const toggleDictionary = (code: string, on: boolean) =>
    setPart("languages", {
      spellcheckLanguages: on ? [...spellChosen(), code] : spellChosen().filter((l) => l !== code),
    });
  return (
    <>
      <Section
        title="Preferred languages"
        anchor="browser-languages"
        description={`Websites show their content in the first of these they have.${languages().preferred.length ? "" : " These are your system's languages until you change them."}`}
      >
        <Row label="Order of preference" wide>
          <div {...stylex.attrs(styles.list)} data-languages>
            <For each={preferred()}>
              {(code, i) => (
                <div {...stylex.attrs(styles.listRow)} data-language={code}>
                  <span {...stylex.attrs(styles.listText)}>
                    {languageName(code)} <span {...stylex.attrs(styles.muted)}>{code}</span>
                  </span>
                  <button
                    type="button"
                    title="Move up"
                    disabled={i() === 0}
                    onClick={() => move(i(), -1)}
                    {...stylex.attrs(styles.iconButton)}
                  >
                    <Icon name="arrow-up" size={14} />
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    disabled={i() === preferred().length - 1}
                    onClick={() => move(i(), 1)}
                    {...stylex.attrs(styles.iconButton)}
                  >
                    <Icon name="arrow-down" size={14} />
                  </button>
                  <button
                    type="button"
                    title="Remove"
                    disabled={preferred().length === 1}
                    onClick={() => setPreferred(preferred().filter((l) => l !== code))}
                    {...stylex.attrs(styles.iconButton)}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              )}
            </For>
          </div>
          <div {...stylex.attrs(styles.inline)}>
            <Select
              value=""
              onChange={(e) => {
                if (e.currentTarget.value) setPreferred([...preferred(), e.currentTarget.value]);
                e.currentTarget.value = "";
              }}
              xstyle={styles.select}
              data-add-language
            >
              <option value="">Add a language…</option>
              <For each={addable()}>{(code) => <option value={code}>{languageName(code)}</option>}</For>
            </Select>
            <Show when={languages().preferred.length}>
              <Button variant="ghost" onClick={() => setPreferred([])}>
                Use the system's
              </Button>
            </Show>
          </div>
        </Row>
      </Section>
      <Section title="Spell check" anchor="browser-spellcheck">
        <Row label="Check for spelling errors when you type text on web pages">
          <Toggle checked={languages().spellcheck} onChange={(spellcheck) => setPart("languages", { spellcheck })} />
        </Row>
        <Show when={languages().spellcheck}>
          <Show
            when={dictionaries().length}
            fallback={
              <p {...stylex.attrs(styles.note)}>Spell check uses your system's spell checker and its languages here.</p>
            }
          >
            <Row
              label="Use spell check for"
              description={spellChosen().length ? undefined : "Your preferred languages, while none is chosen here."}
              wide
            >
              <div {...stylex.attrs(styles.checkGrid)}>
                <For each={dictionaries()}>
                  {(code) => (
                    <label {...stylex.attrs(styles.checkItem)}>
                      <Checkbox
                        checked={spellChosen().includes(code)}
                        onChange={(e) => toggleDictionary(code, e.currentTarget.checked)}
                      />
                      {languageName(code)}
                    </label>
                  )}
                </For>
              </div>
            </Row>
          </Show>
        </Show>
      </Section>
    </>
  );
}

// --- Downloads ----------------------------------------------------------------------------------

export function DownloadsSection() {
  const info = systemInfo();
  const downloads = () => browser().downloads;
  const change = async () => {
    const folder = await window.rune.pickFolder("Where downloads go");
    if (folder) setPart("downloads", { folder });
  };
  return (
    <Section title="Downloads" anchor="browser-downloads">
      <Row label="Location" description={downloads().folder || info()?.downloadsFolder || "Your Downloads folder"}>
        <Button onClick={() => void change()} data-downloads-change>
          Change
        </Button>
        <Show when={downloads().folder}>
          <Button variant="ghost" onClick={() => setPart("downloads", { folder: "" })}>
            Reset
          </Button>
        </Show>
      </Row>
      <Row label="Ask where to save each file before downloading">
        <Toggle checked={downloads().ask} onChange={(ask) => setPart("downloads", { ask })} />
      </Row>
    </Section>
  );
}

// --- Performance --------------------------------------------------------------------------------

export function PerformanceSection() {
  return (
    <Section title="Performance" anchor="browser-performance">
      <Row
        label="Memory saver"
        description="Tabs you haven't looked at for a while close their page to save memory, and come back where you left them (scroll position, what you typed). Pinned tabs (Keep loaded), tabs playing sound and tabs whose agent is working stay loaded."
      >
        <Select
          value={String(settings().tabs.unloadAfterMinutes)}
          onChange={(e) =>
            updateSettings((s) => ({ ...s, tabs: { ...s.tabs, unloadAfterMinutes: Number(e.currentTarget.value) } }))
          }
          xstyle={styles.select}
          data-unload-after
        >
          <For each={unloadChoices(settings().tabs.unloadAfterMinutes)}>
            {([minutes, label]) => <option value={minutes}>{label}</option>}
          </For>
        </Select>
      </Row>
    </Section>
  );
}

// --- Autofill and passwords ---------------------------------------------------------------------

export function AutofillSection() {
  return (
    <Section
      title="Autofill and passwords"
      anchor="browser-autofill"
      description="Rune Browser doesn't keep passwords, payment methods or addresses itself. A password manager extension (Bitwarden, 1Password, Proton Pass…) saves and fills them in, sign-in prompts of sites included, and brings your passwords along from wherever you keep them."
    >
      <Row label="Password managers" description="From the Chrome Web Store.">
        <Button
          onClick={() => void newWebTab("https://chromewebstore.google.com/category/extensions/productivity/tools")}
        >
          Find one
        </Button>
      </Row>
      <Row label="Already have one in another browser?" description="Import it with its settings, signed in.">
        <Button onClick={openExtensionImport}>Import extensions</Button>
      </Row>
    </Section>
  );
}

// --- Import -------------------------------------------------------------------------------------

export function ImportSection() {
  const [profiles] = createResource(() => window.rune.browser.detectImports());
  const [chosen, setChosen] = createSignal<string>();
  const [parts, setParts] = createSignal<ImportPart[]>([]);
  const profile = () => profiles()?.find((p) => p.key === chosen()) ?? profiles()?.[0];
  const found = () => (profile() ? describeImport(profile()!.found) : {});
  const available = () => importParts.filter(([part]) => found()[part] !== undefined).map(([part]) => part);
  // Everything a profile has is checked when it's picked.
  createEffect(
    on(
      () => profile()?.key,
      () => setParts(available()),
    ),
  );
  const run = () => {
    const p = profile();
    if (!p || !parts().length) return;
    try {
      updateBrowser((b) => applyImport(b, p.found as ImportedBrowserSettings, parts()));
      toast({ message: `Imported from ${p.browser} (${p.profile})`, kind: "success" });
    } catch (err) {
      toast({ title: "Import failed", message: String(err), kind: "error" });
    }
  };
  return (
    <>
      <Section title="Import bookmarks and settings" anchor="browser-import">
        <Row label="Bookmarks" description="From Chrome, Firefox and the browsers based on them, or an HTML file.">
          <Button onClick={openBookmarkImport} data-import-bookmarks>
            Import bookmarks…
          </Button>
        </Row>
        <Show
          when={profiles()?.length}
          fallback={
            <p {...stylex.attrs(styles.note)}>
              {profiles.loading
                ? "Looking for browsers…"
                : "No browser with settings to import was found (Chrome, Chromium, Brave, Edge, Vivaldi and others based on Chromium)."}
            </p>
          }
        >
          <Row label="From">
            <Select
              value={profile()?.key ?? ""}
              onChange={(e) => setChosen(e.currentTarget.value)}
              xstyle={styles.select}
              data-import-profile
            >
              <For each={profiles()}>
                {(p) => (
                  <option value={p.key}>
                    {p.browser} — {p.profile}
                  </option>
                )}
              </For>
            </Select>
          </Row>
          <For each={importParts}>
            {([part, label]) => (
              <Row label={label} description={found()[part] ?? "Not set there"}>
                <Checkbox
                  checked={parts().includes(part)}
                  disabled={found()[part] === undefined}
                  onChange={(e) =>
                    setParts((list) => (e.currentTarget.checked ? [...list, part] : list.filter((p) => p !== part)))
                  }
                  data-import-part={part}
                />
              </Row>
            )}
          </For>
          <Row label="" description="Site settings and zoom levels are added to yours; the rest replaces them.">
            <Button variant="primary" disabled={!parts().length} onClick={run} data-import-run>
              Import
            </Button>
          </Row>
        </Show>
      </Section>
      <Section
        title="What else comes along"
        description="Extensions come with their settings from Settings → Extensions → Import. Passwords stay with your password manager: browsers encrypt their saved passwords for themselves alone, so they can't be read here; a password manager extension brings yours. Browsing history isn't imported."
      ></Section>
    </>
  );
}

// --- Reset settings -----------------------------------------------------------------------------

export function ResetSection() {
  const reset = async () => {
    if (
      !(await confirmDialog(
        "Restore the browser settings to their defaults? Site settings, zoom levels, your search engine, startup pages, fonts, languages and downloads go back to how they were at first. Cookies, logins and Rune Browser's own settings stay.",
        { confirmLabel: "Reset settings", danger: true },
      ))
    )
      return;
    updateBrowser(() => defaultBrowserSettings());
    toast({ message: "Browser settings restored to their defaults", kind: "success" });
  };
  return (
    <Section title="Reset settings" anchor="browser-reset">
      <Row
        label="Restore settings to their original defaults"
        description="Only the browser settings. Cookies, logins and extensions stay."
      >
        <Button variant="danger" onClick={() => void reset()} data-reset-browser>
          Reset settings
        </Button>
      </Row>
    </Section>
  );
}

/** The browser sections, by id (lib/settingsSections.ts). */
export function BrowserSection(props: { section: string }) {
  return (
    <Switch>
      <Match when={props.section === "browser-privacy"}>
        <PrivacySection />
      </Match>
      <Match when={props.section === "browser-sites"}>
        <SiteSettingsSection />
      </Match>
      <Match when={props.section === "browser-search"}>
        <SearchSection />
      </Match>
      <Match when={props.section === "browser-default"}>
        <DefaultBrowserSection />
      </Match>
      <Match when={props.section === "browser-startup"}>
        <StartupSection />
      </Match>
      <Match when={props.section === "browser-appearance"}>
        <AppearanceSection />
      </Match>
      <Match when={props.section === "browser-languages"}>
        <LanguagesSection />
      </Match>
      <Match when={props.section === "browser-downloads"}>
        <DownloadsSection />
      </Match>
      <Match when={props.section === "browser-performance"}>
        <PerformanceSection />
      </Match>
      <Match when={props.section === "browser-autofill"}>
        <AutofillSection />
      </Match>
      <Match when={props.section === "browser-import"}>
        <ImportSection />
      </Match>
      <Match when={props.section === "browser-reset"}>
        <ResetSection />
      </Match>
    </Switch>
  );
}

const styles = stylex.create({
  note: {
    margin: 0,
    paddingBlock: space.md,
    paddingInline: space.lg,
    color: colors.muted,
    fontSize: font.sm,
    lineHeight: 1.5,
  },
  muted: { color: colors.muted, fontSize: font.sm },
  rowLabel: { fontSize: font.md, fontWeight: 500 },
  select: { width: 220 },
  compactSelect: { width: 140, height: 28, fontSize: font.sm },
  textInput: { width: 220 },
  empty: { margin: 0, paddingBlock: space.sm, color: colors.muted, fontSize: font.sm },
  siteList: { display: "flex", flexDirection: "column", marginTop: space.sm },
  siteRow: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    minHeight: 40,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
    textAlign: "left",
    cursor: "pointer",
  },
  siteName: { fontWeight: 500, flexShrink: 0 },
  siteSummary: {
    flex: 1,
    minWidth: 0,
    color: colors.muted,
    fontSize: font.xs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  details: { display: "flex", flexDirection: "column", gap: space.lg },
  back: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.sm,
    alignSelf: "flex-start",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.accent,
    fontSize: font.sm,
    cursor: "pointer",
  },
  radioRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.md,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    cursor: "pointer",
  },
  radio: { marginTop: 3, accentColor: colors.accent, cursor: "pointer" },
  radioText: { display: "flex", flexDirection: "column", gap: 2 },
  list: { display: "flex", flexDirection: "column", gap: 2, width: "100%" },
  listRow: { display: "flex", alignItems: "center", gap: space.sm, minHeight: 32 },
  listText: { flex: 1, minWidth: 0, overflowWrap: "anywhere", fontSize: font.sm },
  inline: { display: "flex", alignItems: "center", gap: space.sm, marginTop: space.sm, width: "100%" },
  iconButton: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text, ":disabled": colors.border },
    cursor: { default: "pointer", ":disabled": "default" },
  },
  checkGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
    gap: space.sm,
    width: "100%",
  },
  checkItem: { display: "flex", alignItems: "center", gap: space.sm, fontSize: font.sm, cursor: "pointer" },
});
