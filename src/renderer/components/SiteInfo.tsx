// The site controls of a web tab, from its address bar (like Chrome's site
// information): what the site may use and do, its zoom, its cookies, and a
// link to its page in Settings → Browser → Site settings.
import * as stylex from "@stylexjs/stylex";
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { inheritedLabel, siteSettingKeys, siteSettings, type SiteDecision } from "../../shared/browser";
import { setSiteSetting, showSite } from "../lib/browser";
import { settings } from "../lib/settings";
import { openSettings } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";

export function SiteInfoPopover(props: {
  site: string;
  workspaceId: string;
  position: { x: number; y: number };
  onReload: () => void;
  onClose: () => void;
}) {
  let panel!: HTMLDivElement;
  const [pos, setPos] = createSignal(props.position);
  // Settings change on the next load: a reload button shows once something did.
  const [changed, setChanged] = createSignal(false);
  const [data, { refetch }] = createResource(() => window.rune.browser.siteData(props.workspaceId));
  const cookies = () => data()?.find((d) => d.site === props.site)?.cookies ?? 0;
  const own = () => settings().browser.sites[props.site] ?? {};
  const zoom = () => settings().browser.zoom.sites[props.site];

  onMount(() => {
    const rect = panel.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(props.position.x, window.innerWidth - rect.width - 8)), y: props.position.y });
    const onPointer = (e: PointerEvent) => {
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

  const deleteData = async () => {
    if (
      !(await confirmDialog(`Delete the cookies and data of ${props.site} in this workspace? It signs you out there.`, {
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    await window.rune.browser.clearSite([props.workspaceId], props.site);
    await refetch();
    setChanged(true);
  };

  return (
    <Portal>
      <div
        ref={panel}
        {...stylex.attrs(styles.popover)}
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        data-site-info={props.site}
      >
        <div {...stylex.attrs(styles.header)}>
          <span {...stylex.attrs(styles.title)}>{props.site}</span>
          <button type="button" title="Close" onClick={props.onClose} {...stylex.attrs(styles.iconButton)}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div {...stylex.attrs(styles.list)}>
          <For each={siteSettingKeys}>
            {(key) => (
              <label {...stylex.attrs(styles.row)}>
                <Icon name={siteSettings[key].icon} size={14} {...stylex.attrs(styles.rowIcon)} />
                <span {...stylex.attrs(styles.rowLabel)}>{siteSettings[key].label}</span>
                <select
                  value={own()[key] ?? ""}
                  onChange={(e) => {
                    setSiteSetting(props.site, key, (e.currentTarget.value || undefined) as SiteDecision | undefined);
                    setChanged(true);
                  }}
                  {...stylex.attrs(styles.select)}
                  data-site-info-setting={key}
                >
                  <option value="">{inheritedLabel(settings().browser, props.site, key)}</option>
                  <option value="allow">Allow</option>
                  <option value="block">Block</option>
                </select>
              </label>
            )}
          </For>
          <div {...stylex.attrs(styles.row)}>
            <Icon name="cookie" size={14} {...stylex.attrs(styles.rowIcon)} />
            <span {...stylex.attrs(styles.rowLabel)}>
              Cookies and site data
              <span {...stylex.attrs(styles.rowMeta)}>
                {cookies() ? `${cookies()} cookie${cookies() === 1 ? "" : "s"}` : "No cookies"}
                {zoom() ? ` · Zoom ${Math.round(zoom()! * 100)}%` : ""}
              </span>
            </span>
            <button
              type="button"
              onClick={() => void deleteData()}
              {...stylex.attrs(styles.textButton, styles.danger)}
              data-site-info-delete
            >
              Delete
            </button>
          </div>
        </div>
        <div {...stylex.attrs(styles.footer)}>
          <button
            type="button"
            onClick={() => {
              showSite(props.site);
              props.onClose();
              void openSettings("browser-sites");
            }}
            {...stylex.attrs(styles.textButton)}
            data-site-info-settings
          >
            Site settings
          </button>
          <Show when={changed()}>
            <button
              type="button"
              onClick={() => {
                props.onReload();
                setChanged(false);
              }}
              {...stylex.attrs(styles.reload)}
              data-site-info-reload
            >
              <Icon name="rotate-cw" size={13} /> Reload to apply
            </button>
          </Show>
        </div>
      </div>
    </Portal>
  );
}

const styles = stylex.create({
  popover: {
    position: "fixed",
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    width: 320,
    maxHeight: 480,
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
  title: { flex: 1, minWidth: 0, overflowWrap: "anywhere", fontSize: font.sm, fontWeight: 600 },
  list: { display: "flex", flexDirection: "column", overflowY: "auto", paddingInline: 6, paddingBottom: 4 },
  row: { display: "flex", alignItems: "center", gap: space.sm, minHeight: 32, paddingInline: 6 },
  rowIcon: { flexShrink: 0, color: colors.muted },
  rowLabel: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
  rowMeta: { color: colors.muted, fontSize: 11 },
  select: {
    width: 120,
    height: 26,
    paddingInline: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.xs,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    paddingBlock: 6,
    paddingInline: space.sm,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  textButton: {
    paddingBlock: 3,
    paddingInline: 6,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.accent,
    fontFamily: font.sans,
    fontSize: font.xs,
    fontWeight: 500,
    cursor: "pointer",
  },
  danger: { color: colors.danger },
  reload: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    height: 26,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    color: colors.accentText,
    fontFamily: font.sans,
    fontSize: font.xs,
    fontWeight: 500,
    cursor: "pointer",
  },
  iconButton: {
    display: "grid",
    placeItems: "center",
    width: 24,
    height: 24,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: "pointer",
  },
});
