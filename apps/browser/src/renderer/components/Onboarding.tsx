// First-run setup: the choices people make once and keep (what comes over from their old browser, where
// the tabs are and the theme, the default browser, an agent or none), so Rune works as their browser from
// the first minute. Full-window, over the app, in the window it's in (lib/onboarding.ts says when). Every
// step can be skipped, the whole of it too (Skip setup, Escape), and everything is in Settings later.
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
  onMount,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { ProviderId, ProviderStatus } from "../../shared/api";
import type { BookmarkImportResult } from "../../shared/bookmarks";
import { applyImport, describeImport, importParts, type BrowserSettings, type ImportPart } from "../../shared/browser";
import { NTFY_SH, validPushServer } from "../../shared/push";
import type { DefaultBrowserStatus } from "../../shared/defaultBrowser";
import type { InstallResult } from "../../shared/extensions";
import {
  groupImportProfiles,
  importableExtensions,
  onboardingSteps,
  type ImportProfile,
  type OnboardingStep,
} from "../../shared/onboarding";
import { bookmarkSources, importBookmarks } from "../lib/bookmarks";
import { updateBrowser } from "../lib/browser";
import { setTabLayout, tabLayout, type TabLayout } from "../lib/layout";
import { finishOnboarding, onboardingShown } from "../lib/onboarding";
import { settings, updateSettings } from "../lib/settings";
import { providerById, providers, refreshProviders } from "../lib/store";
import { hasOwnControls } from "../lib/windowChrome";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { ProviderIcon } from "./ProviderIcon";
import { defaultBrowserText } from "./SettingsPage";
import { toast } from "./Toast";
import { Button, Checkbox, Input } from "./ui";
import { WindowControls } from "./WindowControls";

const STEP_NAMES: Record<OnboardingStep, string> = {
  import: "Bring your stuff",
  layout: "Layout",
  default: "Default browser",
  push: "Notifications",
  agent: "Agent",
};

/** Mount once at the app root. */
export function OnboardingHost() {
  return (
    <Show when={onboardingShown()}>
      <Onboarding />
    </Show>
  );
}

/** What a step's footer does: its main button, and whether it can be passed over. */
interface StepActions {
  primary: { label: string; run: () => void | Promise<void>; disabled?: boolean };
  /** "Skip" by default; the agent step's is "Skip, just a browser". */
  skipLabel?: string;
}

function Onboarding() {
  const steps = onboardingSteps();
  const [index, setIndex] = createSignal(0);
  const step = () => steps[index()]!;
  const last = () => index() === steps.length - 1;
  const [actions, setActions] = createSignal<StepActions | null>(null);
  let heading: HTMLHeadingElement | undefined;
  let root!: HTMLDivElement;

  const next = () => {
    if (last()) {
      finishOnboarding("completed");
      toast({ message: "You're set. All of it is in Settings whenever you want to change it.", kind: "success" });
    } else setIndex(index() + 1);
  };
  const back = () => setIndex(Math.max(0, index() - 1));
  const skipAll = () => finishOnboarding("skipped");

  // A new step: its heading takes the focus (read out first; Tab goes on into the step).
  createEffect(on(index, () => queueMicrotask(() => heading?.focus({ preventScroll: true }))));

  onMount(() => {
    // The app behind it can't be clicked or focused (the address bar of a first tab, say).
    const app = document.querySelector<HTMLElement>("[data-app-root]");
    app?.setAttribute("inert", "");
    onCleanup(() => app?.removeAttribute("inert"));
    const onKey = (e: KeyboardEvent) => {
      // The browser's own shortcuts (new tab, the command bar…) wait until it's done; typing and copying still work.
      if ((e.ctrlKey || e.metaKey || e.altKey) && !["c", "v", "x", "a", "z", "y"].includes(e.key.toLowerCase()))
        e.stopImmediatePropagation();
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        skipAll();
      } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        // Enter on a button, a field or a choice does that; anywhere else it's the step's main button.
        const target = e.target as HTMLElement;
        if (target.closest("button, input, select, textarea, a, [role=radio]")) return;
        const primary = actions()?.primary;
        if (!primary || primary.disabled) return;
        e.preventDefault();
        void primary.run();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
    root.focus();
  });

  const stepProps = (): StepProps => ({ setActions, next, heading: (el) => (heading = el) });

  return (
    <Portal>
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label="Set up Rune Browser"
        tabIndex={-1}
        {...stylex.attrs(styles.root)}
        data-onboarding={step()}
      >
        <header {...stylex.attrs(styles.top)} data-titlebar>
          <Show when={hasOwnControls}>
            <WindowControls />
          </Show>
          <span {...stylex.attrs(styles.brand)}>
            <RuneMark size={22} />
            <span {...stylex.attrs(styles.brandName)}>Rune Browser</span>
          </span>
          <span {...stylex.attrs(styles.grow)} />
          <Button variant="ghost" onClick={skipAll} title="Skip setup (Esc)" data-onboarding-skip-all>
            Skip setup
          </Button>
        </header>
        <div {...stylex.attrs(styles.progress)} aria-hidden="true">
          <div {...stylex.attrs(styles.progressFill)} style={{ width: `${((index() + 1) / steps.length) * 100}%` }} />
        </div>
        <div {...stylex.attrs(styles.body)}>
          <nav {...stylex.attrs(styles.rail)} aria-label="Setup steps">
            <ol {...stylex.attrs(styles.railList)}>
              <For each={steps}>
                {(s, i) => {
                  const current = () => i() === index();
                  const done = () => i() < index();
                  return (
                    <li
                      {...stylex.attrs(styles.railItem, current() && styles.railItemCurrent)}
                      aria-current={current() ? "step" : undefined}
                      data-onboarding-rail={s}
                    >
                      <span
                        {...stylex.attrs(
                          styles.railDot,
                          current() && styles.railDotCurrent,
                          done() && styles.railDotDone,
                        )}
                      >
                        <Show when={done()} fallback={i() + 1}>
                          <Icon name="check" size={12} stroke-width={3} />
                        </Show>
                      </span>
                      {STEP_NAMES[s]}
                    </li>
                  );
                }}
              </For>
            </ol>
          </nav>
          <main {...stylex.attrs(styles.main)}>
            <div {...stylex.attrs(styles.content)} data-onboarding-step={step()}>
              <span {...stylex.attrs(styles.stepCount)}>
                Step {index() + 1} of {steps.length}
              </span>
              <Switch>
                <Match when={step() === "import"}>
                  <ImportStep {...stepProps()} />
                </Match>
                <Match when={step() === "layout"}>
                  <LayoutStep {...stepProps()} />
                </Match>
                <Match when={step() === "default"}>
                  <DefaultBrowserStep {...stepProps()} />
                </Match>
                <Match when={step() === "push"}>
                  <PushStep {...stepProps()} />
                </Match>
                <Match when={step() === "agent"}>
                  <AgentStep {...stepProps()} />
                </Match>
              </Switch>
            </div>
            <footer {...stylex.attrs(styles.footer)}>
              <Show when={index() > 0}>
                <Button variant="ghost" onClick={back} data-onboarding-back>
                  <Icon name="arrow-left" size={14} />
                  Back
                </Button>
              </Show>
              <span {...stylex.attrs(styles.grow)} />
              <Button variant="ghost" onClick={next} data-onboarding-skip>
                {actions()?.skipLabel ?? "Skip"}
              </Button>
              <Button
                variant="primary"
                disabled={actions()?.primary.disabled}
                onClick={() => void actions()?.primary.run()}
                xstyle={styles.primary}
                data-onboarding-next
              >
                {actions()?.primary.label ?? "Continue"}
              </Button>
            </footer>
          </main>
        </div>
      </div>
    </Portal>
  );
}

interface StepProps {
  setActions: (actions: StepActions) => void;
  next: () => void;
  heading: (el: HTMLHeadingElement) => void;
}

function StepHead(props: { ref: (el: HTMLHeadingElement) => void; title: string; children: JSX.Element }) {
  return (
    <>
      <h1 ref={props.ref} tabIndex={-1} {...stylex.attrs(styles.title)}>
        {props.title}
      </h1>
      <p {...stylex.attrs(styles.lede)}>{props.children}</p>
    </>
  );
}

// --- 1. Bring your stuff ---------------------------------------------------------------------------

type Kind = "bookmarks" | "settings" | "extensions";
type Progress = { state: "working" } | { state: "done"; text: string } | { state: "failed"; text: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What a profile has, in a line ("12 bookmarks · 3 extensions · settings"). */
function summaryOf(p: ImportProfile) {
  const parts = [];
  if (p.bookmarks) parts.push(plural(p.bookmarks.count, "bookmark"));
  const ext = importableExtensions(p.extensions).length;
  if (ext) parts.push(plural(ext, "extension"));
  if (p.settings) parts.push("settings");
  return parts.join(" · ");
}

function ImportStep(props: StepProps) {
  const [found] = createResource(async () => {
    const [bookmarks, settingsProfiles, extensions] = await Promise.all([
      bookmarkSources().catch(() => []),
      window.rune.browser.detectImports().catch(() => []),
      window.rune.extensions.detectBrowsers().catch(() => []),
    ]);
    return groupImportProfiles(bookmarks, settingsProfiles, extensions);
  });
  const [chosenId, setChosenId] = createSignal<string>();
  const profile = () => found()?.find((p) => p.id === chosenId()) ?? found()?.[0];
  const [kinds, setKinds] = createSignal<Set<Kind>>(new Set());
  const [extensionData, setExtensionData] = createSignal(true);
  const [progress, setProgress] = createSignal<Partial<Record<Kind, Progress>>>({});
  const [imported, setImported] = createSignal<string | null>(null);
  const busy = () => Object.values(progress()).some((p) => p?.state === "working");

  const available = (p: ImportProfile | undefined): Kind[] =>
    p
      ? ([
          p.bookmarks && "bookmarks",
          p.settings && "settings",
          importableExtensions(p.extensions).length && "extensions",
        ].filter(Boolean) as Kind[])
      : [];
  // A profile picked: everything it has is checked.
  createEffect(
    on(
      () => profile()?.id,
      () => {
        setKinds(new Set(available(profile())));
        setProgress({});
      },
    ),
  );
  const toggle = (kind: Kind, checked: boolean) => {
    const next = new Set(kinds());
    if (checked) next.add(kind);
    else next.delete(kind);
    setKinds(next);
  };

  const settingsParts = (p: ImportProfile) => {
    const described = p.settings ? describeImport(p.settings.found) : {};
    return importParts
      .filter(([part]) => described[part] !== undefined)
      .map(([part, label]) => ({
        part: part as ImportPart,
        label,
        value: described[part]!,
      }));
  };

  async function run() {
    const p = profile();
    if (!p) return;
    const set = (kind: Kind, value: Progress) => setProgress((all) => ({ ...all, [kind]: value }));
    const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
    const todo = [...kinds()];
    for (const kind of todo) set(kind, { state: "working" });
    await Promise.all(
      todo.map(async (kind) => {
        try {
          if (kind === "bookmarks") {
            const r: BookmarkImportResult = await importBookmarks({ source: p.bookmarks!.id });
            set(kind, {
              state: "done",
              text: `${plural(r.added, "bookmark")}${r.skipped ? ` (${r.skipped} left out: scripts and browser-only pages)` : ""}`,
            });
          } else if (kind === "settings") {
            const parts = settingsParts(p).map((s) => s.part);
            updateBrowser((b) => applyImport(b, p.settings!.found, parts));
            set(kind, {
              state: "done",
              text: settingsParts(p)
                .map((s) => s.label)
                .join(", "),
            });
          } else {
            const ids = importableExtensions(p.extensions).map((e) => e.id);
            const r: InstallResult = await window.rune.extensions.import({
              profileKey: p.extensions!.key,
              ids,
              settings: extensionData(),
            });
            const failed = r.failed.map((f) => `${f.name}: ${f.error}`).join("; ");
            set(
              kind,
              r.installed.length
                ? { state: "done", text: `${r.installed.map((e) => e.name).join(", ")}${failed ? ` (${failed})` : ""}` }
                : { state: "failed", text: failed || "None could be added" },
            );
          }
        } catch (err) {
          set(kind, { state: "failed", text: message(err) });
        }
      }),
    );
    setImported(p.id);
  }

  const done = () => imported() !== null && imported() === profile()?.id;
  createEffect(() =>
    props.setActions(
      done() || !profile() || !kinds().size
        ? { primary: { label: "Continue", run: props.next, disabled: busy() } }
        : { primary: { label: busy() ? "Importing…" : "Import", run, disabled: busy() } },
    ),
  );

  return (
    <>
      <StepHead ref={props.heading} title="Bring your stuff">
        Your bookmarks, settings and extensions from the browser you use now. Nothing changes there.
      </StepHead>
      <Show
        when={!found.loading}
        fallback={<p {...stylex.attrs(styles.quiet)}>Looking for browsers on this computer…</p>}
      >
        <Show
          when={found()?.length}
          fallback={
            <div {...stylex.attrs(styles.empty)} data-onboarding-no-browsers>
              <Icon name="search-x" size={18} {...stylex.attrs(styles.accentText)} />
              <span>
                No other browser with bookmarks, settings or extensions was found. You can import bookmarks from an HTML
                file later, in Settings → General → Import.
              </span>
            </div>
          }
        >
          <div role="radiogroup" aria-label="Import from" {...stylex.attrs(styles.choices)}>
            <For each={found()}>
              {(p) => {
                const selected = () => profile()?.id === p.id;
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected()}
                    disabled={busy()}
                    onClick={() => setChosenId(p.id)}
                    {...stylex.attrs(styles.choice, selected() && styles.choiceOn)}
                    data-onboarding-profile={p.profile}
                  >
                    <span {...stylex.attrs(styles.choiceIcon)}>
                      <Icon name="globe" size={18} />
                    </span>
                    <span {...stylex.attrs(styles.choiceText)}>
                      <span {...stylex.attrs(styles.choiceTitle)}>
                        {p.browser}
                        <span {...stylex.attrs(styles.quiet)}>· {p.profile}</span>
                      </span>
                      <span {...stylex.attrs(styles.choiceDetail)}>{summaryOf(p)}</span>
                    </span>
                    <span {...stylex.attrs(styles.radio, selected() && styles.radioOn)} />
                  </button>
                );
              }}
            </For>
          </div>
          <Show when={profile()} keyed>
            {(p) => (
              <div {...stylex.attrs(styles.card)} data-onboarding-import-list>
                <span {...stylex.attrs(styles.cardLabel)}>What comes over</span>
                <For each={available(p)}>
                  {(kind) => {
                    const state = () => progress()[kind];
                    const failed = () => state()?.state === "failed";
                    const exts = () => importableExtensions(p.extensions);
                    const detail = () => {
                      const s = state();
                      if (s && s.state !== "working") return s.text;
                      if (kind === "bookmarks")
                        return `${plural(p.bookmarks!.count, "bookmark")}: the bar on yours, the rest in other bookmarks`;
                      if (kind === "settings")
                        return settingsParts(p)
                          .map((s) => `${s.label}: ${s.value}`)
                          .join(" · ");
                      return exts()
                        .map((e) => e.name)
                        .join(", ");
                    };
                    const label = { bookmarks: "Bookmarks", settings: "Settings", extensions: "Extensions" }[kind];
                    return (
                      <label {...stylex.attrs(styles.item)} data-onboarding-import={kind} data-state={state()?.state}>
                        <Show
                          when={state()}
                          fallback={
                            <Checkbox
                              checked={kinds().has(kind)}
                              disabled={busy()}
                              onChange={(e) => toggle(kind, e.currentTarget.checked)}
                            />
                          }
                        >
                          {(s) => <StatusMark state={s().state} />}
                        </Show>
                        <span {...stylex.attrs(styles.itemText)}>
                          <span {...stylex.attrs(styles.itemTitle)}>{label}</span>
                          <span {...stylex.attrs(styles.itemDetail, failed() && styles.danger)}>{detail()}</span>
                        </span>
                      </label>
                    );
                  }}
                </For>
                <Show
                  when={
                    kinds().has("extensions") &&
                    !progress().extensions &&
                    importableExtensions(p.extensions).some((e) => e.hasSettings)
                  }
                >
                  <label {...stylex.attrs(styles.subOption)}>
                    <Checkbox checked={extensionData()} onChange={(e) => setExtensionData(e.currentTarget.checked)} />
                    Bring the extensions' settings too (sign-ins, preferences)
                  </label>
                </Show>
              </div>
            )}
          </Show>
        </Show>
      </Show>
    </>
  );
}

function StatusMark(props: { state: Progress["state"] }) {
  const done = () => props.state === "done";
  const failed = () => props.state === "failed";
  return (
    <span {...stylex.attrs(styles.status, done() && styles.statusDone, failed() && styles.statusFailed)}>
      <Switch>
        <Match when={props.state === "working"}>
          <Icon name="loader-circle" size={14} {...stylex.attrs(styles.spin)} />
        </Match>
        <Match when={props.state === "done"}>
          <Icon name="check" size={13} stroke-width={3} />
        </Match>
        <Match when={props.state === "failed"}>
          <Icon name="x" size={13} stroke-width={3} />
        </Match>
      </Switch>
    </span>
  );
}

// --- 2. Layout -------------------------------------------------------------------------------------

function LayoutStep(props: StepProps) {
  props.setActions({ primary: { label: "Continue", run: props.next } });
  const mode = () => settings().theme.mode;
  const setMode = (value: "system" | "light" | "dark") =>
    updateSettings((s) => ({ ...s, theme: { ...s.theme, mode: value } }));
  const layouts: [TabLayout, string, string][] = [
    ["horizontal", "Tabs on top", "A tab bar along the top, like most browsers."],
    ["vertical", "Tabs on the side", "A sidebar with room for long names and many tabs."],
  ];
  return (
    <>
      <StepHead ref={props.heading} title="Where your tabs go">
        Rune has both, and switches at once: nothing reloads. Pick one now; the tab area's menu switches later.
      </StepHead>
      <div role="radiogroup" aria-label="Tabs" {...stylex.attrs(styles.layouts)}>
        <For each={layouts}>
          {([value, title, detail]) => {
            const selected = () => tabLayout() === value;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={selected()}
                onClick={() => setTabLayout(value)}
                {...stylex.attrs(styles.layout, selected() && styles.choiceOn)}
                data-onboarding-layout={value}
              >
                <LayoutPreview layout={value} />
                <span {...stylex.attrs(styles.layoutText)}>
                  <span {...stylex.attrs(styles.choiceTitle)}>
                    {title}
                    <span {...stylex.attrs(styles.radio, styles.radioInline, selected() && styles.radioOn)} />
                  </span>
                  <span {...stylex.attrs(styles.choiceDetail)}>{detail}</span>
                </span>
              </button>
            );
          }}
        </For>
      </div>
      <div {...stylex.attrs(styles.appearance)}>
        <span {...stylex.attrs(styles.cardLabel)}>Appearance</span>
        <div role="radiogroup" aria-label="Appearance" {...stylex.attrs(styles.modes)}>
          <For
            each={
              [
                ["system", "System", "monitor"],
                ["light", "Light", "sun"],
                ["dark", "Dark", "moon"],
              ] as const
            }
          >
            {([value, label, icon]) => {
              const selected = () => mode() === value;
              return (
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected()}
                  onClick={() => setMode(value)}
                  {...stylex.attrs(styles.mode, selected() && styles.modeOn)}
                  data-onboarding-mode={value}
                >
                  <Icon name={icon} size={15} />
                  {label}
                </button>
              );
            }}
          </For>
        </div>
      </div>
    </>
  );
}

/** A small window drawn in the theme's colors, with its tabs where the layout puts them. */
function LayoutPreview(props: { layout: TabLayout }) {
  const vertical = () => props.layout === "vertical";
  const tabs = [0.62, 0.44, 0.54, 0.36];
  return (
    <span {...stylex.attrs(styles.preview, vertical() && styles.previewVertical)} aria-hidden="true">
      <Show
        when={vertical()}
        fallback={
          <span {...stylex.attrs(styles.previewBar)}>
            <span {...stylex.attrs(styles.previewLights)}>
              <i {...stylex.attrs(styles.previewLight)} />
              <i {...stylex.attrs(styles.previewLight)} />
              <i {...stylex.attrs(styles.previewLight)} />
            </span>
            <span {...stylex.attrs(styles.previewAddress)} />
            <For each={tabs.slice(0, 3)}>
              {(_, i) => {
                const first = () => i() === 0;
                return <span {...stylex.attrs(styles.previewTab, first() && styles.previewTabOn)} />;
              }}
            </For>
          </span>
        }
      >
        <span {...stylex.attrs(styles.previewSide)}>
          <span {...stylex.attrs(styles.previewLights)}>
            <i {...stylex.attrs(styles.previewLight)} />
            <i {...stylex.attrs(styles.previewLight)} />
            <i {...stylex.attrs(styles.previewLight)} />
          </span>
          <span {...stylex.attrs(styles.previewAddress, styles.previewAddressSide)} />
          <For each={tabs}>
            {(w, i) => {
              const first = () => i() === 0;
              return (
                <span {...stylex.attrs(styles.previewRow, first() && styles.previewTabOn)}>
                  <span {...stylex.attrs(styles.previewLine)} style={{ width: `${w * 100}%` }} />
                </span>
              );
            }}
          </For>
        </span>
      </Show>
      <span {...stylex.attrs(styles.previewPage)}>
        <span {...stylex.attrs(styles.previewHeadline)} />
        <span {...stylex.attrs(styles.previewText)} />
        <span {...stylex.attrs(styles.previewText, styles.previewTextShort)} />
      </span>
    </span>
  );
}

// --- 3. Default browser ----------------------------------------------------------------------------

function DefaultBrowserStep(props: StepProps) {
  const [status, { mutate, refetch }] = createResource<DefaultBrowserStatus>(() => window.rune.defaultBrowser.get());
  const [making, setMaking] = createSignal(false);
  // Back from the system's settings (Windows) or its confirmation (macOS).
  const onFocus = () => void refetch();
  window.addEventListener("focus", onFocus);
  onCleanup(() => window.removeEventListener("focus", onFocus));
  const notDefault = () => {
    const s = status();
    return s?.state === "not-default" ? s : null;
  };
  const make = async () => {
    setMaking(true);
    try {
      mutate(await window.rune.defaultBrowser.make());
    } finally {
      setMaking(false);
    }
  };
  createEffect(() =>
    props.setActions(
      notDefault()
        ? {
            primary: {
              label: notDefault()!.how === "settings" ? "Open Windows settings" : "Make default",
              run: make,
              disabled: making(),
            },
            skipLabel: "Not now",
          }
        : { primary: { label: "Continue", run: props.next } },
    ),
  );
  const isDefault = () => status()?.state === "default";
  const text = () => {
    const s = status();
    if (!s) return "Checking…";
    if (s.state === "unsupported") return s.reason;
    return defaultBrowserText[s.state === "not-default" ? s.how : "default"];
  };
  return (
    <>
      <StepHead ref={props.heading} title="Open links from other apps here">
        Links in email, chat, documents and the terminal open as new tabs in Rune, in the window you used last.
      </StepHead>
      <div {...stylex.attrs(styles.card, styles.statusCard)} data-onboarding-default={status()?.state ?? "checking"}>
        <span {...stylex.attrs(styles.bigIcon, isDefault() && styles.bigIconDone)}>
          <Icon name={status()?.state === "default" ? "badge-check" : "app-window"} size={22} />
        </span>
        <span {...stylex.attrs(styles.itemText)}>
          <span {...stylex.attrs(styles.itemTitle)}>
            <Switch fallback="Rune Browser isn't your default browser">
              <Match when={status()?.state === "default"}>Rune Browser is your default browser</Match>
              <Match when={status()?.state === "unsupported"}>Not available in this build</Match>
              <Match when={!status()}>Checking…</Match>
            </Switch>
          </span>
          <span {...stylex.attrs(styles.itemDetail)}>{text()}</span>
        </span>
      </div>
      <p {...stylex.attrs(styles.hint)}>Settings → General → Default browser has this too.</p>
    </>
  );
}

// --- 4. Notifications from closed tabs -------------------------------------------------------------

type PushService = BrowserSettings["push"]["service"];

/** Web push (main/push.ts) as in Settings → Privacy and security → Notifications from closed tabs, the same setting. */
function PushStep(props: StepProps) {
  props.setActions({ primary: { label: "Continue", run: props.next } });
  const push = () => settings().browser.push;
  // Saved through the renderer's settings: the main process runs the push connection and hears of them from here.
  const setPush = (value: Partial<BrowserSettings["push"]>) =>
    updateBrowser((b) => ({ ...b, push: { ...b.push, ...value } }));
  const valid = () => validPushServer(push().server);
  const options: [PushService, string, string, string][] = [
    [
      "ntfy",
      "Through ntfy.sh",
      `Recommended. The free public ntfy server, ${NTFY_SH.replace("https://", "")}.`,
      "bell-ring",
    ],
    ["custom", "Through your own server", "An ntfy server you run, or a hosted one you trust.", "server"],
    ["off", "Off", "Sites can only notify you while their tab is open.", "bell-off"],
  ];
  return (
    <>
      <StepHead ref={props.heading} title="Get notifications from sites even when their tab is closed?">
        Sites you allow to notify you (chat, mail, calendars) can do so after you've closed their tab. Rune has to be
        running to receive them; what's sent meanwhile waits on ntfy for 12 hours and arrives when it starts.
      </StepHead>
      <div role="radiogroup" aria-label="Notifications from closed tabs" {...stylex.attrs(styles.choices)}>
        <For each={options}>
          {([value, title, detail, icon]) => {
            const selected = () => push().service === value;
            return (
              <button
                type="button"
                role="radio"
                aria-checked={selected()}
                onClick={() => setPush({ service: value })}
                {...stylex.attrs(styles.choice, selected() && styles.choiceOn)}
                data-onboarding-push={value}
              >
                <span {...stylex.attrs(styles.choiceIcon)}>
                  <Icon name={icon} size={18} />
                </span>
                <span {...stylex.attrs(styles.choiceText)}>
                  <span {...stylex.attrs(styles.choiceTitle)}>{title}</span>
                  <span {...stylex.attrs(styles.choiceDetail)}>{detail}</span>
                </span>
                <span {...stylex.attrs(styles.radio, selected() && styles.radioOn)} />
              </button>
            );
          }}
        </For>
      </div>
      <Show when={push().service === "custom"}>
        <label {...stylex.attrs(styles.field)}>
          <span {...stylex.attrs(styles.itemTitle)}>Server address</span>
          <Input
            value={push().server}
            placeholder="https://ntfy.example.com"
            onInput={(e) => setPush({ server: e.currentTarget.value.slice(0, 2000) })}
            spellcheck={false}
            aria-invalid={!valid()}
            data-onboarding-push-server
            data-push-server-valid={valid() ? "" : undefined}
          />
          <span {...stylex.attrs(styles.itemDetail, invalidServer(push().server) && styles.danger)}>
            {valid()
              ? `Notifications go through ${valid()}.`
              : "An https address (plain http only on this computer). Until then, nothing arrives."}
          </span>
        </label>
      </Show>
      <p {...stylex.attrs(styles.hint)}>
        <Icon name="lock" size={13} />
        Messages are end-to-end encrypted: the server only sees which site sent one and when.
      </p>
    </>
  );
}

/** Something typed that isn't a valid address (an empty field isn't wrong yet). */
const invalidServer = (text: string) => text.trim() !== "" && !validPushServer(text);

// --- 5. Agent --------------------------------------------------------------------------------------

const AGENT_IDS: ProviderId[] = ["claude", "codex", "opencode"];

const stateText: Record<ProviderStatus["state"], string> = {
  ready: "Ready",
  checking: "Checking…",
  missing: "Not installed",
  "signed-out": "Not signed in",
  error: "Error",
  disabled: "Off",
};

function AgentStep(props: StepProps) {
  const ready = createMemo(() => AGENT_IDS.filter((id) => providerById(id)?.state === "ready"));
  const chosen = () => settings().agent.provider;
  const choose = (id: ProviderId) =>
    updateSettings((s) => ({ ...s, agent: { ...s.agent, provider: id, model: null, effort: null } }));
  // The default is one that works, when the one set doesn't.
  createEffect(() => {
    const ok = ready();
    if (ok.length && !ok.includes(chosen())) choose(ok[0]!);
  });
  createEffect(() =>
    props.setActions({ primary: { label: "Finish", run: props.next }, skipLabel: "Skip, just a browser" }),
  );
  return (
    <>
      <StepHead ref={props.heading} title="An agent beside every page, if you want one">
        It reads, changes and uses pages with you, in a sidebar you open with{" "}
        {window.rune.window.platform === "darwin" ? "⌘I" : "Ctrl+I"}. It signs in with your own Claude, ChatGPT (Codex)
        or OpenCode account; Rune never asks for a key. Without one, Rune is just a browser.
      </StepHead>
      <div role="radiogroup" aria-label="Agent" {...stylex.attrs(styles.choices)}>
        <For each={AGENT_IDS}>
          {(id) => <AgentChoice id={id} chosen={chosen() === id} onChoose={() => choose(id)} />}
        </For>
      </div>
      <p {...stylex.attrs(styles.hint)}>Settings → Agents has these too, with their models.</p>
    </>
  );
}

function AgentChoice(props: { id: ProviderId; chosen: boolean; onChoose: () => void }) {
  const status = () => providerById(props.id);
  const [checking, setChecking] = createSignal(false);
  const state = () => (providers().length ? (status()?.state ?? "checking") : "checking");
  const isReady = () => state() === "ready";
  const isBad = () => state() === "signed-out" || state() === "error";
  const selected = () => isReady() && props.chosen;
  /** How to sign in or install it, with the command apart ("Sign in by running `claude` in a terminal…"). */
  const message = () => {
    const text = status()?.message ?? "";
    const m = /^(.*?)`([^`]+)`(.*)$/.exec(text);
    return m ? { before: m[1]!, command: m[2]!, after: m[3]! } : { before: text, command: null, after: "" };
  };
  return (
    <div
      role="radio"
      aria-checked={selected()}
      aria-disabled={!isReady()}
      tabIndex={isReady() ? 0 : -1}
      onClick={() => isReady() && props.onChoose()}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && isReady()) {
          e.preventDefault();
          props.onChoose();
        }
      }}
      {...stylex.attrs(styles.choice, styles.agent, selected() && styles.choiceOn, isReady() && styles.agentReady)}
      data-onboarding-agent={props.id}
      data-state={state()}
    >
      <span {...stylex.attrs(styles.choiceIcon)}>
        <ProviderIcon provider={props.id} size={20} />
      </span>
      <span {...stylex.attrs(styles.choiceText)}>
        <span {...stylex.attrs(styles.choiceTitle)}>
          {status()?.label ?? props.id}
          <span {...stylex.attrs(styles.pill, isReady() && styles.pillReady, isBad() && styles.pillBad)}>
            {stateText[state()]}
          </span>
        </span>
        <span {...stylex.attrs(styles.choiceDetail)}>
          {message().before}
          <Show when={message().command}>
            {(command) => (
              <>
                <code {...stylex.attrs(styles.code)}>{command()}</code>
                <button
                  type="button"
                  title="Copy"
                  aria-label={`Copy ${command()}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigator.clipboard.writeText(command());
                    toast({ message: "Copied" });
                  }}
                  {...stylex.attrs(styles.iconButton)}
                >
                  <Icon name="copy" size={13} />
                </button>
              </>
            )}
          </Show>
          {message().after}
        </span>
      </span>
      <Show
        when={isReady()}
        fallback={
          <button
            type="button"
            title="Check again"
            aria-label={`Check ${status()?.label ?? props.id} again`}
            disabled={checking()}
            onClick={async (e) => {
              e.stopPropagation();
              setChecking(true);
              await refreshProviders(props.id).finally(() => setChecking(false));
            }}
            {...stylex.attrs(styles.iconButton)}
            data-onboarding-agent-check
          >
            <Icon name="refresh-cw" size={15} {...stylex.attrs(checking() && styles.spin)} />
          </button>
        }
      >
        <span {...stylex.attrs(styles.radio, selected() && styles.radioOn)} />
      </Show>
    </div>
  );
}

/** Rune's mark: the icon's rune, drawn in the accent. */
function RuneMark(props: { size: number }) {
  return (
    <svg width={props.size} height={props.size} viewBox="300 200 450 620" aria-hidden="true">
      <path
        d="M384 772 V252 L664 394 L384 536 L664 772"
        fill="none"
        stroke="currentColor"
        stroke-width="84"
        stroke-linecap="round"
        stroke-linejoin="round"
        {...stylex.attrs(styles.runePath)}
      />
    </svg>
  );
}

const spin = stylex.keyframes({ from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } });
const draw = stylex.keyframes({ from: { strokeDashoffset: 2000 }, to: { strokeDashoffset: 0 } });
const rise = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(6px)" },
  to: { opacity: 1, transform: "translateY(0)" },
});

const NARROW = "@media (max-width: 760px)";
const SHORT = "@media (max-height: 560px)";

const styles = stylex.create({
  root: {
    position: "fixed",
    inset: 0,
    // Over the app and its menus; under a site's sign-in prompt (AuthDialog) and toasts.
    zIndex: 1500,
    display: "flex",
    flexDirection: "column",
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.md,
    outline: "none",
  },
  top: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    flexShrink: 0,
    height: 48,
    paddingInline: space.md,
  },
  brand: { display: "flex", alignItems: "center", gap: space.sm, color: colors.accent },
  brandName: { fontSize: font.sm, fontWeight: 600, letterSpacing: "0.01em", color: colors.text },
  runePath: {
    strokeDasharray: 2000,
    animationName: draw,
    animationDuration: "900ms",
    animationTimingFunction: "cubic-bezier(.6,0,.2,1)",
    animationFillMode: "both",
  },
  grow: { flex: 1 },
  progress: {
    flexShrink: 0,
    height: 2,
    marginInline: space.md,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundImage: colors.accentGradient,
    transition: "width 300ms cubic-bezier(.4,0,.2,1)",
  },
  body: { display: "flex", flex: 1, minHeight: 0 },
  rail: {
    display: { default: "block", [NARROW]: "none" },
    flexShrink: 0,
    width: 220,
    paddingBlock: space.xxl,
    paddingInline: space.xl,
  },
  railList: { display: "flex", flexDirection: "column", gap: 2, margin: 0, padding: 0, listStyle: "none" },
  railItem: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: 8,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    color: colors.muted,
    fontSize: font.sm,
  },
  railItemCurrent: { color: colors.text, fontWeight: 600, backgroundColor: colors.accentSoft },
  railDot: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 22,
    height: 22,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: 11,
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
  },
  railDotCurrent: { borderColor: colors.accent, color: colors.accent },
  railDotDone: { borderColor: colors.accent, backgroundColor: colors.accent, color: colors.accentText },
  main: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    width: "100%",
    maxWidth: 680,
    boxSizing: "border-box",
    paddingTop: { default: space.xxl, [SHORT]: space.lg },
    paddingBottom: space.lg,
    paddingInline: { default: space.xxl, [NARROW]: space.lg },
    animationName: rise,
    animationDuration: "240ms",
    animationTimingFunction: "ease-out",
    scrollbarWidth: "thin",
  },
  stepCount: {
    color: colors.accent,
    fontSize: font.xs,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
  },
  title: {
    margin: 0,
    marginTop: -8,
    fontSize: { default: 30, [NARROW]: font.xxl },
    lineHeight: 1.15,
    fontWeight: 650,
    letterSpacing: "-0.02em",
    textWrap: "balance",
    outline: "none",
  },
  lede: { margin: 0, maxWidth: "58ch", color: colors.muted, fontSize: font.md, lineHeight: 1.55 },
  quiet: { color: colors.muted },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  hint: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    margin: 0,
    color: colors.muted,
    fontSize: font.sm,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    width: "100%",
    maxWidth: 680,
    boxSizing: "border-box",
    paddingBlock: space.lg,
    paddingInline: { default: space.xxl, [NARROW]: space.lg },
  },
  primary: { minWidth: 112, height: 36 },
  choices: { display: "flex", flexDirection: "column", gap: space.sm },
  choice: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    width: "100%",
    paddingBlock: space.md,
    paddingInline: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": `color-mix(in oklab, ${colors.border}, ${colors.text} 18%)` },
    backgroundColor: colors.surface,
    color: colors.text,
    textAlign: "left",
    cursor: { default: "pointer", ":disabled": "default" },
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineColor: colors.accent,
    outlineOffset: 2,
    transition: "border-color 120ms, box-shadow 120ms",
  },
  choiceOn: {
    borderColor: { default: colors.accent, ":hover": colors.accent },
    boxShadow: `0 0 0 3px ${colors.accentSoft}`,
  },
  choiceIcon: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  choiceText: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  choiceTitle: { display: "flex", alignItems: "center", gap: space.sm, fontWeight: 600, fontSize: font.md },
  choiceDetail: { color: colors.muted, fontSize: font.sm, lineHeight: 1.45, overflowWrap: "anywhere" },
  radio: {
    flexShrink: 0,
    width: 16,
    height: 16,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: `color-mix(in oklab, ${colors.border}, ${colors.text} 30%)`,
    backgroundColor: colors.surface,
    boxSizing: "border-box",
  },
  radioOn: { borderColor: colors.accent, borderWidth: 5 },
  radioInline: { marginLeft: "auto" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    padding: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cardLabel: {
    paddingTop: 4,
    paddingBottom: 6,
    paddingInline: space.sm,
    color: colors.muted,
    fontSize: font.xs,
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  },
  item: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    cursor: "pointer",
  },
  itemText: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  itemTitle: { fontWeight: 600, fontSize: font.md, lineHeight: "16px" },
  itemDetail: { color: colors.muted, fontSize: font.sm, lineHeight: 1.45, overflowWrap: "anywhere" },
  danger: { color: colors.danger },
  subOption: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.sm,
    marginLeft: 28,
    color: colors.muted,
    fontSize: font.sm,
    cursor: "pointer",
  },
  status: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 16,
    height: 16,
    borderRadius: radius.full,
    color: colors.muted,
  },
  statusDone: { backgroundColor: colors.success, color: colors.bg },
  statusFailed: { backgroundColor: colors.danger, color: colors.bg },
  spin: {
    animationName: spin,
    animationDuration: "900ms",
    animationIterationCount: "infinite",
    animationTimingFunction: "linear",
  },
  empty: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    color: colors.muted,
    fontSize: font.sm,
    lineHeight: 1.5,
  },
  accentText: { flexShrink: 0, color: colors.accent },
  layouts: {
    display: "grid",
    gridTemplateColumns: { default: "1fr 1fr", "@media (max-width: 520px)": "1fr" },
    gap: space.md,
  },
  layout: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": `color-mix(in oklab, ${colors.border}, ${colors.text} 18%)` },
    backgroundColor: colors.surface,
    color: colors.text,
    textAlign: "left",
    cursor: "pointer",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineColor: colors.accent,
    outlineOffset: 2,
    transition: "border-color 120ms, box-shadow 120ms",
  },
  layoutText: { display: "flex", flexDirection: "column", gap: 2, paddingInline: 2 },
  // The window in miniature: the frame in the sidebar's color, the page inset in a card.
  preview: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
    aspectRatio: "16 / 10",
    padding: 5,
    borderRadius: radius.md,
    backgroundColor: colors.sidebar,
    boxShadow: `inset 0 0 0 1px ${colors.border}`,
    overflow: "hidden",
  },
  previewVertical: { flexDirection: "row" },
  previewBar: { display: "flex", alignItems: "center", gap: 4, height: 12, flexShrink: 0 },
  previewSide: { display: "flex", flexDirection: "column", gap: 4, width: "28%", flexShrink: 0, paddingTop: 1 },
  previewLights: { display: "flex", gap: 2.5, flexShrink: 0, paddingInline: 2, height: 12, alignItems: "center" },
  previewLight: {
    width: 5,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: `color-mix(in oklab, ${colors.text} 25%, transparent)`,
  },
  previewAddress: {
    width: "22%",
    height: 8,
    flexShrink: 0,
    borderRadius: 3,
    backgroundColor: `color-mix(in oklab, ${colors.text} 10%, transparent)`,
  },
  previewAddressSide: { width: "100%", height: 10, marginBottom: 3 },
  previewTab: {
    width: "16%",
    height: 9,
    borderRadius: 3,
    backgroundColor: `color-mix(in oklab, ${colors.text} 7%, transparent)`,
  },
  previewTabOn: { backgroundColor: colors.surface, boxShadow: `0 0 0 1px ${colors.border}` },
  previewRow: { display: "flex", alignItems: "center", height: 10, paddingInline: 4, borderRadius: 3 },
  previewLine: {
    height: 3,
    borderRadius: 2,
    backgroundColor: `color-mix(in oklab, ${colors.text} 30%, transparent)`,
  },
  previewPage: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
    flex: 1,
    padding: 10,
    borderRadius: 6,
    backgroundColor: colors.bg,
    boxShadow: `0 0 0 1px ${colors.border}`,
  },
  previewHeadline: { width: "48%", height: 7, borderRadius: 2, backgroundImage: colors.accentGradient, opacity: 0.85 },
  previewText: {
    width: "86%",
    height: 4,
    borderRadius: 2,
    backgroundColor: `color-mix(in oklab, ${colors.text} 16%, transparent)`,
  },
  previewTextShort: { width: "60%" },
  appearance: { display: "flex", flexDirection: "column", gap: 0 },
  modes: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: space.sm,
  },
  mode: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": `color-mix(in oklab, ${colors.border}, ${colors.text} 18%)` },
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: font.sm,
    fontWeight: 500,
    cursor: "pointer",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineColor: colors.accent,
    outlineOffset: 2,
  },
  modeOn: {
    borderColor: { default: colors.accent, ":hover": colors.accent },
    backgroundColor: colors.accentSoft,
    fontWeight: 600,
  },
  statusCard: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg },
  bigIcon: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  bigIconDone: {
    backgroundColor: `color-mix(in oklab, ${colors.surface}, ${colors.success} 16%)`,
    color: colors.success,
  },
  agent: { alignItems: "flex-start", cursor: "default" },
  agentReady: { cursor: "pointer" },
  pill: {
    paddingBlock: 1,
    paddingInline: 7,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceHover,
    color: colors.muted,
    fontSize: 11,
    fontWeight: 600,
  },
  pillReady: {
    backgroundColor: `color-mix(in oklab, ${colors.surface}, ${colors.success} 14%)`,
    color: colors.success,
  },
  pillBad: {
    backgroundColor: `color-mix(in oklab, ${colors.surface}, ${colors.warning} 14%)`,
    color: colors.warning,
  },
  code: {
    marginInline: 2,
    paddingBlock: 1,
    paddingInline: 5,
    borderRadius: 4,
    backgroundColor: colors.surfaceHover,
    color: colors.text,
    fontFamily: font.mono,
    fontSize: font.xs,
  },
  iconButton: {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    width: 26,
    height: 26,
    verticalAlign: "middle",
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: "pointer",
  },
});
