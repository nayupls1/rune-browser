// Settings: a sidebar of categories (appearance, the current workspace,
// agent defaults and providers, apps, web tabs and their network and
// extensions, secrets and permissions) and Rune Browser's pages (History,
// Schedules, Mods, Activity), with the chosen one beside it.
import * as stylex from "@stylexjs/stylex";
import {
  createEffect,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import {
  defaultAppModel,
  providerIds,
  workspaceScope,
  type PermissionGrant,
  type ProviderId,
  type ProviderStatus,
} from "../../shared/api";
import { searchEngines, type GlobalTheme, type Settings } from "../../shared/settings";
import { api } from "../lib/api";
import { topics } from "../../shared/hub";
import type { ExtensionInfo, InstallResult } from "../../shared/extensions";
import { autoUpdate, extensionList } from "../lib/extensions";
import { securityVersion } from "../lib/security";
import { watchTopic } from "../lib/realtime";
import { settings, updateSettings } from "../lib/settings";
import { checkForUpdates, installUpdate, setUpdateChannel, updateInfo } from "../lib/updates";
import {
  ACTIVITY_VIEW,
  appById,
  currentWorkspace,
  deleteWorkspace,
  editWorkspaceSettings,
  HISTORY_VIEW,
  MODS_VIEW,
  newWebTab,
  openSettings,
  providerById,
  refreshProviders,
  SCHEDULES_VIEW,
  selectApp,
  SETTINGS_VIEW,
  settingsSection,
  updateWorkspace,
  workspaces,
} from "../lib/store";
import { settingsSections } from "../lib/settingsSections";
import { ActivityPage } from "./ActivityPage";
import { ShortcutSettings } from "./ShortcutSettings";
import { ApiMapPage } from "./ApiMapPage";
import { HistoryPage } from "./History";
import { ModsPage } from "./ModsPage";
import { SchedulesPage } from "./SchedulesPage";
import { base, themePresets } from "../../shared/theme";
import { resolveMode, systemDark, themeVars } from "../lib/theme";
import { colors, font, radius, space } from "../theme.stylex";
import { AgentPicker } from "./AgentPicker";
import { confirmDialog } from "./ConfirmDialog";
import { PageChangeRows } from "./PageChanges";
import { OverrideRows } from "./ResponseOverrides";
import { openExtensionImport } from "./ExtensionImport";
import { Icon } from "./Icon";
import { ProviderIcon } from "./ProviderIcon";
import { setFullAccess } from "../lib/access";
import { SecretForm, SecretRow } from "./Secrets";
import { Button, Select } from "./ui";

/**
 * Settings: a sidebar of categories on the left, the chosen one on the right.
 * Rune Browser's pages (History, Schedules, Mods, Activity) are categories too.
 */
export function SettingsShell(props: { view: string }) {
  const current = () =>
    settingsSections.find((s) =>
      s.view ? s.view === props.view : props.view === SETTINGS_VIEW && s.id === settingsSection(),
    ) ?? settingsSections[0]!;
  const isCurrent = (id: string) => current().id === id;
  const open = (section: (typeof settingsSections)[number]) =>
    void (section.view ? selectApp(section.view) : openSettings(section.id));
  let main!: HTMLDivElement;
  // A new category starts at its top.
  createEffect(
    on(
      () => current().id,
      () => main?.scrollTo({ top: 0 }),
      { defer: true },
    ),
  );
  const group = (name: string) => settingsSections.filter((s) => s.group === name);
  const Item = (p: { section: (typeof settingsSections)[number] }) => (
    <button
      type="button"
      aria-current={isCurrent(p.section.id) ? "page" : undefined}
      onClick={() => open(p.section)}
      {...stylex.attrs(styles.navItem, isCurrent(p.section.id) && styles.navItemOn)}
      data-settings-nav={p.section.id}
      data-page-link={p.section.view ? p.section.label : undefined}
    >
      <Icon name={p.section.icon} size={16} />
      {p.section.label}
    </button>
  );
  return (
    <div {...stylex.attrs(styles.shell)} data-settings-shell={current().id}>
      <aside {...stylex.attrs(styles.nav)} aria-label="Settings categories">
        <div {...stylex.attrs(styles.navTitle)} data-titlebar>
          <Icon name="settings" size={18} {...stylex.attrs(styles.accent)} />
          Settings
        </div>
        <For each={group("settings")}>{(section) => <Item section={section} />}</For>
        <span {...stylex.attrs(styles.navGroup)}>Activity and history</span>
        <For each={group("pages")}>{(section) => <Item section={section} />}</For>
        <div {...stylex.attrs(styles.navEnd)}>
          <For each={group("about")}>{(section) => <Item section={section} />}</For>
        </div>
      </aside>
      <div ref={main} {...stylex.attrs(styles.main)}>
        <Switch fallback={<SettingsPage section={current().id} />}>
          <Match when={props.view === HISTORY_VIEW}>
            <HistoryPage />
          </Match>
          <Match when={props.view === SCHEDULES_VIEW}>
            <SchedulesPage />
          </Match>
          <Match when={props.view === MODS_VIEW}>
            <ModsPage />
          </Match>
          <Match when={props.view === ACTIVITY_VIEW}>
            <ActivityPage />
          </Match>
        </Switch>
      </div>
    </div>
  );
}

const set = <K extends keyof Settings>(key: K, value: Partial<Settings[K]>) =>
  updateSettings((s) => ({ ...s, [key]: typeof value === "object" ? { ...(s[key] as object), ...value } : value }));
const setTheme = (value: Partial<GlobalTheme>) => set("theme", value);
const setAi = (value: Partial<Settings["apps"]["ai"]>) =>
  updateSettings((s) => ({ ...s, apps: { ...s.apps, ai: { ...s.apps.ai, ...value } } }));

/** One category of settings. */
export function SettingsPage(props: { section: string }) {
  const title = () => settingsSections.find((s) => s.id === props.section)?.label ?? "Settings";
  return (
    <div {...stylex.attrs(styles.page)} data-settings={props.section}>
      <header {...stylex.attrs(styles.header)}>
        <h1 {...stylex.attrs(styles.title)}>{title()}</h1>
        <p {...stylex.attrs(styles.muted)}>Changes are saved automatically.</p>
      </header>
      <Switch>
        <Match when={props.section === "appearance"}>
          <AppearanceSection />
        </Match>
        <Match when={props.section === "workspace"}>
          <WorkspaceSection />
        </Match>
        <Match when={props.section === "agent"}>
          <AgentSection />
        </Match>
        <Match when={props.section === "providers"}>
          <ProvidersSection />
        </Match>
        <Match when={props.section === "apps"}>
          <AppsSection />
        </Match>
        <Match when={props.section === "web"}>
          <WebSection />
        </Match>
        <Match when={props.section === "network"}>
          <NetworkSection />
        </Match>
        <Match when={props.section === "extensions"}>
          <ExtensionsSection />
        </Match>
        <Match when={props.section === "secrets"}>
          <SecretsSection />
        </Match>
        <Match when={props.section === "permissions"}>
          <PermissionsSection />
        </Match>
        <Match when={props.section === "shortcuts"}>
          <ShortcutSettings />
        </Match>
        <Match when={props.section === "api-map"}>
          <ApiMapPage />
        </Match>
        <Match when={props.section === "about"}>
          <AboutSection />
        </Match>
      </Switch>
    </div>
  );
}

function AppearanceSection() {
  const theme = () => settings().theme;
  // What an unset color is: Rune's palette for the mode on screen.
  const defaults = () => base[resolveMode(theme(), systemDark())];
  return (
    <Section title="Theme" icon="palette" anchor="appearance">
      <Row label="Theme presets" description="A starting point; tweak the colors below." wide>
        <div {...stylex.attrs(styles.presets)}>
          <For each={themePresets}>
            {(preset) => (
              <PresetButton
                name={preset.name}
                theme={{ mode: theme().mode, ...preset.theme }}
                onClick={() => updateSettings((s) => ({ ...s, theme: { mode: s.theme.mode, ...preset.theme } }))}
              />
            )}
          </For>
        </div>
      </Row>
      <Row label="Mode">
        <Segmented
          value={theme().mode}
          options={[
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
          onChange={(mode) => setTheme({ mode })}
        />
      </Row>
      <Row label="Accent color">
        <ColorField value={theme().accent} fallback={defaults().accent} onChange={(accent) => setTheme({ accent })} />
      </Row>
      <Row label="Background">
        <ColorField
          value={theme().background}
          fallback={defaults().bg}
          onChange={(background) => setTheme({ background })}
        />
      </Row>
      <Row label="Surfaces" description="Cards, inputs, panels.">
        <ColorField
          value={theme().surface}
          fallback={defaults().surface}
          onChange={(surface) => setTheme({ surface })}
        />
      </Row>
      <Row label="Text">
        <ColorField value={theme().text} fallback={defaults().text} onChange={(text) => setTheme({ text })} />
      </Row>
      <Row label="Corners">
        <Segmented
          value={theme().radius ?? "md"}
          options={[
            ["none", "Square"],
            ["sm", "Subtle"],
            ["md", "Rounded"],
            ["lg", "Round"],
          ]}
          onChange={(radius) => setTheme({ radius })}
        />
      </Row>
      <Row label="Font">
        <Segmented
          value={theme().font ?? "sans"}
          options={[
            ["sans", "Sans"],
            ["serif", "Serif"],
            ["mono", "Mono"],
            ["rounded", "Rounded"],
          ]}
          onChange={(font) => setTheme({ font })}
        />
      </Row>
      <p {...stylex.attrs(styles.muted, styles.note)}>
        New apps start with this look as their design tokens (src/tokens.css); the agent can change an app's tokens when
        you ask for a different style.
      </p>
    </Section>
  );
}

function ProvidersSection() {
  return (
    <Section title="Coding agents" icon="plug" anchor="providers">
      <p {...stylex.attrs(styles.muted, styles.note)}>
        The coding agents Rune Browser can use. They run on your own logins (Claude Code, Codex, OpenCode); sign in with
        their CLIs.
      </p>
      <For each={[...providerIds]}>{(id) => <ProviderRow id={id} />}</For>
    </Section>
  );
}

function AgentSection() {
  return (
    <Section title="Defaults" icon="bot" anchor="agent">
      <Row label="Default agent" description="For new tabs. Each tab remembers its own choice.">
        <div {...stylex.attrs(styles.pickerBox)} data-default-agent>
          <AgentPicker
            choice={{
              provider: settings().agent.provider,
              model: settings().agent.model,
              effort: settings().agent.effort,
            }}
            onChange={(choice) => set("agent", choice)}
          />
        </div>
      </Row>
      <Row
        label="Instructions for building apps"
        description="Added to the app builder's prompt in every tab, e.g. your language, currency, style preferences."
        wide
      >
        <TextArea
          value={settings().agent.instructions}
          placeholder={"e.g. Answer in German. Amounts are in EUR. Prefer dark themes with a green accent."}
          onInput={(instructions) => set("agent", { instructions })}
          name="instructions"
        />
      </Row>
      <Row label="Instructions for customizing websites" description="Added to the website agent's prompt." wide>
        <TextArea
          value={settings().agent.webInstructions}
          placeholder={"e.g. Keep changes minimal. Never hide ads by removing content the page needs."}
          onInput={(webInstructions) => set("agent", { webInstructions })}
          name="webInstructions"
        />
      </Row>
      <Row
        label="Permissions"
        description="Ask for everything: agents ask before customizing or using sites, reading other tabs, using other apps or scheduling. Full access: they don't ask (still logged in Activity)."
      >
        <div data-permission-mode>
          <Segmented
            value={settings().agent.permissions}
            options={[
              ["ask", "Ask for everything"],
              ["full", "Full access"],
            ]}
            onChange={(mode) => void setFullAccess(mode === "full")}
          />
        </div>
      </Row>
      <Row label="Show tool activity" description='Lines like "Edited src/App.tsx" or "Ran bun add zod" in the chat.'>
        <Toggle
          checked={settings().agent.showToolMessages}
          onChange={(showToolMessages) => set("agent", { showToolMessages })}
        />
      </Row>
    </Section>
  );
}

function WebSection() {
  return (
    <>
      <Section title="Browsing" icon="globe" anchor="web">
        <Row label="Search engine" description="Used when the address bar input isn't a URL.">
          <Select
            value={settings().web.searchEngine}
            onChange={(e) => set("web", { searchEngine: e.currentTarget.value as Settings["web"]["searchEngine"] })}
            xstyle={styles.select}
          >
            <For each={Object.entries(searchEngines)}>
              {([key, engine]) => <option value={key}>{engine.label}</option>}
            </For>
          </Select>
        </Row>
        <Row
          label="Site customizations and page changes"
          description="Apply the changes the agent made to websites (hidden, restyled or added elements, CSS and JavaScript)."
        >
          <Toggle checked={settings().web.overrides} onChange={(overrides) => set("web", { overrides })} />
        </Row>
        <SiteRows />
        <Row
          label="Page changes"
          description="Each change to pages, sites or patterns of sites, with its own switch."
          wide
        >
          <PageChangeRows />
        </Row>
      </Section>

      <Section title="Tabs" icon="layers" anchor="tabs">
        <Row
          label="Unload idle tabs"
          description="Tabs you haven't looked at for a while close their page to save memory, and come back where you left them (scroll position, what you typed). Pinned tabs (Keep loaded), tabs playing sound and tabs whose agent is working stay loaded."
        >
          <Select
            value={String(settings().tabs.unloadAfterMinutes)}
            onChange={(e) => set("tabs", { unloadAfterMinutes: Number(e.currentTarget.value) })}
            xstyle={styles.select}
            data-unload-after
          >
            <For each={unloadChoices(settings().tabs.unloadAfterMinutes)}>
              {([minutes, label]) => <option value={minutes}>{label}</option>}
            </For>
          </Select>
        </Row>
      </Section>
    </>
  );
}

function NetworkSection() {
  return (
    <Section title="Network" icon="network" anchor="network">
      <Row
        label="Record web tabs' traffic"
        description="Keep each web tab's recent requests (in memory, bounded) for the Network panel and the website agent, which only ever sees them with credentials hidden."
      >
        <Toggle checked={settings().web.recordNetwork} onChange={(recordNetwork) => set("web", { recordNetwork })} />
      </Row>
      <NetworkRules />
      <Row
        label="Response overrides"
        description="What the website agent made sites return in your tabs (other data, errors, failures, slow or no answers) to see every state of a page. Remove one to get the site's real answers again; the address bar shows when a page has any."
        wide
      >
        <OverrideRows />
      </Row>
    </Section>
  );
}

function AppsSection() {
  const aiDefaultModel = () => {
    const status = providerById(settings().apps.ai.provider);
    return status ? defaultAppModel(status) : null;
  };
  return (
    <>
      <Section title="Running apps" icon="box" anchor="apps">
        <SandboxRows />
        <Row label="Start apps when opened" description="Run an app's server as soon as you open its tab.">
          <Toggle checked={settings().apps.autoStart} onChange={(autoStart) => set("apps", { autoStart })} />
        </Row>
        <Row
          label="Publish when the agent is done"
          description="Build the app and switch to the finished version after every agent turn (this hides the agent; opening it goes back to editing)."
        >
          <Toggle checked={settings().apps.autoPublish} onChange={(autoPublish) => set("apps", { autoPublish })} />
        </Row>
      </Section>

      <Section title="AI in apps" icon="sparkles">
        <p {...stylex.attrs(styles.muted, styles.note)}>
          Apps can use AI (summaries, suggestions, chat) through Rune Browser, on your own subscription: no API keys in
          your apps. Only an app's server can ask, with a key that's its own; the model gets no tools, so it can't touch
          your files. Every request shows up in the app's logs.
        </p>
        <Row label="Let apps use AI">
          <Toggle checked={settings().apps.ai.enabled} onChange={(enabled) => setAi({ enabled })} />
        </Row>
        <Row
          label="Model"
          description="Who answers apps' requests. By default a fast model, to spare your plan's limits."
        >
          <div {...stylex.attrs(styles.pickerBox)} data-app-ai-agent>
            <AgentPicker
              choice={{
                provider: settings().apps.ai.provider,
                model: settings().apps.ai.model ?? aiDefaultModel(),
                effort: settings().apps.ai.effort,
              }}
              onChange={(choice) => setAi({ provider: choice.provider, model: choice.model, effort: choice.effort })}
            />
          </div>
        </Row>
        <Row label="Daily limit" description="Requests per app and day.">
          <input
            type="number"
            min="1"
            max="100000"
            value={settings().apps.ai.dailyLimit}
            onChange={(e) => {
              const n = Math.round(Number(e.currentTarget.value));
              if (n >= 1 && n <= 100_000) setAi({ dailyLimit: n });
              else e.currentTarget.value = String(settings().apps.ai.dailyLimit);
            }}
            {...stylex.attrs(styles.textInput, styles.numberInput)}
            data-ai-limit
          />
        </Row>
      </Section>
    </>
  );
}

function SecretsSection() {
  return (
    <Section title="Global secrets" icon="key-round" anchor="secrets">
      <GlobalSecrets />
    </Section>
  );
}

function PermissionsSection() {
  return (
    <Section title="Remembered decisions" icon="shield-check" anchor="permissions">
      <PermissionRows />
    </Section>
  );
}

function AboutSection() {
  const [health] = createResource(() => api.health());
  return (
    <>
      <UpdatesSection />
      <Section title="Rune Browser" icon="info" anchor="about">
        <dl {...stylex.attrs(styles.about)}>
          <dt>Data folder</dt>
          <dd {...stylex.attrs(styles.dd, styles.mono)}>{health()?.dataDir ?? "…"}</dd>
          <dt>Versions</dt>
          <dd {...stylex.attrs(styles.dd, styles.mono)}>
            Electron {window.rune.versions.electron} · Chrome {window.rune.versions.chrome} · Bun {health()?.bun ?? "…"}
          </dd>
        </dl>
      </Section>
    </>
  );
}

/** The running version, what the updater is doing, and the release channel. */
function UpdatesSection() {
  const info = updateInfo;
  const status = () => info()?.status;
  const checked = () => (info()?.checkedAt ? ` · checked ${new Date(info()!.checkedAt!).toLocaleString()}` : "");
  const description = () => {
    const s = status();
    if (!s) return "…";
    switch (s.state) {
      case "unsupported":
        return s.reason;
      case "idle":
        return `Up to date${checked()}`;
      case "checking":
        return "Checking for updates…";
      case "available":
        return `Version ${s.version} is out. Download it from its release page.`;
      case "downloading":
        return `Downloading version ${s.version}… ${s.percent}%`;
      case "ready":
        return `Version ${s.version} is ready. It's installed when Rune Browser restarts.`;
      case "error":
        return `Couldn't update: ${s.message}`;
    }
  };
  const state = () => status()?.state;
  const available = () => {
    const s = status();
    return s?.state === "available" ? s : null;
  };
  const canCheck = () => state() === "idle" || state() === "error";

  return (
    <Section title="Updates" icon="refresh-cw" anchor="updates">
      <Row label={`Rune Browser ${info()?.version ?? ""}`} description={description()}>
        <span data-update-state={state()}>
          <Switch>
            <Match when={state() === "ready"}>
              <Button onClick={installUpdate}>Restart to update</Button>
            </Match>
            <Match when={available()}>
              {(s) => <Button onClick={() => window.rune.web.openExternal(s().url)}>Download</Button>}
            </Match>
            <Match when={canCheck()}>
              <Button onClick={() => void checkForUpdates()}>Check for updates</Button>
            </Match>
          </Switch>
        </span>
      </Row>
      <Row
        label="Channel"
        description="Daily also gets builds of the latest changes: new features earlier, and sometimes rough edges."
      >
        <Segmented
          value={info()?.channel ?? "stable"}
          options={[
            ["stable", "Stable"],
            ["daily", "Daily"],
          ]}
          onChange={(channel) => void setUpdateChannel(channel)}
        />
      </Row>
    </Section>
  );
}

const stateLabels: Record<ProviderStatus["state"], string> = {
  ready: "Ready",
  checking: "Checking…",
  missing: "Not installed",
  "signed-out": "Not signed in",
  error: "Error",
  disabled: "Off",
};

/** One provider: status, on/off, and where its CLI is. */
function ProviderRow(props: { id: ProviderId }) {
  const status = () => providerById(props.id);
  const config = () => settings().providers[props.id];
  const [checking, setChecking] = createSignal(false);
  const setConfig = (value: Partial<Settings["providers"][ProviderId]>) =>
    updateSettings((s) => ({
      ...s,
      providers: { ...s.providers, [props.id]: { ...s.providers[props.id], ...value } },
    }));
  const isReady = () => status()?.state === "ready";
  const isBad = () => ["missing", "signed-out", "error"].includes(status()?.state ?? "");
  const details = () =>
    [
      status()?.version && `v${status()!.version}`,
      status()?.models.length && `${status()!.models.length} models`,
      status()?.message,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div {...stylex.attrs(styles.provider)} data-provider-row={props.id}>
      <div {...stylex.attrs(styles.providerHead)}>
        <span {...stylex.attrs(styles.providerIcon)}>
          <ProviderIcon provider={props.id} size={20} />
        </span>
        <div {...stylex.attrs(styles.rowText)}>
          <span {...stylex.attrs(styles.rowLabel)}>
            {status()?.label ?? props.id}
            <span
              {...stylex.attrs(styles.pill, isReady() && styles.pillReady, isBad() && styles.pillBad)}
              data-provider-state={status()?.state}
            >
              {stateLabels[status()?.state ?? "checking"]}
            </span>
          </span>
          <span {...stylex.attrs(styles.muted)}>{details()}</span>
        </div>
        <button
          type="button"
          title="Check again"
          disabled={checking()}
          onClick={async () => {
            setChecking(true);
            await refreshProviders(props.id).finally(() => setChecking(false));
          }}
          {...stylex.attrs(styles.iconButton)}
        >
          <Icon name="refresh-cw" size={15} />
        </button>
        <Toggle checked={config().enabled} onChange={(enabled) => setConfig({ enabled })} />
      </div>
      <label {...stylex.attrs(styles.providerPath)}>
        <span {...stylex.attrs(styles.muted)}>Binary</span>
        <input
          value={config().binaryPath}
          placeholder={status()?.binary ?? `${props.id} on your PATH`}
          onChange={(e) => setConfig({ binaryPath: e.currentTarget.value.trim() })}
          {...stylex.attrs(styles.textInput, styles.mono)}
        />
      </label>
    </div>
  );
}

/** The current workspace: its name, agent defaults and instructions, shared secrets; deleting it. */
function WorkspaceSection() {
  return (
    <Show when={currentWorkspace()} keyed>
      {(workspace) => {
        const edit = (patch: Partial<typeof workspace.settings>) =>
          editWorkspaceSettings(workspace.id, (s) => ({ ...s, ...patch }));
        const current = () => workspaces.find((w) => w.id === workspace.id) ?? workspace;
        const agent = () => current().settings.agent;
        return (
          <Section title={`Workspace: ${current().name}`} icon="layers" anchor="workspace">
            <p {...stylex.attrs(styles.muted, styles.note)}>
              Workspaces keep projects apart: each has its own tabs, agent defaults and instructions, secrets for its
              apps, and its own web logins (cookies). Switch between them with the icons at the bottom of the sidebar
              (or Ctrl+Alt+1…9).
            </p>
            <Row label="Name">
              <input
                value={current().name}
                onChange={(e) => {
                  const name = e.currentTarget.value.trim();
                  if (name) void updateWorkspace(workspace.id, { name });
                }}
                {...stylex.attrs(styles.textInput)}
                data-workspace-field="name"
              />
            </Row>
            <Row label="Default agent" description="For new tabs in this workspace. Off: the default from Agent below.">
              <Show when={agent()}>
                {(choice) => (
                  <div {...stylex.attrs(styles.pickerBox)}>
                    <AgentPicker choice={choice()} onChange={(next) => edit({ agent: next })} />
                  </div>
                )}
              </Show>
              <Toggle
                checked={!!agent()}
                onChange={(on) =>
                  edit({
                    agent: on
                      ? {
                          provider: settings().agent.provider,
                          model: settings().agent.model,
                          effort: settings().agent.effort,
                        }
                      : null,
                  })
                }
              />
            </Row>
            <Row
              label="Instructions for building apps"
              description="Added after the global instructions in this workspace's tabs."
              wide
            >
              <TextArea
                value={current().settings.instructions}
                placeholder={"e.g. This is for my client Acme: use their colors (#0a5) and English."}
                onInput={(instructions) => edit({ instructions })}
                name="workspaceInstructions"
              />
            </Row>
            <Row label="Instructions for customizing websites" wide>
              <TextArea
                value={current().settings.webInstructions}
                placeholder={"e.g. Keep changes subtle."}
                onInput={(webInstructions) => edit({ webInstructions })}
                name="workspaceWebInstructions"
              />
            </Row>
            <WorkspaceSecrets workspaceId={workspace.id} />
            <Row
              label="Delete workspace"
              description="Deletes its tabs with their apps, data and chats, its secrets, and its web logins."
            >
              <button
                type="button"
                disabled={workspaces.length < 2}
                title={workspaces.length < 2 ? "The last workspace can't be deleted" : undefined}
                onClick={async () => {
                  const ok = await confirmDialog(
                    `Delete the workspace “${current().name}” with all its tabs, apps and their data?`,
                    {
                      confirmLabel: "Delete workspace",
                      danger: true,
                    },
                  );
                  if (ok) await deleteWorkspace(workspace.id);
                }}
                {...stylex.attrs(styles.linkButton, styles.dangerButton)}
                data-delete-workspace
              >
                Delete…
              </button>
            </Row>
          </Section>
        );
      }}
    </Show>
  );
}

/** Secrets every app in the workspace gets. */
function WorkspaceSecrets(props: { workspaceId: string }) {
  const scope = () => workspaceScope(props.workspaceId);
  const [overview] = createResource(
    () => [scope(), securityVersion()] as const,
    ([s]) => api.secrets(s),
  );
  const [adding, setAdding] = createSignal(false);
  return (
    <>
      <Row
        label="Secrets for its apps"
        description="Every app in this workspace gets these as environment variables. An app's own secret of the same name wins."
      >
        <Show when={!adding()}>
          <button
            type="button"
            onClick={() => setAdding(true)}
            {...stylex.attrs(styles.linkButton)}
            data-add-workspace-secret
          >
            + Add
          </button>
        </Show>
      </Row>
      <For each={overview()?.secrets}>
        {(secret) => (
          <div {...stylex.attrs(styles.secretRow)}>
            <SecretRow secret={secret} scopeLabel="workspace" />
          </div>
        )}
      </For>
      <Show when={adding()}>
        <div {...stylex.attrs(styles.secretRow)}>
          <SecretForm
            saveLabel="Add"
            onSave={async (name, value) => {
              await api.saveSecret(scope(), name, value);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      </Show>
    </>
  );
}

/** Global secrets: available to every app the user allows, so adding one comes with a warning. */
function GlobalSecrets() {
  const [overview] = createResource(securityVersion, () => api.secrets("global"));
  const [adding, setAdding] = createSignal(false);
  const protection = () =>
    overview()?.protection === "keychain"
      ? "Encrypted, with the key in your OS keychain."
      : overview()?.protection === "file"
        ? "Encrypted, with the key protected by file permissions only (no OS keychain found)."
        : "Locked: Rune Browser couldn't unlock its key from the OS keychain.";
  return (
    <>
      <p {...stylex.attrs(styles.muted, styles.note)}>
        Secrets are environment variables for apps (API keys, passwords). Add an app's own secrets with the key button
        in its tab; global ones here can be shared with apps you allow. {protection()} Values can't be viewed after
        saving.
      </p>
      <For each={overview()?.secrets}>
        {(secret) => (
          <div {...stylex.attrs(styles.secretRow)}>
            <SecretRow secret={secret} scopeLabel="global" />
          </div>
        )}
      </For>
      <div {...stylex.attrs(styles.secretRow)}>
        <Show
          when={adding()}
          fallback={
            <button
              type="button"
              onClick={() => setAdding(true)}
              {...stylex.attrs(styles.linkButton)}
              data-add-global-secret
            >
              + Add a global secret
            </button>
          }
        >
          <div {...stylex.attrs(styles.warning)} role="alert" data-global-secret-warning>
            <strong>Global secrets are riskier.</strong> Every app you allow to use one gets it, and so does any code
            those apps run: their dependencies, or a bug the agent wrote. A leak from one app exposes it for all of
            them. Prefer a secret per app (the key button in the app's tab) unless several apps really need the same
            one.
          </div>
          <SecretForm
            saveLabel="Add global secret"
            onSave={async (name, value) => {
              await api.saveSecret("global", name, value);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </Show>
      </div>
    </>
  );
}

const permissionLabel = (g: Pick<PermissionGrant, "action" | "resource">) =>
  g.action === "app.ai"
    ? "Use AI"
    : g.action === "app.secret"
      ? `Use the global secret ${g.resource}`
      : g.action === "agent.network"
        ? `Send requests to ${g.resource}`
        : g.action === "agent.override"
          ? `Change what ${g.resource} returns`
          : g.action === "app.data"
            ? `Read the data of ${appById(g.resource)?.name ?? "a deleted app"}`
            : g.action === "app.endpoints"
              ? "Read the API map"
              : g.action === "app.tool"
                ? toolLabel(g.resource)
                : g.action === "agent.schedule"
                  ? "Run things on a schedule"
                  : g.action === "agent.tab"
                    ? `Read the tab ${appById(g.resource)?.name ?? "(deleted)"}`
                    : g.action === "agent.browse"
                      ? `Use ${g.resource} for you (click, type, fill in forms)`
                      : g.action === "agent.source"
                        ? `Change the code in ${g.resource}`
                        : `Customize ${g.resource}`;

/** "<app id>/<tool id>" as "Use add-expense in Budget". */
const toolLabel = (resource: string) => {
  const [appId, tool] = resource.split("/");
  return `Use ${tool} in ${appById(appId ?? "")?.name ?? "a deleted app"}`;
};

/** Remembered decisions, each revocable. */
function PermissionRows() {
  const [grants] = createResource(securityVersion, () => api.permissions());
  return (
    <Show
      when={grants()?.length}
      fallback={
        <p {...stylex.attrs(styles.muted, styles.note)}>
          Nothing remembered yet. When an app or agent asks for something and you choose “Remember”, it shows up here.
        </p>
      }
    >
      <For each={grants()}>
        {(grant) => (
          <Row
            label={`${grant.subjectName}: ${permissionLabel(grant)}`}
            description={`${grant.decision === "allow" ? "Allowed" : "Denied"} · ${new Date(grant.createdAt).toLocaleDateString()}`}
          >
            <button
              type="button"
              onClick={() => void api.revokePermission(grant.id)}
              {...stylex.attrs(styles.linkButton)}
              data-revoke-permission
            >
              Revoke
            </button>
          </Row>
        )}
      </For>
    </Show>
  );
}

/** "Name: value" per line; a name without a value removes the header. */
const parseHeaders = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes(":"))
      .map((line) => {
        const i = line.indexOf(":");
        const value = line.slice(i + 1).trim();
        return [line.slice(0, i).trim(), value || null] as const;
      })
      .filter(([name]) => name),
  );

const headersLabel = (headers: Record<string, string | null>) =>
  Object.entries(headers)
    .map(([name, value]) => (value === null ? `−${name}` : `${name}: ${value}`))
    .join(", ");

/** Rules that block or change web tabs' requests, everywhere or in one workspace. */
function NetworkRules() {
  const [rules, { refetch }] = createResource(() => api.networkRules());
  onCleanup(
    watchTopic(topics.network, (msg) => {
      if (msg.type === "network-changed" && msg.what === "rules") void refetch();
    }),
  );
  const [pattern, setPattern] = createSignal("");
  const [action, setAction] = createSignal<"block" | "modify">("block");
  const [scope, setScope] = createSignal("");
  const [requestHeaders, setRequestHeaders] = createSignal("");
  const [responseHeaders, setResponseHeaders] = createSignal("");
  const [error, setError] = createSignal<string>();
  const workspaceName = (id: string | null) =>
    id ? (workspaces.find((w) => w.id === id)?.name ?? "a deleted workspace") : "every workspace";
  const modifying = () => action() === "modify";

  const add = async (e: SubmitEvent) => {
    e.preventDefault();
    setError();
    try {
      await api.addNetworkRule({
        workspaceId: scope() || null,
        pattern: pattern().trim(),
        action: action(),
        requestHeaders: modifying() ? parseHeaders(requestHeaders()) : {},
        responseHeaders: modifying() ? parseHeaders(responseHeaders()) : {},
      });
      setPattern("");
      setRequestHeaders("");
      setResponseHeaders("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <For each={rules()}>
        {(rule) => (
          <Row
            label={rule.pattern}
            description={`${rule.action === "block" ? "Blocked" : `Changed: ${headersLabel({ ...rule.requestHeaders, ...rule.responseHeaders }) || "nothing"}`} · in ${workspaceName(rule.workspaceId)}`}
          >
            <div {...stylex.attrs(styles.siteControls)} data-network-rule={rule.pattern}>
              <Toggle checked={rule.enabled} onChange={(enabled) => void api.updateNetworkRule(rule.id, { enabled })} />
              <button
                type="button"
                title="Delete the rule"
                onClick={() => void api.deleteNetworkRule(rule.id)}
                {...stylex.attrs(styles.iconButton)}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          </Row>
        )}
      </For>
      <form onSubmit={add} {...stylex.attrs(styles.ruleForm)} data-network-rule-form>
        <div {...stylex.attrs(styles.ruleLine)}>
          <input
            value={pattern()}
            onInput={(e) => setPattern(e.currentTarget.value)}
            placeholder="*://*.tracker.example/*  or  /api/ads"
            spellcheck={false}
            {...stylex.attrs(styles.textInput, styles.ruleInput)}
          />
          <Segmented
            value={action()}
            options={[
              ["block", "Block"],
              ["modify", "Change headers"],
            ]}
            onChange={setAction}
          />
          <Select value={scope()} onChange={(e) => setScope(e.currentTarget.value)} xstyle={styles.ruleSelect}>
            <option value="">Every workspace</option>
            <For each={workspaces}>{(w) => <option value={w.id}>{w.name}</option>}</For>
          </Select>
          <button type="submit" disabled={!pattern().trim()} {...stylex.attrs(styles.linkButton)}>
            Add rule
          </button>
        </div>
        <Show when={modifying()}>
          <div {...stylex.attrs(styles.ruleLine)}>
            <textarea
              value={requestHeaders()}
              onInput={(e) => setRequestHeaders(e.currentTarget.value)}
              placeholder={"Request headers, one per line:\nDNT: 1\nReferer:   (empty removes it)"}
              rows={3}
              {...stylex.attrs(styles.textarea, styles.ruleHeaders)}
            />
            <textarea
              value={responseHeaders()}
              onInput={(e) => setResponseHeaders(e.currentTarget.value)}
              placeholder={"Response headers:\nContent-Security-Policy:"}
              rows={3}
              {...stylex.attrs(styles.textarea, styles.ruleHeaders)}
            />
          </div>
        </Show>
        <p {...stylex.attrs(styles.muted)}>
          {error() ??
            "A pattern with * matches the whole URL; without one, any URL containing it. Blocked requests show a shield in the Network panel."}
        </p>
      </form>
    </>
  );
}

/**
 * The extensions, like Chrome's extensions page: a toolbar (search, developer
 * mode, adding them), a card per extension with its switch, and its details
 * (permissions, site access, options) on demand.
 */
function ExtensionsSection() {
  const ext = window.rune.extensions;
  const [input, setInput] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [developer, setDeveloper] = createSignal(localStorage.getItem("rune.extensions-developer") === "1");
  const [details, setDetails] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal<string>();
  const report = (r: InstallResult | null) => {
    if (r)
      setMessage(
        [...r.installed.map((i) => `Added ${i.name}.`), ...r.failed.map((f) => `${f.name}: ${f.error}`)].join(" "),
      );
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage();
    try {
      await fn();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const add = (e: SubmitEvent) => {
    e.preventDefault();
    void run(async () => {
      report(await ext.install(input().trim()));
      setInput("");
    });
  };
  const checkNow = () =>
    void run(async () => {
      const n = await ext.update();
      setMessage(n ? `Updated ${n === 1 ? "one extension" : `${n} extensions`}.` : "Everything is up to date.");
    });
  const toggleDeveloper = (on: boolean) => {
    setDeveloper(on);
    localStorage.setItem("rune.extensions-developer", on ? "1" : "0");
  };
  const shown = () => {
    const q = query().trim().toLowerCase();
    return extensionList().filter(
      (x) => !q || x.name.toLowerCase().includes(q) || x.description.toLowerCase().includes(q) || x.id.includes(q),
    );
  };
  const selected = () => extensionList().find((x) => x.id === details());

  return (
    <section {...stylex.attrs(styles.section)} data-section="extensions">
      <Show
        when={selected()}
        fallback={
          <>
            <div {...stylex.attrs(styles.extToolbar)}>
              <div {...stylex.attrs(styles.extSearch)}>
                <Icon name="search" size={15} {...stylex.attrs(styles.extSearchIcon)} />
                <input
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                  placeholder="Search extensions"
                  spellcheck={false}
                  {...stylex.attrs(styles.extSearchInput)}
                  data-extension-search
                />
              </div>
              <label {...stylex.attrs(styles.extDeveloper)}>
                Developer mode
                <Toggle checked={developer()} onChange={toggleDeveloper} />
              </label>
            </div>
            <div {...stylex.attrs(styles.extActions)}>
              <Button onClick={openExtensionImport} data-extensions-import>
                <Icon name="download" size={14} />
                Import from your browser
              </Button>
              <form onSubmit={add} {...stylex.attrs(styles.extStore)} data-extension-add>
                <input
                  value={input()}
                  onInput={(e) => setInput(e.currentTarget.value)}
                  placeholder="Chrome Web Store link or ID"
                  spellcheck={false}
                  {...stylex.attrs(styles.textInput, styles.extStoreInput)}
                />
                <Button type="submit" disabled={busy() || !input().trim()}>
                  Add
                </Button>
              </form>
              <Show when={developer()}>
                <Button
                  disabled={busy()}
                  onClick={() => void run(async () => report(await ext.loadUnpacked()))}
                  data-extension-unpacked
                >
                  <Icon name="folder-open" size={14} />
                  Load unpacked
                </Button>
                <Button disabled={busy()} onClick={checkNow}>
                  <Icon name="refresh-cw" size={14} />
                  Update
                </Button>
              </Show>
            </div>
            <p {...stylex.attrs(styles.muted)} data-extension-message>
              {busy()
                ? "Working…"
                : (message() ??
                  "Extensions run in the web tabs of every workspace; each workspace keeps its own extension data, like a browser profile.")}
            </p>
            <div {...stylex.attrs(styles.extGrid)}>
              <For
                each={shown()}
                fallback={
                  <p {...stylex.attrs(styles.muted)}>
                    {query()
                      ? "No extensions match."
                      : "No extensions yet: import them from your browser or add one from the Chrome Web Store."}
                  </p>
                }
              >
                {(info) => <ExtensionCard info={info} developer={developer()} onDetails={() => setDetails(info.id)} />}
              </For>
            </div>
            <div {...stylex.attrs(styles.rows)}>
              <Row
                label="Update automatically"
                description="Check for new versions of store extensions every few hours."
              >
                <Toggle checked={autoUpdate()} onChange={(on) => void ext.setAutoUpdate(on)} />
              </Row>
            </div>
          </>
        }
      >
        {(info) => <ExtensionDetails info={info()} onBack={() => setDetails(null)} />}
      </Show>
    </section>
  );
}

const extensionSource = (info: ExtensionInfo) => {
  const s = info.source;
  if (s.kind === "browser") return `from ${s.browser} (${s.profile})`;
  if (s.kind === "webstore") return "Chrome Web Store";
  return "Unpacked";
};

const removeExtension = async (info: ExtensionInfo) => {
  if (
    await confirmDialog(`Remove ${info.name}? Its data in every workspace goes with it.`, {
      confirmLabel: "Remove",
      danger: true,
    })
  )
    await window.rune.extensions.remove(info.id);
};

/** One extension: icon, name, version, description; Details, Remove and its switch. */
function ExtensionCard(props: { info: ExtensionInfo; developer: boolean; onDetails: () => void }) {
  const ext = window.rune.extensions;
  const info = () => props.info;
  const off = () => !info().enabled;
  return (
    <div {...stylex.attrs(styles.extCard)} data-extension={info().id}>
      <div {...stylex.attrs(styles.extCardHead, off() && styles.extOff)}>
        <Show when={info().icon} fallback={<Icon name="puzzle" size={40} {...stylex.attrs(styles.accent)} />}>
          <img src={info().icon!} alt="" width={40} height={40} {...stylex.attrs(styles.extIcon)} />
        </Show>
        <div {...stylex.attrs(styles.extCardText)}>
          <span {...stylex.attrs(styles.extName)}>
            {info().name} <span {...stylex.attrs(styles.extVersion)}>{info().version}</span>
          </span>
          <span {...stylex.attrs(styles.extDescription)}>{info().description || extensionSource(info())}</span>
          <span {...stylex.attrs(styles.extVersion)}>{extensionSource(info())}</span>
          <Show when={props.developer}>
            <span {...stylex.attrs(styles.extVersion, styles.mono)}>ID: {info().id}</span>
          </Show>
          <Show when={info().error}>
            <span {...stylex.attrs(styles.extBad)}>{info().error}</span>
          </Show>
          <Show when={info().unsupported.length}>
            <button
              type="button"
              onClick={props.onDetails}
              title="What's different, in its details"
              {...stylex.attrs(styles.extLimited)}
              data-extension-limited
            >
              Limited in Rune Browser: {info().unsupported.join(", ")}
            </button>
          </Show>
        </div>
      </div>
      <div {...stylex.attrs(styles.extCardFoot)}>
        <button type="button" onClick={props.onDetails} {...stylex.attrs(styles.extFootButton)} data-extension-details>
          Details
        </button>
        <button
          type="button"
          onClick={() => void removeExtension(info())}
          {...stylex.attrs(styles.extFootButton)}
          data-extension-remove
        >
          Remove
        </button>
        <Show when={info().optionsUrl && info().enabled}>
          <button
            type="button"
            title="Its options page, in a web tab"
            onClick={() => void newWebTab(info().optionsUrl!)}
            {...stylex.attrs(styles.extFootButton)}
            data-extension-options
          >
            Options
          </button>
        </Show>
        <span {...stylex.attrs(styles.spacer)} />
        <Toggle checked={info().enabled} onChange={(on) => void ext.setEnabled(info().id, on)} />
      </div>
    </div>
  );
}

/** An extension's details: what it is, what it can do, and its settings in Rune Browser. */
function ExtensionDetails(props: { info: ExtensionInfo; onBack: () => void }) {
  const ext = window.rune.extensions;
  const info = () => props.info;
  return (
    <div {...stylex.attrs(styles.extDetails)} data-extension-details-page={info().id}>
      <button type="button" onClick={props.onBack} {...stylex.attrs(styles.extBack)}>
        <Icon name="arrow-left" size={16} />
        All extensions
      </button>
      <div {...stylex.attrs(styles.extCardHead)}>
        <Show when={info().icon} fallback={<Icon name="puzzle" size={48} {...stylex.attrs(styles.accent)} />}>
          <img src={info().icon!} alt="" width={48} height={48} {...stylex.attrs(styles.extIcon)} />
        </Show>
        <div {...stylex.attrs(styles.extCardText)}>
          <span {...stylex.attrs(styles.extName, styles.extNameLarge)}>{info().name}</span>
          <span {...stylex.attrs(styles.extDescription)}>{info().description}</span>
        </div>
        <Toggle checked={info().enabled} onChange={(on) => void ext.setEnabled(info().id, on)} />
      </div>
      <div {...stylex.attrs(styles.rows)}>
        <Row label="Version">
          <span {...stylex.attrs(styles.mono)}>{info().version || "—"}</span>
        </Row>
        <Row label="ID">
          <span {...stylex.attrs(styles.mono)}>{info().id}</span>
        </Row>
        <Row
          label="Source"
          description={
            info().source.kind === "unpacked"
              ? info().path
              : info().updates
                ? "Updated from the Chrome Web Store"
                : undefined
          }
        >
          <span>{extensionSource(info())}</span>
        </Row>
        <Row
          label="Permissions"
          description={info().permissions.length ? "What it may use. Changing one restarts the extension." : "None"}
          wide={info().permissions.length > 0}
        >
          <Show when={info().permissions.length}>
            <div {...stylex.attrs(styles.extPermissions)} data-extension-permissions>
              <For each={info().permissions}>
                {(p) => (
                  <div {...stylex.attrs(styles.extPermission)} data-extension-permission={p.name}>
                    <div {...stylex.attrs(styles.extPermissionText)}>
                      <span {...stylex.attrs(styles.extPermissionName)}>
                        {p.description}
                        <span {...stylex.attrs(styles.extChip, styles.mono)}>{p.name}</span>
                        <Show when={p.optional}>
                          <span {...stylex.attrs(styles.extChip)}>Optional</span>
                        </Show>
                      </span>
                      <Show when={p.limited}>
                        <span {...stylex.attrs(styles.extPermissionNote)} data-permission-limited>
                          <Icon name="info" size={13} {...stylex.attrs(styles.extNoteIcon)} />
                          {p.limited}
                        </span>
                      </Show>
                    </div>
                    <Toggle checked={p.allowed} onChange={(on) => void ext.setPermission(info().id, p.name, on)} />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Row>
        <Row
          label="Site access"
          description={
            info().siteAccess.length ? "Where it can read and change pages." : "It doesn't read or change pages."
          }
          wide={info().siteAccess.length > 0}
        >
          <Show when={info().siteAccess.length}>
            <div {...stylex.attrs(styles.extChips)}>
              <For each={info().siteAccess}>
                {(p) => <span {...stylex.attrs(styles.extChip, styles.mono)}>{p}</span>}
              </For>
            </div>
          </Show>
        </Row>
        <Show when={info().shortcuts.length}>
          <Row label="Keyboard shortcuts" wide>
            <div {...stylex.attrs(styles.extShortcuts)} data-extension-shortcuts>
              <For each={info().shortcuts}>
                {(c) => (
                  <div {...stylex.attrs(styles.extShortcut)}>
                    <span>{c.description || (c.name.startsWith("_execute_") ? "Open its popup" : c.name)}</span>
                    <span {...stylex.attrs(styles.extChip, styles.mono)}>{c.shortcut}</span>
                  </div>
                )}
              </For>
            </div>
          </Row>
        </Show>
        <Show when={info().nativeMessaging}>
          <Row
            label="Programs on this computer"
            description="It talks to programs installed for it (native messaging)."
          />
        </Show>
        <Show when={info().hasAction}>
          <Row label="Pin" description="Keeps it at the top of the extensions menu, in a web tab's top row.">
            <Toggle checked={info().pinned} onChange={(on) => void ext.setPinned(info().id, on)} />
          </Row>
        </Show>
        <Show when={info().optionsUrl}>
          <Row label="Extension options">
            <button
              type="button"
              disabled={!info().enabled}
              onClick={() => void newWebTab(info().optionsUrl!)}
              {...stylex.attrs(styles.linkButton)}
              data-extension-options
            >
              Open
            </button>
          </Row>
        </Show>
        <Show when={info().error}>
          <Row label="Error" description={info().error!} />
        </Show>
        <Row label="Remove extension" description="Its data in every workspace goes with it.">
          <button
            type="button"
            onClick={() =>
              void removeExtension(info()).then(
                () => !extensionList().some((x) => x.id === info().id) && props.onBack(),
              )
            }
            {...stylex.attrs(styles.linkButton, styles.dangerButton)}
          >
            Remove…
          </button>
        </Row>
      </div>
    </div>
  );
}

/** Sites the website agent customized, each with its own on/off switch. */
function SiteRows() {
  const [sites, { refetch }] = createResource(() => api.listSites());
  onCleanup(watchTopic("sites", () => void refetch()));
  const size = (n: number) => (n ? `${n.toLocaleString()} chars` : "none");
  return (
    <For each={sites()}>
      {(site) => (
        <Row label={site.host} description={`CSS ${size(site.css.length)} · JS ${size(site.js.length)}`}>
          <div {...stylex.attrs(styles.siteControls)} data-site={site.host}>
            <Toggle checked={site.enabled} onChange={(enabled) => void api.saveSite(site.host, { enabled })} />
            <button
              type="button"
              title="Remove customizations"
              onClick={async () => {
                if (
                  await confirmDialog(`Remove all customizations of ${site.host}?`, {
                    confirmLabel: "Remove",
                    danger: true,
                  })
                ) {
                  await api.deleteSite(site.host);
                }
              }}
              {...stylex.attrs(styles.iconButton)}
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        </Row>
      )}
    </For>
  );
}

/** How app processes run: the sandbox, the shell, and what the sandbox shows of the system. */
function SandboxRows() {
  const apps = () => settings().apps;
  const setApps = (value: Partial<Settings["apps"]>) =>
    updateSettings((s) => ({ ...s, apps: { ...s.apps, ...value } }));
  // Asked again when the settings change: they decide the shell and what the sandbox shows.
  const [info] = createResource(
    () => JSON.stringify([apps().sandbox, apps().shell, apps().sandboxToolchains, apps().sandboxReadOnly]),
    () => api.sandbox(),
  );
  const isCustom = () => !["auto", ...(info()?.shells.map((s) => s.id) ?? [])].includes(apps().shell);
  const [custom, setCustom] = createSignal(false);
  const shellValue = () => (custom() || isCustom() ? "custom" : apps().shell);
  const autoLabel = () => {
    const shells = info()?.shells ?? [];
    const auto = info()?.platform === "win32" ? "bun" : "sh";
    return `Automatic (${shells.find((s) => s.id === auto)?.label ?? auto})`;
  };
  const isLinux = () => info()?.platform === "linux";
  const sandboxed = () => info()?.kind === "bwrap";
  const sandboxNote = () => {
    const i = info();
    if (!i) return "";
    if (i.platform !== "linux") return "Apps run directly in their project folder: the sandbox needs Linux.";
    if (!i.bwrapAvailable) return "Bubblewrap (bwrap) isn't installed or doesn't work here, so apps run unsandboxed.";
    return "";
  };
  const addFolder = async () => {
    const folder = await window.rune.pickFolder("A folder apps may read");
    if (folder && !apps().sandboxReadOnly.includes(folder))
      setApps({ sandboxReadOnly: [...apps().sandboxReadOnly, folder] });
  };

  return (
    <>
      <Row
        label="Sandbox"
        description={`How app processes are isolated. Bubblewrap gives every app its own view of the system: only its project folder is writable, your files are invisible. ${sandboxNote()}`}
      >
        <Segmented
          value={apps().sandbox}
          options={[
            ["auto", "Automatic"],
            ["bwrap", "Bubblewrap"],
            ["none", "Off"],
          ]}
          onChange={(sandbox) => setApps({ sandbox })}
        />
      </Row>
      <Row
        label="Shell"
        description="What app commands run in: installing, the dev server, builds, the agent's commands and scheduled ones. Bun's shell works the same on every system."
      >
        <div {...stylex.attrs(styles.control)} data-shell>
          <Select
            value={shellValue()}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setCustom(value === "custom");
              if (value !== "custom") setApps({ shell: value });
            }}
            xstyle={styles.select}
          >
            <option value="auto">{autoLabel()}</option>
            <For each={info()?.shells ?? []}>{(shell) => <option value={shell.id}>{shell.label}</option>}</For>
            <option value="custom">Another program…</option>
          </Select>
          <Show when={shellValue() === "custom"}>
            <input
              value={isCustom() ? apps().shell : ""}
              placeholder={info()?.platform === "win32" ? "C:\\path\\to\\shell.exe" : "/path/to/shell"}
              spellcheck={false}
              onChange={(e) => {
                const path = e.currentTarget.value.trim();
                setApps({ shell: path || "auto" });
                if (!path) setCustom(false);
              }}
              {...stylex.attrs(styles.textInput, styles.mono)}
            />
          </Show>
        </div>
      </Row>
      <Show when={info()?.shell.id === "bun" || info()?.shell.path}>
        <p {...stylex.attrs(styles.muted, styles.note)}>
          Commands run with{" "}
          <span {...stylex.attrs(styles.mono)}>{info()?.shell.id === "bun" ? "bun exec" : info()?.shell.path}</span>
          {shellValue() === "custom" && info()?.shell.id !== "custom"
            ? " (that program wasn't found, so the automatic shell is used)"
            : ""}
          .
        </p>
      </Show>
      <Show when={isLinux()}>
        <Row
          label="Your toolchains"
          description="Show the runtimes you installed with version managers (mise, asdf, nvm, Volta, rustup, pyenv, Bun, Deno, Go…) to apps, read-only. System tools like git, curl and compilers are always there; your other files and credentials never are."
        >
          <Toggle checked={apps().sandboxToolchains} onChange={(sandboxToolchains) => setApps({ sandboxToolchains })} />
        </Row>
        <Row
          label="More folders apps can read"
          description="Read-only, in every app's sandbox. Rune Browser's own data stays hidden even if it's inside one."
          wide
        >
          <div {...stylex.attrs(styles.folderList)} data-sandbox-folders>
            <For each={apps().sandboxReadOnly}>
              {(folder) => (
                <div {...stylex.attrs(styles.folderRow)}>
                  <span {...stylex.attrs(styles.mono, styles.folderPath)}>{folder}</span>
                  <button
                    type="button"
                    title="Remove"
                    aria-label={`Remove ${folder}`}
                    onClick={() => setApps({ sandboxReadOnly: apps().sandboxReadOnly.filter((f) => f !== folder) })}
                    {...stylex.attrs(styles.iconButton)}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              )}
            </For>
            <button type="button" onClick={() => void addFolder()} {...stylex.attrs(styles.linkButton)}>
              Add a folder…
            </button>
          </div>
        </Row>
        <Show when={sandboxed()}>
          <Row
            label="What apps see"
            description="Besides the system (/usr, /etc, /opt) and their own project and data."
            wide
          >
            <details {...stylex.attrs(styles.details)} data-sandbox-view>
              <summary>
                {info()?.readOnly.length ?? 0} folders from your home, {info()?.path.length ?? 0} folders on PATH
              </summary>
              <span {...stylex.attrs(styles.rowLabel)}>Read-only</span>
              <For each={info()?.readOnly} fallback={<span {...stylex.attrs(styles.muted)}>None</span>}>
                {(dir) => <span {...stylex.attrs(styles.mono, styles.folderPath)}>{dir}</span>}
              </For>
              <span {...stylex.attrs(styles.rowLabel)}>PATH</span>
              <For each={info()?.path}>
                {(dir) => <span {...stylex.attrs(styles.mono, styles.folderPath)}>{dir}</span>}
              </For>
            </details>
          </Row>
        </Show>
      </Show>
    </>
  );
}

const unloadChoices = (current: number): [number, string][] => {
  const choices: [number, string][] = [
    [5, "After 5 minutes"],
    [15, "After 15 minutes"],
    [30, "After 30 minutes"],
    [60, "After an hour"],
    [240, "After 4 hours"],
    [0, "Never"],
  ];
  return choices.some(([m]) => m === current) ? choices : [[current, `After ${current} minutes`], ...choices];
};

function Section(props: { title: string; icon: string; anchor?: string; children: JSX.Element }) {
  return (
    <section {...stylex.attrs(styles.section)} data-section={props.anchor}>
      <h2 {...stylex.attrs(styles.sectionTitle)}>
        <Icon name={props.icon} size={18} {...stylex.attrs(styles.accent)} />
        {props.title}
      </h2>
      <div {...stylex.attrs(styles.rows)}>{props.children}</div>
    </section>
  );
}

function Row(props: { label: string; description?: string; wide?: boolean; children?: JSX.Element }) {
  return (
    <div {...stylex.attrs(styles.row, props.wide && styles.rowWide)}>
      <div {...stylex.attrs(styles.rowText, props.wide && styles.rowTextWide)}>
        <span {...stylex.attrs(styles.rowLabel)}>{props.label}</span>
        <Show when={props.description}>
          <span {...stylex.attrs(styles.muted)}>{props.description}</span>
        </Show>
      </div>
      <div {...stylex.attrs(styles.control, props.wide && styles.controlWide)}>{props.children}</div>
    </div>
  );
}

function Segmented<T extends string>(props: { value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return (
    <div {...stylex.attrs(styles.segmented)} role="radiogroup">
      <For each={props.options}>
        {([value, label]) => {
          const active = () => props.value === value;
          return (
            <button
              type="button"
              role="radio"
              aria-checked={active()}
              onClick={() => props.onChange(value)}
              {...stylex.attrs(styles.segment, active() && styles.segmentActive)}
            >
              {label}
            </button>
          );
        }}
      </For>
    </div>
  );
}

function Toggle(props: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
      {...stylex.attrs(styles.toggle, props.checked && styles.toggleOn)}
    >
      <span {...stylex.attrs(styles.knob, props.checked && styles.knobOn)} />
    </button>
  );
}

function ColorField(props: {
  value: string | undefined;
  fallback: string;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <div {...stylex.attrs(styles.colorField)}>
      <input
        type="color"
        value={props.value ?? props.fallback}
        onInput={(e) => props.onChange(e.currentTarget.value)}
        {...stylex.attrs(styles.swatchInput)}
      />
      <span {...stylex.attrs(styles.mono, styles.colorValue)}>{props.value ?? "Default"}</span>
      <Show when={props.value}>
        <button type="button" onClick={() => props.onChange(undefined)} {...stylex.attrs(styles.linkButton)}>
          Reset
        </button>
      </Show>
    </div>
  );
}

function TextArea(props: { value: string; placeholder?: string; name?: string; onInput: (value: string) => void }) {
  return (
    <textarea
      name={props.name}
      value={props.value}
      placeholder={props.placeholder}
      rows={4}
      onInput={(e) => props.onInput(e.currentTarget.value)}
      {...stylex.attrs(styles.textarea)}
    />
  );
}

/** A tiny preview of a preset: background, surface card, accent dot. */
function PresetButton(props: { name: string; theme: GlobalTheme; onClick: () => void }) {
  const vars = () => {
    const mode = resolveMode(props.theme, systemDark());
    const v = themeVars(props.theme, mode);
    return {
      bg: v[varOf(colors.bg)]!,
      surface: v[varOf(colors.surface)]!,
      accent: v[varOf(colors.accent)]!,
      text: v[varOf(colors.text)]!,
    };
  };
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.name}
      {...stylex.attrs(styles.preset)}
      data-preset={props.name}
    >
      <span {...stylex.attrs(styles.presetPreview)} style={{ "background-color": vars().bg }}>
        <span {...stylex.attrs(styles.presetCard)} style={{ "background-color": vars().surface }}>
          <span {...stylex.attrs(styles.presetDot)} style={{ "background-color": vars().accent }} />
          <span {...stylex.attrs(styles.presetLine)} style={{ "background-color": vars().text }} />
        </span>
      </span>
      <span {...stylex.attrs(styles.presetName)}>{props.name}</span>
    </button>
  );
}

const varOf = (ref: string) => /var\((--[^),\s]+)/.exec(ref)?.[1] ?? ref;

const styles = stylex.create({
  shell: { display: "flex", height: "100%", minHeight: 0 },
  nav: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
    flexShrink: 0,
    width: 220,
    paddingInline: space.sm,
    paddingBottom: space.md,
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colors.border,
    backgroundColor: colors.sidebar,
    overflowY: "auto",
  },
  navTitle: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    height: 52,
    paddingInline: space.sm,
    fontSize: font.lg,
    fontWeight: 650,
    letterSpacing: "-0.01em",
  },
  navGroup: {
    marginTop: space.md,
    marginBottom: 2,
    paddingInline: space.sm,
    color: colors.muted,
    fontSize: font.xs,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  navEnd: { display: "flex", flexDirection: "column", marginTop: "auto", paddingTop: space.md },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    height: 32,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    fontFamily: font.sans,
    fontSize: font.sm,
    textAlign: "left",
    cursor: "pointer",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineColor: colors.accent,
    outlineOffset: -2,
  },
  navItemOn: {
    backgroundColor: { default: colors.surface, ":hover": colors.surface },
    color: colors.text,
    fontWeight: 500,
    boxShadow: `0 0 0 1px ${colors.border}`,
  },
  main: { flex: 1, minWidth: 0, overflowY: "auto" },
  numberInput: { width: 110 },
  folderList: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: space.xs, width: "100%" },
  folderRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.sm, width: "100%" },
  folderPath: { overflowWrap: "anywhere", color: colors.text },
  details: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: font.sm,
    color: colors.muted,
    cursor: "default",
  },
  secretRow: {
    paddingBlock: space.xs,
    paddingInline: space.lg,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  warning: {
    marginBlock: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.warning,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.warning} 12%)`,
    color: colors.text,
    fontSize: font.sm,
    lineHeight: 1.5,
  },
  note: { margin: 0, paddingBlock: space.md, paddingInline: space.lg, lineHeight: 1.5 },
  pickerBox: {
    display: "inline-flex",
    alignItems: "center",
    padding: 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  provider: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  providerHead: { display: "flex", alignItems: "center", gap: space.md },
  providerIcon: {
    display: "grid",
    placeItems: "center",
    width: 36,
    height: 36,
    flexShrink: 0,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    color: colors.text,
  },
  providerPath: { display: "flex", alignItems: "center", gap: space.sm, fontSize: font.xs },
  pill: {
    marginLeft: space.sm,
    paddingInline: 7,
    paddingBlock: 1,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceHover,
    color: colors.muted,
    fontSize: 11,
    fontWeight: 500,
  },
  pillReady: { backgroundColor: colors.accentSoft, color: colors.success },
  pillBad: { color: colors.danger },
  page: {
    maxWidth: 820,
    marginInline: "auto",
    padding: space.xl,
    paddingBottom: space.xxl,
    display: "flex",
    flexDirection: "column",
    gap: space.xxl,
  },
  header: { display: "flex", flexDirection: "column", gap: space.sm },
  title: { margin: 0, display: "flex", alignItems: "center", gap: space.sm, fontSize: 28, fontWeight: 650 },
  accent: { color: colors.accent, flexShrink: 0 },
  muted: { margin: 0, color: colors.muted, fontSize: font.sm },
  mono: { fontFamily: font.mono, fontSize: font.xs },
  dd: { margin: 0, overflowWrap: "anywhere" },
  section: { display: "flex", flexDirection: "column", gap: space.md },
  sectionTitle: { margin: 0, display: "flex", alignItems: "center", gap: space.sm, fontSize: font.xl, fontWeight: 650 },
  rows: {
    display: "flex",
    flexDirection: "column",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.lg,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    flexWrap: "wrap",
  },
  rowWide: { flexDirection: "column", alignItems: "stretch" },
  rowText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 200, flex: "1 1 240px" },
  rowTextWide: { flex: "none" },
  rowLabel: { fontSize: font.md, fontWeight: 500 },
  control: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  controlWide: { width: "100%" },
  select: { width: 220 },
  siteControls: { display: "flex", alignItems: "center", gap: space.sm },
  extToolbar: { display: "flex", alignItems: "center", gap: space.md, flexWrap: "wrap" },
  extSearch: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flex: "1 1 260px",
    height: 38,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus-within": colors.accent },
    backgroundColor: colors.surface,
  },
  extSearchIcon: { color: colors.muted, flexShrink: 0 },
  extSearchInput: {
    flex: 1,
    minWidth: 0,
    borderWidth: 0,
    outline: "none",
    backgroundColor: "transparent",
    color: colors.text,
    fontSize: font.sm,
  },
  extDeveloper: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    color: colors.muted,
    fontSize: font.sm,
    cursor: "pointer",
  },
  extActions: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  extStore: { display: "flex", alignItems: "center", gap: space.xs, flex: "1 1 280px" },
  extStoreInput: { flex: 1, width: "auto", minWidth: 0 },
  extGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: space.md },
  extCard: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    gap: space.md,
    minHeight: 150,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  extCardHead: { display: "flex", alignItems: "flex-start", gap: space.md },
  extOff: { opacity: 0.6 },
  extCardText: { display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 },
  extName: { fontSize: font.md, fontWeight: 600, overflowWrap: "anywhere" },
  extNameLarge: { fontSize: font.lg },
  extVersion: { color: colors.muted, fontSize: font.xs, fontWeight: 400 },
  extDescription: {
    color: colors.muted,
    fontSize: font.sm,
    lineHeight: 1.4,
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  extCardFoot: { display: "flex", alignItems: "center", gap: space.xs },
  extFootButton: {
    height: 30,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.accent,
    fontSize: font.sm,
    fontWeight: 500,
    cursor: "pointer",
  },
  spacer: { flex: 1 },
  extDetails: { display: "flex", flexDirection: "column", gap: space.lg },
  extBack: {
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
  extChips: { display: "flex", flexWrap: "wrap", gap: 6 },
  extChip: {
    paddingBlock: 2,
    paddingInline: 8,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceHover,
    fontSize: font.xs,
  },
  extPermissions: { display: "flex", flexDirection: "column", gap: space.sm, width: "100%" },
  extPermission: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.md },
  extPermissionText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  extPermissionName: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, fontSize: font.sm },
  extPermissionNote: { display: "flex", alignItems: "flex-start", gap: 4, color: colors.muted, fontSize: font.xs },
  extNoteIcon: { flexShrink: 0, marginTop: 1 },
  extLimited: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.muted,
    fontFamily: "inherit",
    fontSize: font.xs,
    textAlign: "left",
    cursor: "pointer",
    textDecoration: { default: "none", ":hover": "underline" },
  },
  extShortcuts: { display: "flex", flexDirection: "column", gap: 6, width: "100%" },
  extShortcut: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    fontSize: font.sm,
  },
  extIcon: { flexShrink: 0, marginTop: 2, objectFit: "contain" },
  extBad: { color: colors.danger, fontSize: font.xs, overflowWrap: "anywhere" },
  plainButton: { color: { default: colors.muted, ":hover": colors.text } },
  iconButton: {
    display: "grid",
    placeItems: "center",
    width: 30,
    height: 30,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.danger },
    cursor: "pointer",
  },
  textInput: {
    width: 280,
    height: 34,
    paddingInline: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    backgroundColor: colors.bg,
    outline: "none",
    fontSize: font.sm,
  },
  ruleForm: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    paddingBlock: space.md,
    paddingInline: space.lg,
  },
  ruleLine: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  ruleInput: { flex: "1 1 260px", fontFamily: font.mono },
  ruleSelect: { width: 180 },
  ruleHeaders: { flex: "1 1 240px", width: "auto", minHeight: 0, fontFamily: font.mono, fontSize: font.xs },
  textarea: {
    width: "100%",
    minHeight: 88,
    padding: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    backgroundColor: colors.bg,
    outline: "none",
    fontSize: font.sm,
    lineHeight: 1.5,
    resize: "vertical",
  },
  segmented: {
    display: "inline-flex",
    padding: 2,
    gap: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
  },
  segment: {
    height: 28,
    paddingInline: space.md,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    fontSize: font.sm,
    cursor: "pointer",
  },
  segmentActive: {
    backgroundColor: { default: colors.surface, ":hover": colors.surface },
    color: colors.text,
    fontWeight: 500,
    boxShadow: `0 0 0 1px ${colors.border}, 0 1px 2px rgb(0 0 0 / 0.06)`,
  },
  toggle: {
    position: "relative",
    width: 38,
    height: 22,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    cursor: "pointer",
    transition: "background-color 150ms",
  },
  toggleOn: { backgroundColor: colors.accent },
  knob: {
    position: "absolute",
    top: 3,
    left: 3,
    width: 16,
    height: 16,
    borderRadius: radius.full,
    backgroundColor: "#ffffff",
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.25)",
    transition: "transform 150ms",
  },
  knobOn: { transform: "translateX(16px)" },
  colorField: { display: "flex", alignItems: "center", gap: space.sm },
  swatchInput: {
    width: 34,
    height: 28,
    padding: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    cursor: "pointer",
  },
  colorValue: { minWidth: 64, color: colors.muted },
  linkButton: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.accent,
    fontSize: font.sm,
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": 0.5 },
  },
  dangerButton: { color: colors.danger },
  presets: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))",
    gap: space.sm,
    width: "100%",
  },
  preset: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": colors.accent },
    backgroundColor: "transparent",
    cursor: "pointer",
    color: colors.text,
  },
  presetPreview: { display: "flex", alignItems: "flex-end", height: 44, padding: 6, borderRadius: radius.sm },
  presetCard: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    width: "100%",
    height: 18,
    paddingInline: 4,
    borderRadius: 4,
  },
  presetDot: { width: 8, height: 8, borderRadius: radius.full, flexShrink: 0 },
  presetLine: { height: 3, flex: 1, borderRadius: 2, opacity: 0.6 },
  presetName: { fontSize: font.xs },
  about: {
    margin: 0,
    paddingBlock: space.md,
    paddingInline: space.lg,
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    gap: space.sm,
    columnGap: space.lg,
    fontSize: font.sm,
  },
});
