// An extension's side panel (chrome.sidePanel): its page beside the workspace's tabs, on the right like
// Chrome's, until it's closed here, by the extension, or by its toolbar button. One per workspace.
import * as stylex from "@stylexjs/stylex";
import { onCleanup, Show } from "solid-js";
import { webPartition } from "../../shared/api";
import { closeSidePanel, extensionById, sidePanelOf, type SidePanel } from "../lib/extensions";
import { currentWorkspace, isPrivate } from "../lib/store";
import { PRIVATE_WORKSPACE } from "../../shared/api";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";

const workspaceHere = () => (isPrivate ? PRIVATE_WORKSPACE : currentWorkspace()?.id);

export function ExtensionSidePanel() {
  return (
    <Show when={sidePanelOf(workspaceHere())} keyed>
      {(panel) => <Panel panel={panel} />}
    </Show>
  );
}

function Panel(props: { panel: SidePanel }) {
  let view: Electron.WebviewTag | undefined;
  const icon = () => extensionById(props.panel.extensionId)?.icon ?? null;
  const attach = (v: Electron.WebviewTag) => {
    view = v;
    // window.close() in the panel's page.
    v.addEventListener("close", () => closeSidePanel(props.panel.workspaceId));
  };
  onCleanup(() => view?.remove());
  return (
    <aside
      {...stylex.attrs(styles.root)}
      aria-label={`${props.panel.name} side panel`}
      data-extension-side-panel={props.panel.extensionId}
    >
      <header {...stylex.attrs(styles.header)}>
        <Show when={icon()} fallback={<Icon name="puzzle" size={15} />}>
          {(src) => <img src={src()} alt="" width={16} height={16} {...stylex.attrs(styles.icon)} />}
        </Show>
        <span {...stylex.attrs(styles.name)}>{props.panel.name}</span>
        <button
          type="button"
          title="Close the side panel"
          aria-label="Close the side panel"
          onClick={() => closeSidePanel(props.panel.workspaceId)}
          {...stylex.attrs(styles.close)}
          data-close-side-panel
        >
          <Icon name="x" size={14} />
        </button>
      </header>
      <webview
        ref={attach}
        src={props.panel.url}
        partition={webPartition(props.panel.workspaceId)}
        {...stylex.attrs(styles.view)}
      />
    </aside>
  );
}

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    width: 360,
    minWidth: 0,
    marginBlock: space.sm,
    marginRight: space.sm,
    overflow: "hidden",
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    boxShadow: `0 0 0 1px ${colors.border}, 0 1px 3px rgb(0 0 0 / 0.06)`,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: 36,
    flexShrink: 0,
    paddingInline: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    color: colors.muted,
    fontFamily: font.sans,
    fontSize: font.sm,
  },
  icon: { display: "block", objectFit: "contain", flexShrink: 0 },
  name: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.text,
    fontWeight: 500,
  },
  close: {
    display: "grid",
    placeItems: "center",
    width: 26,
    height: 26,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  view: { display: "flex", flex: 1, minHeight: 0, backgroundColor: colors.surface },
});
