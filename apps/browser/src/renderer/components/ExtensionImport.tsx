// "Import from your browser": the extensions of a Chrome/Chromium/Brave/Edge/
// Vivaldi profile, picked like they are there (on ones checked), brought over
// with their settings, pinned buttons and shortcuts.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { BrowserProfile, ImportCandidate, InstallResult } from "../../shared/extensions";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { Button, Checkbox, Select } from "./ui";

const [open, setOpen] = createSignal(false);

export const openExtensionImport = () => setOpen(true);

/** Mount once at the app root. */
export function ExtensionImportHost() {
  return (
    <Show when={open()}>
      <ImportDialog onClose={() => setOpen(false)} />
    </Show>
  );
}

const picksOf = (profile: BrowserProfile | undefined) =>
  new Set((profile?.extensions ?? []).filter((e) => e.enabledThere && !e.byDefault && !e.installed).map((e) => e.id));

function ImportDialog(props: { onClose: () => void }) {
  const [profiles] = createResource(() => window.rune.extensions.detectBrowsers());
  const [profileKey, setProfileKey] = createSignal<string>();
  const [picked, setPicked] = createSignal<Set<string>>(new Set());
  const [settings, setSettings] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<InstallResult>();

  // The profile with the most extensions in use comes first.
  const sorted = createMemo(() =>
    [...(profiles() ?? [])].sort(
      (a, b) => b.extensions.filter((e) => e.enabledThere).length - a.extensions.filter((e) => e.enabledThere).length,
    ),
  );
  const profile = () => sorted().find((p) => p.key === profileKey()) ?? sorted()[0];
  // Each profile starts with what's on there.
  createEffect(
    on(
      () => profile()?.key,
      () => setPicked(picksOf(profile())),
    ),
  );

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked());
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };

  async function run() {
    const p = profile();
    if (!p || !picked().size) return;
    setBusy(true);
    try {
      setResult(await window.rune.extensions.import({ profileKey: p.key, ids: [...picked()], settings: settings() }));
    } catch (err) {
      setResult({
        installed: [],
        failed: [{ id: "", name: "Import", error: err instanceof Error ? err.message : String(err) }],
      });
    } finally {
      setBusy(false);
    }
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy() && props.onClose();
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => document.removeEventListener("keydown", onKey, true));
  });

  const label = (p: BrowserProfile) => `${p.browser} · ${p.profile}`;
  const anySettings = () => (profile()?.extensions ?? []).some((e) => picked().has(e.id) && e.hasSettings);

  return (
    <Portal>
      <div
        {...stylex.attrs(styles.backdrop)}
        onClick={(e) => e.target === e.currentTarget && !busy() && props.onClose()}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Import extensions"
          {...stylex.attrs(styles.dialog)}
          data-extension-import
        >
          <h2 {...stylex.attrs(styles.title)}>
            <Icon name="download" size={18} {...stylex.attrs(styles.accent)} />
            Import extensions
          </h2>
          <Show
            when={!result()}
            fallback={
              <div {...stylex.attrs(styles.body)} data-import-result>
                <Show when={result()!.installed.length}>
                  <p {...stylex.attrs(styles.text)}>
                    Imported{" "}
                    {result()!.installed.length === 1
                      ? result()!.installed[0]!.name
                      : `${result()!.installed.length} extensions`}
                    . They run in the web tabs of every workspace.
                  </p>
                </Show>
                <For each={result()!.failed}>
                  {(f) => (
                    <p {...stylex.attrs(styles.text, styles.error)}>
                      {f.name}: {f.error}
                    </p>
                  )}
                </For>
                <div {...stylex.attrs(styles.actions)}>
                  <Button variant="primary" onClick={props.onClose}>
                    Done
                  </Button>
                </div>
              </div>
            }
          >
            <Show
              when={!profiles.loading}
              fallback={<p {...stylex.attrs(styles.text, styles.muted)}>Looking for browsers…</p>}
            >
              <Show
                when={sorted().length}
                fallback={
                  <div {...stylex.attrs(styles.body)}>
                    <p {...stylex.attrs(styles.text, styles.muted)}>
                      No browser with extensions was found (Chrome, Chromium, Brave, Edge or Vivaldi).
                    </p>
                    <div {...stylex.attrs(styles.actions)}>
                      <Button onClick={props.onClose}>Close</Button>
                    </div>
                  </div>
                }
              >
                <div {...stylex.attrs(styles.body)}>
                  <Show when={sorted().length > 1}>
                    <Select
                      value={profile()?.key}
                      onChange={(e) => setProfileKey(e.currentTarget.value)}
                      data-import-profile
                    >
                      <For each={sorted()}>{(p) => <option value={p.key}>{label(p)}</option>}</For>
                    </Select>
                  </Show>
                  <Show when={sorted().length === 1}>
                    <p {...stylex.attrs(styles.text, styles.muted)}>From {label(profile()!)}</p>
                  </Show>
                  <div {...stylex.attrs(styles.list)}>
                    <For each={profile()?.extensions ?? []}>
                      {(c) => (
                        <CandidateRow candidate={c} checked={picked().has(c.id)} onChange={(on) => toggle(c.id, on)} />
                      )}
                    </For>
                  </div>
                  <label {...stylex.attrs(styles.option)}>
                    <Checkbox
                      checked={settings()}
                      onChange={(e) => setSettings(e.currentTarget.checked)}
                      data-import-settings
                    />
                    <span>
                      Bring their settings too
                      <span {...stylex.attrs(styles.hint)}>
                        {anySettings()
                          ? "What the extensions saved there (preferences, sign-ins) comes along."
                          : "The picked extensions have no saved settings."}
                      </span>
                    </span>
                  </label>
                  <div {...stylex.attrs(styles.actions)}>
                    <Button onClick={props.onClose} disabled={busy()}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => void run()}
                      disabled={busy() || !picked().size}
                      data-import-run
                    >
                      {busy() ? "Importing…" : `Import ${picked().size || ""}`.trim()}
                    </Button>
                  </div>
                </div>
              </Show>
            </Show>
          </Show>
        </div>
      </div>
    </Portal>
  );
}

function CandidateRow(props: { candidate: ImportCandidate; checked: boolean; onChange: (on: boolean) => void }) {
  const c = () => props.candidate;
  const notes = () =>
    [
      c().installed ? "already in Rune Browser" : "",
      !c().enabledThere ? "off there" : "",
      c().unpacked ? "from a folder" : "",
      c().unsupported.length ? `may not fully work: ${c().unsupported.join(", ")}` : "",
    ].filter(Boolean);
  return (
    <label {...stylex.attrs(styles.candidate)} data-import-candidate={c().id}>
      <Checkbox checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      <Show when={c().icon} fallback={<Icon name="puzzle" size={20} {...stylex.attrs(styles.muted)} />}>
        <img src={c().icon!} alt="" width={20} height={20} />
      </Show>
      <span {...stylex.attrs(styles.candidateText)}>
        <span {...stylex.attrs(styles.name)}>
          {c().name} <span {...stylex.attrs(styles.muted)}>{c().version}</span>
        </span>
        <Show when={notes().length}>
          <span {...stylex.attrs(styles.hint)}>{notes().join(" · ")}</span>
        </Show>
      </span>
    </label>
  );
}

const styles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 2000,
    display: "grid",
    placeItems: "center",
    padding: space.xl,
    backgroundColor: "rgb(0 0 0 / 0.35)",
  },
  dialog: {
    width: "min(520px, 100%)",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: font.sans,
    boxShadow: "0 20px 50px rgb(0 0 0 / 0.25)",
  },
  title: { margin: 0, display: "flex", alignItems: "center", gap: space.sm, fontSize: font.lg, fontWeight: 650 },
  accent: { color: colors.accent },
  body: { display: "flex", flexDirection: "column", gap: space.md, minHeight: 0 },
  text: { margin: 0, fontSize: font.sm, lineHeight: 1.5 },
  muted: { color: colors.muted },
  error: { color: colors.danger },
  list: {
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    maxHeight: "45vh",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
  },
  candidate: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    cursor: "pointer",
  },
  candidateText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  name: { fontSize: font.sm, fontWeight: 500 },
  hint: { display: "block", color: colors.muted, fontSize: font.xs },
  option: { display: "flex", alignItems: "flex-start", gap: space.sm, fontSize: font.sm, cursor: "pointer" },
  actions: { display: "flex", justifyContent: "flex-end", gap: space.sm },
});
