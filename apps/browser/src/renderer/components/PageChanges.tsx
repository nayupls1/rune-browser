// Page changes in the UI: the popover a web tab opens from its address bar
// (every change active on the page, each with an on/off switch and remove)
// and the list in Settings.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { PageChange, PageChangeAction, PageChangeSpec, PageScope } from "../../shared/api";
import { hostOf, pageKey, scopeLabel, scopeMatches } from "../../shared/web";
import { api } from "../lib/api";
import { modName } from "../lib/mods";
import { cachedOverride, pageChanges } from "../lib/webtabs";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";

const actionIcons: Record<PageChangeAction, string> = {
  hide: "eye-off",
  style: "paintbrush",
  text: "type",
  attribute: "tag",
  insert: "square-plus",
  button: "mouse-pointer-click",
  css: "file-code",
  script: "braces",
};

/** The changes whose scope covers a URL (on or off). */
export const changesFor = (url: string) => pageChanges().filter((c) => scopeMatches(c.scope, url));

function Switch(props: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.checked ? "On: click to turn off" : "Off: click to turn on"}
      onClick={() => props.onChange(!props.checked)}
      {...stylex.attrs(styles.switch, props.checked && styles.switchOn)}
    >
      <span {...stylex.attrs(styles.knob, props.checked && styles.knobOn)} />
    </button>
  );
}

async function removeChange(change: PageChange) {
  if (
    await confirmDialog(`Remove “${change.title}”? It can be brought back from History.`, {
      confirmLabel: "Remove",
      danger: true,
    })
  ) {
    await api.deletePageChange(change.id);
  }
}

/** The host a scope is about (patterns: when they name one). */
const hostOfScope = (scope: PageScope) =>
  scope.type === "page"
    ? scope.value.split("/")[0]!
    : scope.type === "site"
      ? scope.value
      : (/^(?:\*\.)?([\w.-]+\.[a-z]{2,})(?:\/|$)/i.exec(scope.value)?.[1] ?? null);

/** Where else a change could apply: one page, its whole site, or the site with its subdomains. */
function scopeChoices(change: PageChange, url?: string): { label: string; scope: PageScope }[] {
  const host = hostOfScope(change.scope);
  if (!host) return [];
  const page = change.scope.type === "page" ? change.scope.value : url && hostOf(url) === host ? pageKey(url) : null;
  return [
    ...(page ? [{ label: "Only this page", scope: { type: "page" as const, value: page } }] : []),
    { label: `All of ${host}`, scope: { type: "site", value: host } },
    { label: `${host} and its subdomains`, scope: { type: "pattern", value: `*.${host}/*` } },
  ];
}

/** Moves a change to another scope. */
const rescope = (change: PageChange, scope: PageScope) => {
  const spec: PageChangeSpec = { title: change.title, scope, action: change.action };
  for (const key of ["selector", "value", "name", "position", "onClick"] as const)
    if (change[key] !== undefined) Object.assign(spec, { [key]: change[key] });
  return api.updatePageChange(change.id, { change: spec });
};

/** One change: what it does, where (click to change it), its switch and remove. */
function ChangeRow(props: { change: PageChange; url?: string; error?: string }) {
  const detail = () => [props.change.action, props.change.selector].filter(Boolean).join(" ");
  const [scopeMenu, setScopeMenu] = createSignal<MenuPosition>();
  const choices = () =>
    scopeChoices(props.change, props.url).map((c): MenuItem => ({
      label: c.label,
      checked: c.scope.type === props.change.scope.type && c.scope.value === props.change.scope.value,
      onSelect: () => void rescope(props.change, c.scope),
    }));
  return (
    <div
      {...stylex.attrs(styles.row)}
      data-page-change={props.change.id}
      data-enabled={props.change.enabled ? "on" : "off"}
    >
      <Icon name={actionIcons[props.change.action]} size={14} {...stylex.attrs(styles.rowIcon)} />
      <div {...stylex.attrs(styles.rowText)}>
        <span {...stylex.attrs(styles.rowTitle)}>{props.change.title}</span>
        <span {...stylex.attrs(styles.rowMeta)} title={detail()}>
          <button
            type="button"
            title="Where it applies: click to change"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setScopeMenu({ x: r.left, y: r.bottom + 4 });
            }}
            {...stylex.attrs(styles.scopeButton)}
            data-page-change-scope
          >
            {scopeLabel(props.change.scope, props.url)}
            <Icon name="chevron-down" size={11} />
          </button>{" "}
          · {detail()}
          {props.change.modId
            ? ` · from the mod ${modName(props.change.modId) ?? props.change.modId}`
            : props.change.createdBy === "agent"
              ? " · by the agent"
              : ""}
        </span>
        <Show when={props.error}>
          <span {...stylex.attrs(styles.rowError)} data-page-change-error>
            {props.error}
          </span>
        </Show>
      </div>
      <Show when={scopeMenu() && choices().length}>
        <ContextMenu items={choices()} position={scopeMenu()!} onClose={() => setScopeMenu()} />
      </Show>
      <Switch
        checked={props.change.enabled}
        label={`${props.change.title} on`}
        onChange={(enabled) => void api.updatePageChange(props.change.id, { enabled })}
      />
      <button
        type="button"
        title="Remove"
        onClick={() => void removeChange(props.change)}
        {...stylex.attrs(styles.iconButton)}
        data-remove-page-change
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
}

/** What's changed on the page open in a web tab. */
export function PageChangesPopover(props: {
  url: string;
  errors: Record<string, string>;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  let panel!: HTMLDivElement;
  const host = () => hostOf(props.url);
  const override = () => cachedOverride(host());
  const customized = () => !!override() && (override()!.css.trim() !== "" || override()!.js.trim() !== "");
  const changes = () => changesFor(props.url);
  const [pos, setPos] = createSignal(props.position);

  onMount(() => {
    const rect = panel.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(props.position.x, window.innerWidth - rect.width - 8)), y: props.position.y });
    const onPointer = (e: PointerEvent) => {
      // The confirm dialog is outside the panel but part of it.
      if (!panel.contains(e.target as Node) && !(e.target as Element).closest?.("[data-confirm-dialog]"))
        props.onClose();
    };
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && !document.querySelector("[data-confirm-dialog]") && props.onClose();
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  return (
    <Portal>
      <div
        ref={panel}
        {...stylex.attrs(styles.popover)}
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        data-page-changes
        data-url={props.url}
      >
        <div {...stylex.attrs(styles.header)}>
          <span {...stylex.attrs(styles.title)}>Changes on this page</span>
          <button type="button" title="Close" onClick={props.onClose} {...stylex.attrs(styles.iconButton)}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div {...stylex.attrs(styles.list)}>
          <Show when={customized()}>
            <div {...stylex.attrs(styles.row)} data-site-override>
              <Icon name="code" size={14} {...stylex.attrs(styles.rowIcon)} />
              <div {...stylex.attrs(styles.rowText)}>
                <span {...stylex.attrs(styles.rowTitle)}>Custom CSS and JavaScript</span>
                <span {...stylex.attrs(styles.rowMeta)}>All of {host()} · the site's customization</span>
              </div>
              <Switch
                checked={override()!.enabled}
                label="Site customization on"
                onChange={(enabled) => void api.saveSite(host(), { enabled })}
              />
              <button
                type="button"
                title="Remove"
                onClick={async () => {
                  if (
                    await confirmDialog(`Remove the custom CSS and JavaScript of ${host()}?`, {
                      confirmLabel: "Remove",
                      danger: true,
                    })
                  )
                    await api.deleteSite(host());
                }}
                {...stylex.attrs(styles.iconButton)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </Show>
          <For each={changes()}>
            {(change) => <ChangeRow change={change} url={props.url} error={props.errors[change.id]} />}
          </For>
          <Show when={!customized() && !changes().length}>
            <p {...stylex.attrs(styles.empty)}>Nothing is changed here anymore.</p>
          </Show>
        </div>
        <p {...stylex.attrs(styles.footer)}>
          Ask the agent to hide, change or add things; every page change is listed in Settings.
        </p>
      </div>
    </Portal>
  );
}

/** Every page change, for Settings. */
export function PageChangeRows() {
  return (
    <Show
      when={pageChanges().length}
      fallback={
        <p {...stylex.attrs(styles.empty)}>
          No page changes yet. Ask the website agent to hide, change or add something on a page.
        </p>
      }
    >
      <div {...stylex.attrs(styles.settingsList)}>
        <For each={pageChanges()}>{(change) => <ChangeRow change={change} />}</For>
      </div>
    </Show>
  );
}

const styles = stylex.create({
  popover: {
    position: "fixed",
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    width: 360,
    maxHeight: 420,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 12px 32px rgba(0, 0, 0, 0.18)",
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.sm,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: 6,
    paddingLeft: space.md,
    paddingRight: 6,
  },
  title: { flex: 1, fontSize: font.xs, fontWeight: 600, color: colors.muted },
  list: { display: "flex", flexDirection: "column", overflowY: "auto", paddingInline: 6 },
  settingsList: { display: "flex", flexDirection: "column", gap: 2 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: 6,
    paddingInline: 6,
    borderRadius: radius.sm,
  },
  rowIcon: { flexShrink: 0, color: colors.accent },
  rowText: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  rowTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: font.sm },
  rowMeta: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.muted, fontSize: 11 },
  rowError: { color: colors.danger, fontSize: 11 },
  scopeButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: colors.muted, ":hover": colors.accent },
    fontFamily: "inherit",
    fontSize: "inherit",
    cursor: "pointer",
  },
  empty: { margin: 0, padding: space.sm, color: colors.muted, fontSize: font.xs },
  footer: {
    margin: 0,
    paddingBlock: space.sm,
    paddingInline: space.md,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    color: colors.muted,
    fontSize: 11,
  },
  iconButton: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 26,
    height: 26,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  switch: {
    position: "relative",
    flexShrink: 0,
    width: 30,
    height: 18,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.full,
    backgroundColor: colors.border,
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: "120ms",
  },
  switchOn: { backgroundColor: colors.accent },
  knob: {
    position: "absolute",
    top: 2,
    left: 2,
    width: 14,
    height: 14,
    borderRadius: radius.full,
    backgroundColor: "#fff",
    transitionProperty: "transform",
    transitionDuration: "120ms",
  },
  knobOn: { transform: "translateX(12px)" },
});
