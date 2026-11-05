// Mods: customizations packaged to share (shared/mods.ts). Install one from a
// share code, a link or a file (always after the review), browse the gallery,
// turn installed mods off or remove them, and make a mod from your own page
// changes, theme and extensions.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { ExtensionInfo } from "../../shared/extensions";
import type { Mod } from "../../shared/mods";
import { api } from "../lib/api";
import {
  closeModReview,
  copyShareCode,
  installedMods,
  installReviewed,
  pendingModReview,
  removeMod,
  reviewMod,
  saveModFile,
  setModEnabled,
  sourceOf,
} from "../lib/mods";
import { settings, updateSettings } from "../lib/settings";
import { pageChanges } from "../lib/webtabs";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { toast } from "./Toast";
import { Button } from "./ui";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function ModsPage() {
  const [tab, setTab] = createSignal<"installed" | "gallery" | "create">("installed");
  // A mod just installed (from the box, the gallery or Ctrl+K) shows up in the list.
  createEffect(
    on(
      () => installedMods().length,
      (count, before) => {
        if (before !== undefined && count > before) setTab("installed");
      },
    ),
  );
  return (
    <div {...stylex.attrs(styles.page)} data-mods>
      <header {...stylex.attrs(styles.header)}>
        <h1 {...stylex.attrs(styles.title)}>Mods</h1>
        <p {...stylex.attrs(styles.muted)}>
          Customizations of websites and of Rune Browser, packaged to share: page changes, a theme, extensions. You see
          what a mod changes before installing it, and turning it off or removing it takes all of that back.
        </p>
      </header>
      <InstallBox />
      <div role="tablist" {...stylex.attrs(styles.tabs)}>
        <For
          each={
            [
              ["installed", "Installed"],
              ["gallery", "Gallery"],
              ["create", "Make a mod"],
            ] as const
          }
        >
          {([id, label]) => {
            const on = () => tab() === id;
            return (
              <button
                type="button"
                role="tab"
                aria-selected={on()}
                onClick={() => setTab(id)}
                {...stylex.attrs(styles.tab, on() && styles.tabOn)}
                data-mods-tab={id}
              >
                {label}
                <Show when={id === "installed" && installedMods().length}>
                  <span {...stylex.attrs(styles.count)}>{installedMods().length}</span>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
      <Show when={tab() === "installed"}>
        <Installed />
      </Show>
      <Show when={tab() === "gallery"}>
        <Gallery />
      </Show>
      <Show when={tab() === "create"}>
        <Create onCreated={() => setTab("installed")} />
      </Show>
    </div>
  );
}

/** Paste a share code or a link, or open a file: shows the review. */
function InstallBox() {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let file!: HTMLInputElement;
  const review = async (run: () => Promise<void>) => {
    setError();
    setBusy(true);
    try {
      await run();
      setText("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section {...stylex.attrs(styles.card)}>
      <h2 {...stylex.attrs(styles.sectionTitle)}>Install a mod</h2>
      <div {...stylex.attrs(styles.row)}>
        <input
          value={text()}
          placeholder="Paste a share code (RUNE-MOD:…) or a link to a mod"
          spellcheck={false}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && text().trim() && void review(() => reviewMod(sourceOf(text())))}
          {...stylex.attrs(styles.input)}
          data-mod-input
        />
        <Button
          variant="primary"
          disabled={busy() || !text().trim()}
          onClick={() => void review(() => reviewMod(sourceOf(text())))}
          data-mod-review
        >
          {busy() ? "Reading…" : "Review"}
        </Button>
        <Button disabled={busy()} onClick={() => file.click()}>
          Open a file…
        </Button>
        <input
          ref={file}
          type="file"
          accept=".json,.runemod,application/json"
          hidden
          onChange={(e) => {
            const chosen = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (chosen) void review(async () => reviewMod(sourceOf(await chosen.text()), "file"));
          }}
        />
      </div>
      <Show when={error()}>
        <p {...stylex.attrs(styles.error)}>{error()}</p>
      </Show>
    </section>
  );
}

function Installed() {
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      toast({ message: errorText(err), kind: "error" });
    }
  };
  return (
    <div {...stylex.attrs(styles.list)}>
      <For
        each={installedMods()}
        fallback={
          <p {...stylex.attrs(styles.empty)}>
            No mods yet. Try one from the gallery, or install one someone shared with you.
          </p>
        }
      >
        {(m) => (
          <div {...stylex.attrs(styles.item)} data-mod={m.mod.id} data-enabled={m.enabled ? "yes" : "no"}>
            <Icon
              name={m.mod.theme && !m.mod.pageChanges.length ? "palette" : "puzzle"}
              size={18}
              {...stylex.attrs(styles.itemIcon)}
            />
            <div {...stylex.attrs(styles.itemText)}>
              <span {...stylex.attrs(styles.itemTitle)}>
                {m.mod.name}
                <span {...stylex.attrs(styles.badge)}>v{m.mod.modVersion}</span>
              </span>
              <span {...stylex.attrs(styles.meta)}>
                by {m.mod.author} · {summary(m.mod)} · from{" "}
                {m.source === "you" ? "you" : m.source.startsWith("http") ? new URL(m.source).host : m.source}
              </span>
              <Show when={m.mod.description}>
                <span {...stylex.attrs(styles.meta)}>{m.mod.description}</span>
              </Show>
            </div>
            <button
              type="button"
              title="Copy its share code"
              onClick={() =>
                void act(
                  async () => (
                    await copyShareCode(m.mod),
                    toast({ message: `Copied the share code of ${m.mod.name}`, kind: "success" })
                  ),
                )
              }
              {...stylex.attrs(styles.iconButton)}
              data-mod-share
            >
              <Icon name="share-2" size={15} />
            </button>
            <button
              type="button"
              title="Save as a file"
              onClick={() => saveModFile(m.mod)}
              {...stylex.attrs(styles.iconButton)}
            >
              <Icon name="download" size={15} />
            </button>
            <Toggle
              checked={m.enabled}
              label={m.enabled ? "Turn off" : "Turn on"}
              onChange={(on) => void act(() => setModEnabled(m.mod.id, on))}
            />
            <button
              type="button"
              title="Remove"
              onClick={() =>
                void act(async () => {
                  if (
                    await confirmDialog(`Remove ${m.mod.name}? Everything it changed goes back.`, {
                      confirmLabel: "Remove",
                      danger: true,
                    })
                  )
                    await removeMod(m.mod.id);
                })
              }
              {...stylex.attrs(styles.iconButton)}
              data-mod-remove
            >
              <Icon name="trash" size={15} />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

const summary = (mod: Mod) =>
  [
    mod.pageChanges.length ? `${mod.pageChanges.length} page change${mod.pageChanges.length === 1 ? "" : "s"}` : "",
    mod.theme ? "a theme" : "",
    mod.extensions.length ? `${mod.extensions.length} extension${mod.extensions.length === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");

function Gallery() {
  const [gallery, { refetch }] = createResource(() => api.modGallery());
  const [url, setUrl] = createSignal("");
  const installedIds = () => new Set(installedMods().map((m) => `${m.mod.id}@${m.mod.modVersion}`));
  const addGallery = () => {
    const value = url().trim();
    if (!/^https:\/\//i.test(value))
      return toast({ message: "A gallery is an https link to a JSON file that lists mods.", kind: "error" });
    updateSettings((s) => ({ ...s, mods: { galleries: [...new Set([...s.mods.galleries, value])] } }));
    setUrl("");
    setTimeout(() => void refetch(), 500);
  };
  return (
    <>
      <div {...stylex.attrs(styles.grid)}>
        <For each={gallery()?.entries ?? []}>
          {(entry) => (
            <div {...stylex.attrs(styles.galleryCard)} data-gallery-mod={entry.mod.id}>
              <span {...stylex.attrs(styles.itemTitle)}>{entry.mod.name}</span>
              <span {...stylex.attrs(styles.meta)}>
                by {entry.mod.author} · {summary(entry.mod)}
              </span>
              <p {...stylex.attrs(styles.galleryText)}>{entry.mod.description}</p>
              <div {...stylex.attrs(styles.row)}>
                <span {...stylex.attrs(styles.meta, styles.grow)}>
                  {entry.gallery === "Rune Browser" ? "From Rune Browser" : new URL(entry.gallery).host}
                </span>
                <Show
                  when={!installedIds().has(`${entry.mod.id}@${entry.mod.modVersion}`)}
                  fallback={<span {...stylex.attrs(styles.meta)}>Installed</span>}
                >
                  <Button
                    onClick={() =>
                      void reviewMod(
                        { mod: entry.mod },
                        entry.gallery === "Rune Browser" ? "gallery" : entry.gallery,
                      ).catch((err) => toast({ message: errorText(err), kind: "error" }))
                    }
                    data-gallery-install
                  >
                    Install…
                  </Button>
                </Show>
              </div>
            </div>
          )}
        </For>
      </div>
      <Show when={gallery()?.errors.length}>
        <For each={gallery()!.errors}>{(e) => <p {...stylex.attrs(styles.error)}>{`${e.gallery}: ${e.error}`}</p>}</For>
      </Show>
      <section {...stylex.attrs(styles.card)}>
        <h2 {...stylex.attrs(styles.sectionTitle)}>Galleries</h2>
        <p {...stylex.attrs(styles.muted)}>
          Mods made by others, from galleries you add: an https link to a JSON file that lists mods (
          <code>{'{ "mods": [ … ] }'}</code>). Rune Browser's examples are always here.
        </p>
        <For each={settings().mods.galleries}>
          {(g) => (
            <div {...stylex.attrs(styles.row)}>
              <span {...stylex.attrs(styles.meta, styles.grow)}>{g}</span>
              <button
                type="button"
                title="Remove this gallery"
                onClick={() => {
                  updateSettings((s) => ({ ...s, mods: { galleries: s.mods.galleries.filter((x) => x !== g) } }));
                  setTimeout(() => void refetch(), 500);
                }}
                {...stylex.attrs(styles.iconButton)}
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          )}
        </For>
        <div {...stylex.attrs(styles.row)}>
          <input
            value={url()}
            placeholder="https://example.com/mods.json"
            onInput={(e) => setUrl(e.currentTarget.value)}
            {...stylex.attrs(styles.input)}
          />
          <Button onClick={addGallery} disabled={!url().trim()}>
            Add gallery
          </Button>
        </div>
      </section>
    </>
  );
}

/** Make a mod from your own page changes, theme and Web Store extensions. */
function Create(props: { onCreated: () => void }) {
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [author, setAuthor] = createSignal("");
  const [chosen, setChosen] = createSignal<string[]>([]);
  const [theme, setTheme] = createSignal(false);
  const [extensions, setExtensions] = createSignal<string[]>([]);
  const [made, setMade] = createSignal<{ mod: Mod; code: string } | null>(null);
  const [error, setError] = createSignal<string>();
  const [available] = createResource(() =>
    window.rune.extensions
      .list()
      .then((r) => r.extensions.filter((e: ExtensionInfo) => e.source.kind !== "unpacked"))
      .catch(() => [] as ExtensionInfo[]),
  );
  // Your own changes (not ones that came with a mod).
  const own = () => pageChanges().filter((c) => !c.modId);
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const create = async () => {
    setError();
    try {
      const mod = await api.packageMod({
        name: name().trim(),
        description: description().trim(),
        author: author().trim(),
        pageChangeIds: chosen(),
        theme: theme(),
        extensions: (available() ?? [])
          .filter((e) => extensions().includes(e.id))
          .map((e) => ({ id: e.id, name: e.name })),
      });
      setMade({ mod, code: await copyShareCode(mod) });
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section {...stylex.attrs(styles.card)} data-mod-create>
      <Show
        when={made()}
        fallback={
          <>
            <div {...stylex.attrs(styles.fields)}>
              <input
                value={name()}
                placeholder="Name, e.g. Calm news sites"
                onInput={(e) => setName(e.currentTarget.value)}
                {...stylex.attrs(styles.input)}
                data-mod-name
              />
              <input
                value={author()}
                placeholder="Your name (shown as its author)"
                onInput={(e) => setAuthor(e.currentTarget.value)}
                {...stylex.attrs(styles.input)}
              />
              <textarea
                value={description()}
                placeholder="What it does"
                rows={2}
                onInput={(e) => setDescription(e.currentTarget.value)}
                {...stylex.attrs(styles.input, styles.textarea)}
              />
            </div>
            <h3 {...stylex.attrs(styles.subTitle)}>Page changes</h3>
            <div {...stylex.attrs(styles.choices)}>
              <For
                each={own()}
                fallback={
                  <p {...stylex.attrs(styles.muted)}>
                    You have no page changes of your own yet (the website agent makes them).
                  </p>
                }
              >
                {(c) => (
                  <label {...stylex.attrs(styles.choice)}>
                    <input
                      type="checkbox"
                      checked={chosen().includes(c.id)}
                      onChange={() => setChosen(toggle(chosen(), c.id))}
                      data-mod-change={c.id}
                    />
                    <span {...stylex.attrs(styles.grow)}>{c.title}</span>
                    <span {...stylex.attrs(styles.meta)}>{c.scope.value}</span>
                  </label>
                )}
              </For>
            </div>
            <h3 {...stylex.attrs(styles.subTitle)}>Rune Browser</h3>
            <label {...stylex.attrs(styles.choice)}>
              <input
                type="checkbox"
                checked={theme()}
                onChange={(e) => setTheme(e.currentTarget.checked)}
                data-mod-theme
              />
              <span>Your theme (colors, corners, font)</span>
            </label>
            <Show when={available()?.length}>
              <h3 {...stylex.attrs(styles.subTitle)}>Extensions</h3>
              <div {...stylex.attrs(styles.choices)}>
                <For each={available()}>
                  {(e) => (
                    <label {...stylex.attrs(styles.choice)}>
                      <input
                        type="checkbox"
                        checked={extensions().includes(e.id)}
                        onChange={() => setExtensions(toggle(extensions(), e.id))}
                      />
                      <span>{e.name}</span>
                    </label>
                  )}
                </For>
              </div>
              <p {...stylex.attrs(styles.muted)}>
                Extensions are shared by their Chrome Web Store id: installing the mod installs them from there (not
                their settings).
              </p>
            </Show>
            <Show when={error()}>
              <p {...stylex.attrs(styles.error)}>{error()}</p>
            </Show>
            <div {...stylex.attrs(styles.row)}>
              <Button
                variant="primary"
                disabled={!name().trim() || (!chosen().length && !theme() && !extensions().length)}
                onClick={() => void create()}
                data-mod-make
              >
                Make the mod
              </Button>
            </div>
          </>
        }
      >
        {(result) => (
          <div {...stylex.attrs(styles.fields)} data-mod-made={result().mod.id}>
            <p {...stylex.attrs(styles.itemTitle)}>
              <Icon name="circle-check" size={16} {...stylex.attrs(styles.accent)} /> {result().mod.name} is ready to
              share
            </p>
            <p {...stylex.attrs(styles.muted)}>
              Its share code is copied. Anyone with Rune Browser can paste it into Install a mod (or Ctrl+K) and review
              it before installing.
            </p>
            <textarea
              readOnly
              value={result().code}
              rows={3}
              {...stylex.attrs(styles.input, styles.textarea, styles.code)}
              data-mod-code
            />
            <div {...stylex.attrs(styles.row)}>
              <Button
                onClick={() =>
                  void copyShareCode(result().mod).then(() => toast({ message: "Copied", kind: "success" }))
                }
              >
                Copy again
              </Button>
              <Button onClick={() => saveModFile(result().mod)}>Save as a file</Button>
              <Button
                onClick={() => {
                  setMade(null);
                  setChosen([]);
                  props.onCreated();
                }}
              >
                Done
              </Button>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}

function Toggle(props: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      title={props.label}
      onClick={() => props.onChange(!props.checked)}
      {...stylex.attrs(styles.toggle, props.checked && styles.toggleOn)}
      data-mod-toggle
    >
      <span {...stylex.attrs(styles.knob, props.checked && styles.knobOn)} />
    </button>
  );
}

/** The review before installing a mod (mounted once at the app root). */
export function ModReviewHost() {
  return (
    <Show when={pendingModReview()} keyed>
      {(p) => <ReviewDialog review={p} />}
    </Show>
  );
}

function ReviewDialog(props: { review: NonNullable<ReturnType<typeof pendingModReview>> }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const mod = () => props.review.mod;
  const update = () => props.review.installed;
  const install = async () => {
    setBusy(true);
    setError();
    try {
      const failed = await installReviewed();
      toast({
        message: failed.length
          ? `Installed ${mod().name}, but not all its extensions: ${failed.join("; ")}`
          : `Installed ${mod().name}`,
        kind: failed.length ? "error" : "success",
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const levelIcon = { danger: "shield-alert", warning: "triangle-alert", info: "info" } as const;
  return (
    <Portal>
      <div {...stylex.attrs(styles.backdrop)} onKeyDown={(e) => e.key === "Escape" && closeModReview()}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="mod-review-title"
          {...stylex.attrs(styles.dialog)}
          data-mod-review-dialog={mod().id}
        >
          <div>
            <span {...stylex.attrs(styles.meta)}>
              by {mod().author} · v{mod().modVersion}
              {update() ? ` · updates the installed v${update()!.mod.modVersion}` : ""}
            </span>
            <h2 id="mod-review-title" {...stylex.attrs(styles.dialogTitle)}>
              Install {mod().name}?
            </h2>
            <Show when={mod().description}>
              <p {...stylex.attrs(styles.muted)}>{mod().description}</p>
            </Show>
          </div>
          <div {...stylex.attrs(styles.permissions)}>
            <For each={props.review.review.permissions}>
              {(p) => {
                const danger = () => p.level === "danger";
                const warning = () => p.level === "warning";
                return (
                  <p
                    {...stylex.attrs(
                      styles.permission,
                      danger() && styles.permissionDanger,
                      warning() && styles.permissionWarning,
                    )}
                    data-mod-permission={p.level}
                  >
                    <Icon name={levelIcon[p.level]} size={15} {...stylex.attrs(styles.permissionIcon)} />
                    <span>{p.text}</span>
                  </p>
                );
              }}
            </For>
          </div>
          <Show when={props.review.review.changes.length}>
            <details {...stylex.attrs(styles.details)}>
              <summary {...stylex.attrs(styles.summary)}>
                What it changes ({props.review.review.changes.length})
              </summary>
              <For each={props.review.review.changes}>
                {(c) => (
                  <div {...stylex.attrs(styles.change)}>
                    <span {...stylex.attrs(styles.itemTitle)}>{c.title}</span>
                    <span {...stylex.attrs(styles.meta)}>
                      {c.what} · {c.where}
                    </span>
                    <Show when={c.code}>
                      <pre {...stylex.attrs(styles.pre)}>{c.code}</pre>
                    </Show>
                  </div>
                )}
              </For>
            </details>
          </Show>
          <Show when={error()}>
            <p {...stylex.attrs(styles.error)}>{error()}</p>
          </Show>
          <div {...stylex.attrs(styles.actions)}>
            <Button onClick={closeModReview} data-mod-cancel>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy()} onClick={() => void install()} data-mod-install>
              {busy() ? "Installing…" : update() ? "Update" : "Install"}
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

const styles = stylex.create({
  page: {
    boxSizing: "border-box",
    maxWidth: 760,
    marginInline: "auto",
    paddingTop: 36,
    paddingInline: 40,
    paddingBottom: 96,
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  header: { display: "flex", flexDirection: "column", gap: space.xs },
  title: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    margin: 0,
    fontSize: 24,
    fontWeight: 650,
    letterSpacing: "-0.02em",
  },
  accent: { color: colors.accent },
  muted: { margin: 0, color: colors.muted, fontSize: font.sm, lineHeight: 1.5 },
  error: { margin: 0, color: colors.danger, fontSize: font.sm },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  sectionTitle: { margin: 0, fontSize: font.md, fontWeight: 600 },
  subTitle: { margin: 0, marginTop: space.sm, fontSize: font.sm, fontWeight: 600, color: colors.muted },
  row: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  grow: { flex: 1, minWidth: 0 },
  fields: { display: "flex", flexDirection: "column", gap: space.sm },
  input: {
    flex: 1,
    minWidth: 200,
    height: 34,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
    outline: "none",
  },
  textarea: { height: "auto", paddingBlock: space.xs, resize: "vertical" },
  code: { fontFamily: font.mono, fontSize: font.xs, wordBreak: "break-all" },
  tabs: { display: "flex", gap: 2, borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: colors.border },
  tab: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    paddingBlock: space.sm,
    paddingInline: space.md,
    marginBottom: -1,
    borderWidth: 0,
    borderBottomWidth: 2,
    borderBottomStyle: "solid",
    borderBottomColor: "transparent",
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.text },
    fontSize: font.sm,
    fontWeight: 500,
    cursor: "pointer",
  },
  tabOn: { color: colors.text, borderBottomColor: colors.accent },
  count: { paddingInline: 6, borderRadius: radius.full, backgroundColor: colors.surfaceHover, fontSize: 11 },
  list: {
    display: "flex",
    flexDirection: "column",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  empty: { margin: 0, padding: space.lg, color: colors.muted, textAlign: "center", fontSize: font.sm },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    paddingBlock: space.sm,
    paddingInline: space.lg,
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  itemIcon: { flexShrink: 0, color: colors.accent },
  itemText: { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  itemTitle: { display: "flex", alignItems: "center", gap: 6, margin: 0, fontSize: font.sm, fontWeight: 500 },
  meta: { color: colors.muted, fontSize: font.xs, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  badge: {
    paddingInline: 6,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceHover,
    color: colors.muted,
    fontSize: 11,
    fontWeight: 600,
  },
  iconButton: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 28,
    height: 28,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: space.md },
  galleryCard: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  galleryText: { flex: 1, margin: 0, marginBottom: space.xs, color: colors.text, fontSize: font.sm, lineHeight: 1.45 },
  choices: { display: "flex", flexDirection: "column", gap: 2 },
  choice: { display: "flex", alignItems: "center", gap: space.sm, minHeight: 28, fontSize: font.sm, cursor: "pointer" },
  toggle: {
    position: "relative",
    flexShrink: 0,
    width: 38,
    height: 22,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: "150ms",
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
    transitionProperty: "transform",
    transitionDuration: "150ms",
  },
  knobOn: { transform: "translateX(16px)" },
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
    width: "min(560px, 100%)",
    maxHeight: "calc(100vh - 64px)",
    overflowY: "auto",
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
  dialogTitle: { margin: 0, marginBlock: 2, fontSize: font.lg, fontWeight: 650 },
  permissions: { display: "flex", flexDirection: "column", gap: space.xs },
  permission: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.sm,
    margin: 0,
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    fontSize: font.sm,
    lineHeight: 1.45,
  },
  permissionIcon: { flexShrink: 0, marginTop: 2, color: colors.muted },
  permissionDanger: { backgroundColor: `color-mix(in oklab, transparent, ${colors.danger} 10%)`, color: colors.text },
  permissionWarning: { backgroundColor: `color-mix(in oklab, transparent, ${colors.warning} 12%)` },
  details: { fontSize: font.sm },
  summary: { cursor: "pointer", fontWeight: 500 },
  change: { display: "flex", flexDirection: "column", gap: 2, paddingBlock: space.xs, paddingLeft: space.sm },
  pre: {
    margin: 0,
    marginTop: 2,
    maxHeight: 160,
    overflow: "auto",
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    fontFamily: font.mono,
    fontSize: font.xs,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  actions: { display: "flex", justifyContent: "flex-end", gap: space.sm },
});
