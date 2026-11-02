// Rune Browser's internal pages, like Chromium's: rune://version, rune://gpu,
// rune://flags and rune://rune-urls (the list of them all, with Chromium's pages
// and how each fares here). Shown in Settings (components/SettingsPage.tsx).
import * as stylex from "@stylexjs/stylex";
import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js";
import { flagsFor, type FlagsInfo } from "../../shared/flags";
import {
  chromiumPages,
  flattenGpuInfo,
  gpuFeatureRows,
  internalPages,
  type ParityStatus,
} from "../../shared/internalPages";
import { api } from "../lib/api";
import { openInternalPage } from "../lib/internalPages";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { toast } from "./Toast";
import { Button, Input, Select } from "./ui";

function Page(props: { id: string; title: string; url: string; actions?: JSX.Element; children: JSX.Element }) {
  return (
    <div {...stylex.attrs(styles.page)} data-internal-page={props.id}>
      <header {...stylex.attrs(styles.header)}>
        <div>
          <h1 {...stylex.attrs(styles.title)}>{props.title}</h1>
          <p {...stylex.attrs(styles.muted, styles.mono)}>{props.url}</p>
        </div>
        {props.actions}
      </header>
      {props.children}
    </div>
  );
}

const copy = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast({ message: `Copied ${what}` });
  } catch {
    toast({ message: `Couldn't copy ${what}`, kind: "error" });
  }
};

function Table(props: { rows: [string, string][]; attr?: string }) {
  return (
    <dl {...stylex.attrs(styles.table)}>
      <For each={props.rows}>
        {([name, value]) => (
          <>
            <dt {...stylex.attrs(styles.dt)}>{name}</dt>
            <dd {...stylex.attrs(styles.dd)} data-row={props.attr ? `${props.attr}:${name}` : undefined}>
              {value}
            </dd>
          </>
        )}
      </For>
    </dl>
  );
}

/** rune://version */
export function VersionPage() {
  const [info] = createResource(() => window.rune.internals.version());
  const [health] = createResource(() => api.health());
  const [flags] = createResource(() => window.rune.internals.flags());
  const rows = (): [string, string][] => {
    const v = info();
    if (!v) return [];
    const applied = Object.entries(flags()?.applied ?? {});
    return [
      ["Rune Browser", `${v.rune} (${v.packaged ? "Official Build" : "Developer Build"})`],
      ["Chromium", v.chromium],
      ["Electron", v.electron],
      ["V8", v.v8],
      ["Node.js", v.node],
      ["Bun", health()?.bun ?? "…"],
      ["OS", v.os],
      ["User agent", v.userAgent],
      ["Command line", v.commandLine],
      ["Executable path", v.executablePath],
      ["Profile path", v.profilePath],
      ["Flags", applied.length ? applied.map(([id, value]) => `${id}: ${value}`).join(", ") : "None"],
    ];
  };
  return (
    <Page
      id="version"
      title="About Rune Browser"
      url="rune://version"
      actions={
        <Button
          onClick={() =>
            void copy(
              rows()
                .map(([k, v]) => `${k}: ${v}`)
                .join("\n"),
              "the version details",
            )
          }
        >
          <Icon name="copy" size={14} /> Copy
        </Button>
      }
    >
      <Show when={info()} fallback={<p {...stylex.attrs(styles.muted)}>Loading…</p>}>
        <Table rows={rows()} attr="version" />
      </Show>
    </Page>
  );
}

/** rune://gpu */
export function GpuPage() {
  const [report] = createResource(() => window.rune.internals.gpu());
  const features = () => gpuFeatureRows(report()?.featureStatus ?? {});
  const info = () => flattenGpuInfo(report()?.info ?? {});
  const text = () =>
    [
      "Graphics Feature Status",
      ...features().map((f) => `${f.name}: ${f.status}`),
      "",
      "GPU information",
      ...info().map(([k, v]) => `${k}: ${v}`),
    ].join("\n");
  return (
    <Page
      id="gpu"
      title="GPU"
      url="rune://gpu"
      actions={
        <Button disabled={!report()} onClick={() => void copy(text(), "the GPU report")}>
          <Icon name="copy" size={14} /> Copy report
        </Button>
      }
    >
      <Show when={report()} fallback={<p {...stylex.attrs(styles.muted)}>Collecting GPU information…</p>}>
        <section {...stylex.attrs(styles.section)}>
          <h2 {...stylex.attrs(styles.sectionTitle)}>Graphics Feature Status</h2>
          <ul {...stylex.attrs(styles.features)}>
            <For each={features()}>
              {(f) => {
                const good = () => f.good;
                const bad = () => !f.good;
                return (
                  <li data-gpu-feature={f.name}>
                    {f.name}: <span {...stylex.attrs(good() && styles.good, bad() && styles.bad)}>{f.status}</span>
                  </li>
                );
              }}
            </For>
          </ul>
        </section>
        <section {...stylex.attrs(styles.section)}>
          <h2 {...stylex.attrs(styles.sectionTitle)}>GPU information</h2>
          <Show when={info().length} fallback={<p {...stylex.attrs(styles.muted)}>No details from the GPU.</p>}>
            <Table rows={info()} />
          </Show>
        </section>
      </Show>
    </Page>
  );
}

/** rune://flags */
export function FlagsPage() {
  const [info, setInfo] = createSignal<FlagsInfo>();
  void window.rune.internals.flags().then(setInfo);
  const [search, setSearch] = createSignal("");
  const all = flagsFor(window.rune.window.platform);
  const shown = createMemo(() => {
    const q = search().trim().toLowerCase();
    return q ? all.filter((f) => `${f.name} ${f.description} ${f.id}`.toLowerCase().includes(q)) : all;
  });
  const value = (id: string) => info()?.state[id] ?? "default";
  const applied = (id: string) => info()?.applied[id] ?? "default";
  const pending = () => !!info() && !info()!.safeMode && all.some((f) => value(f.id) !== applied(f.id));
  const isSet = (id: string) => value(id) !== "default";
  const set = async (id: string, next: string) => setInfo(await window.rune.internals.setFlag(id, next));
  const anySet = () => all.some((f) => isSet(f.id));
  return (
    <Page
      id="flags"
      title="Experiments"
      url="rune://flags"
      actions={
        <Button
          disabled={!anySet()}
          onClick={async () => setInfo(await window.rune.internals.resetFlags())}
          data-flags-reset
        >
          Reset all
        </Button>
      }
    >
      <div {...stylex.attrs(styles.warning)}>
        <Icon name="triangle-alert" size={18} {...stylex.attrs(styles.warningIcon)} />
        <span>
          <strong>Warning: experimental features ahead!</strong> By enabling these features, you could lose browser data
          or compromise your security or privacy. They're Chromium's, and apply to every workspace.
        </span>
      </div>
      <Show when={info()?.safeMode}>
        <p {...stylex.attrs(styles.muted)} data-flags-safe-mode>
          Rune Browser is in safe mode, so these aren't applied right now.
        </p>
      </Show>
      <Input
        type="search"
        placeholder="Search flags"
        value={search()}
        onInput={(e) => setSearch(e.currentTarget.value)}
        data-flags-search
      />
      <div {...stylex.attrs(styles.flags)}>
        <For each={shown()} fallback={<p {...stylex.attrs(styles.muted)}>No matching experiments.</p>}>
          {(flag) => (
            <div {...stylex.attrs(styles.flag)} data-flag={flag.id} data-flag-value={value(flag.id)}>
              <div {...stylex.attrs(styles.flagText)}>
                <span {...stylex.attrs(styles.flagName)}>
                  <Show when={isSet(flag.id)}>
                    <span {...stylex.attrs(styles.dot)} />
                  </Show>
                  {flag.name}
                </span>
                <span {...stylex.attrs(styles.muted)}>
                  {flag.description}
                  {flag.platforms ? ` – ${flag.platforms.map((p) => platformNames[p]).join(", ")}` : ""}
                </span>
                <span {...stylex.attrs(styles.muted, styles.mono)}>#{flag.id}</span>
              </div>
              <Select
                value={value(flag.id)}
                onChange={(e) => void set(flag.id, e.currentTarget.value)}
                xstyle={styles.select}
                data-flag-select
              >
                <For each={flag.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
              </Select>
            </div>
          )}
        </For>
      </div>
      <Show when={pending()}>
        <div {...stylex.attrs(styles.relaunch)} data-flags-relaunch>
          <span>Your changes will take effect the next time you relaunch Rune Browser.</span>
          <Button variant="primary" onClick={() => window.rune.relaunch(false)}>
            Relaunch
          </Button>
        </div>
      </Show>
    </Page>
  );
}

const platformNames: Record<string, string> = { linux: "Linux", darwin: "Mac", win32: "Windows" };

const statusLabels: Record<ParityStatus, string> = {
  matched: "In Rune Browser",
  different: "Different",
  "not-yet": "Not yet",
  "not-applicable": "Not applicable",
};

/** rune://rune-urls */
export function RuneUrlsPage() {
  return (
    <Page id="rune-urls" title="Rune URLs" url="rune://rune-urls">
      <section {...stylex.attrs(styles.section)}>
        <h2 {...stylex.attrs(styles.sectionTitle)}>Rune Browser's pages</h2>
        <p {...stylex.attrs(styles.muted)}>
          chrome:// addresses open the rune:// page that matches them (chrome://settings is rune://settings).
        </p>
        <ul {...stylex.attrs(styles.urls)}>
          <For each={internalPages}>
            {(page) => (
              <li {...stylex.attrs(styles.url)} data-rune-url={page.host}>
                <button
                  type="button"
                  {...stylex.attrs(styles.link)}
                  onClick={() => openInternalPage(`rune://${page.host}`)}
                >
                  rune://{page.host}
                </button>
                <span {...stylex.attrs(styles.muted)}>{page.description}</span>
              </li>
            )}
          </For>
        </ul>
      </section>
      <section {...stylex.attrs(styles.section)}>
        <h2 {...stylex.attrs(styles.sectionTitle)}>Chromium's pages</h2>
        <ul {...stylex.attrs(styles.urls)}>
          <For each={chromiumPages}>
            {(page) => {
              const matched = () => page.status === "matched";
              const notYet = () => page.status === "not-yet";
              return (
                <li {...stylex.attrs(styles.url)} data-chromium-url={page.host} data-status={page.status}>
                  <span {...stylex.attrs(styles.mono)}>chrome://{page.host}</span>
                  <span
                    {...stylex.attrs(styles.status, matched() && styles.statusMatched, notYet() && styles.statusNotYet)}
                  >
                    {statusLabels[page.status]}
                  </span>
                  <span {...stylex.attrs(styles.muted)}>{page.note}</span>
                </li>
              );
            }}
          </For>
        </ul>
      </section>
    </Page>
  );
}

const styles = stylex.create({
  page: {
    maxWidth: 900,
    marginInline: "auto",
    padding: space.xl,
    paddingBottom: space.xxl,
    display: "flex",
    flexDirection: "column",
    gap: space.xl,
  },
  header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: space.lg },
  title: { margin: 0, fontSize: 28, fontWeight: 650 },
  muted: { margin: 0, color: colors.muted, fontSize: font.sm },
  mono: { fontFamily: font.mono, fontSize: font.xs },
  section: { display: "flex", flexDirection: "column", gap: space.md },
  sectionTitle: { margin: 0, fontSize: font.xl, fontWeight: 650 },
  table: {
    margin: 0,
    display: "grid",
    gridTemplateColumns: "minmax(140px, max-content) 1fr",
    columnGap: space.lg,
    rowGap: space.sm,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: font.sm,
  },
  dt: { color: colors.muted, fontWeight: 500 },
  dd: { margin: 0, overflowWrap: "anywhere", fontFamily: font.mono, fontSize: font.xs, lineHeight: 1.7 },
  features: { margin: 0, paddingLeft: space.xl, display: "flex", flexDirection: "column", gap: 4, fontSize: font.sm },
  good: { color: colors.success },
  bad: { color: colors.danger },
  warning: {
    display: "flex",
    gap: space.sm,
    alignItems: "flex-start",
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.warning,
    fontSize: font.sm,
    lineHeight: 1.5,
  },
  warningIcon: { color: colors.warning, flexShrink: 0, marginTop: 1 },
  flags: {
    display: "flex",
    flexDirection: "column",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  flag: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.lg,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: { default: colors.border, ":last-child": "transparent" },
  },
  flagText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  flagName: { display: "flex", alignItems: "center", gap: space.sm, fontWeight: 600, fontSize: font.md },
  select: { width: 150, flexShrink: 0 },
  dot: { width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.accent, flexShrink: 0 },
  relaunch: {
    position: "sticky",
    bottom: space.md,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.lg,
    paddingBlock: space.md,
    paddingInline: space.lg,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.accent,
    fontSize: font.sm,
  },
  urls: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: space.sm },
  url: { display: "flex", alignItems: "baseline", gap: space.md, flexWrap: "wrap", fontSize: font.sm },
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.accent,
    cursor: "pointer",
    fontFamily: font.mono,
    fontSize: font.xs,
    textDecoration: { default: "none", ":hover": "underline" },
  },
  status: {
    paddingInline: 6,
    borderRadius: radius.full,
    fontSize: 11,
    fontWeight: 600,
    color: colors.muted,
    backgroundColor: colors.surfaceHover,
  },
  statusMatched: { color: colors.success, backgroundColor: colors.accentSoft },
  statusNotYet: { color: colors.warning },
});
