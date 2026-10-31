import * as stylex from "@stylexjs/stylex";
import { createEffect, For, Match, on, onMount, Show, Switch } from "solid-js";
import { AgentSidebar } from "./components/AgentSidebar";
import { AppTab } from "./components/AppTab";
import { CommandBar } from "./components/CommandBar";
import { AuthHost } from "./components/AuthDialog";
import { ConfirmHost } from "./components/ConfirmDialog";
import { ExtensionImportHost } from "./components/ExtensionImport";
import { PermissionHost } from "./components/PermissionHost";
import { ModReviewHost } from "./components/ModsPage";
import { SettingsShell } from "./components/SettingsPage";
import { paneStyle, SplitChrome, SplitDropZones } from "./components/SplitView";
import { visibleSplit, visibleTabs } from "./lib/splits";
import { Sidebar } from "./components/Sidebar";
import { ToastHost } from "./components/Toast";
import { Button } from "./components/ui";
import { WebTab } from "./components/WebTab";
import "./lib/schedules";
import "./lib/updates";
import { startUnloading } from "./lib/unload";
import { startWindowChrome } from "./lib/windowChrome";
import { startShortcuts } from "./lib/shortcuts";
import { loadSettings } from "./lib/settings";
import { Icon } from "./components/Icon";
import { dropTarget, hasFiles, openDropped, setDropTarget } from "./lib/drops";
import {
  appById,
  currentWorkspace,
  HISTORY_VIEW,
  isSettingsView,
  selectApp,
  loadApps,
  openTab,
  loadProviders,
  newApp,
  newWebTab,
  openTabs,
  selectedId,
  workspaceTabs,
} from "./lib/store";
import { colors, font, radius, space } from "./theme.stylex";

export default function App() {
  onMount(async () => {
    startUnloading();
    startWindowChrome();
    startShortcuts();
    await loadSettings().catch((err) => console.error("Loading settings failed:", err));
    void loadProviders().catch((err) => console.error("Loading providers failed:", err));
    await loadApps();
  });

  const isSelected = (id: string) => selectedId() === id;

  // Every tab of the split on screen is shown, not only the one selected.
  createEffect(() => {
    for (const id of visibleTabs()) void openTab(id).catch(() => {});
  });

  // Focus left in another pane of a split would keep a click there from focusing its tab again.
  createEffect(
    on(selectedId, (id) => {
      const active = document.activeElement as HTMLElement | null;
      const layer = active?.closest<HTMLElement>("[data-tab-layer]");
      if (layer && layer.dataset.tabLayer !== id) active!.blur();
    }),
  );

  const split = () => !!visibleSplit();

  // Files dropped on the window (not on a page, which takes them itself) open in new tabs; on a
  // blank web tab, the first opens there. Fields and the composer handle their own drops.
  const blankTab = () => {
    const tab = appById(selectedId());
    return tab?.kind === "web" && !tab.url ? tab.id : undefined;
  };
  const onDragOver = (e: DragEvent) => {
    if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
    setDropTarget({ kind: "window", tabId: blankTab() });
  };
  const onDrop = (e: DragEvent) => {
    if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    const target = dropTarget();
    setDropTarget(null);
    openDropped(e.dataTransfer!, target?.kind === "window" ? { tabId: target.tabId } : {});
  };
  const windowDrop = () => {
    const target = dropTarget();
    return target?.kind === "window" ? target : null;
  };

  return (
    <div {...stylex.attrs(styles.root)} onDragOver={onDragOver} onDrop={onDrop} data-app-root>
      <Sidebar />
      <ConfirmHost />
      <AuthHost />
      <ExtensionImportHost />
      <PermissionHost />
      <ModReviewHost />
      <CommandBar />
      <ToastHost />
      <div {...stylex.attrs(styles.column)}>
        <Show when={window.rune.safeMode}>
          <div role="status" {...stylex.attrs(styles.safeMode)} data-safe-mode data-titlebar>
            <Icon name="life-buoy" size={16} />
            <span {...stylex.attrs(styles.safeModeText)}>
              <strong>Safe mode.</strong> Your theme and site customizations are off. Undo what broke things in History,
              then restart normally.
            </span>
            <button type="button" onClick={() => void selectApp(HISTORY_VIEW)} {...stylex.attrs(styles.safeModeButton)}>
              Open History
            </button>
            <button type="button" onClick={() => window.rune.relaunch(false)} {...stylex.attrs(styles.safeModeButton)}>
              Restart normally
            </button>
          </div>
        </Show>
        {/* The page, inset from the window and the sidebars with rounded corners (like Zen Browser);
            in a split view each pane is a card of its own. */}
        <div {...stylex.attrs(styles.content, split() && styles.contentSplit)} data-content>
          <Switch
            fallback={
              <div {...stylex.attrs(styles.empty)}>
                <p>
                  {workspaceTabs().length
                    ? "Select a tab"
                    : `Nothing in ${currentWorkspace()?.name ?? "this workspace"} yet`}
                </p>
                <div {...stylex.attrs(styles.emptyActions)}>
                  <Button variant="primary" onClick={() => newApp()}>
                    + New app
                  </Button>
                  <Button onClick={() => newWebTab()}>+ New web tab</Button>
                </div>
              </div>
            }
          >
            <Match when={isSettingsView(selectedId())}>
              <SettingsShell view={selectedId()!} />
            </Match>
            <Match when={openTabs().some((t) => t.id === selectedId())}>{null}</Match>
          </Switch>
          {/* Tabs stay mounted (hidden) so pages and previews keep their state between visits.
              In a split view, its tabs' layers are placed side by side. */}
          <For each={openTabs()}>
            {(tab) => {
              const inBackground = () => !isSelected(tab.id) && !paneStyle(tab.id);
              const inPane = () => !!paneStyle(tab.id);
              const focus = () => {
                if (!isSelected(tab.id)) void selectApp(tab.id);
              };
              return (
                <div
                  {...stylex.attrs(styles.layer, inPane() && styles.pane, inBackground() && styles.hidden)}
                  style={paneStyle(tab.id)}
                  // Clicking into a pane (its page included: the webview takes the focus) focuses its tab.
                  onPointerDown={focus}
                  onFocusIn={focus}
                  data-tab-layer={tab.id}
                >
                  <Show when={tab.kind === "web"} fallback={<AppTab appId={tab.id} active={isSelected(tab.id)} />}>
                    <WebTab appId={tab.id} active={isSelected(tab.id)} />
                  </Show>
                </div>
              );
            }}
          </For>
          <SplitChrome />
          <SplitDropZones />
          <Show when={windowDrop()}>
            {(target) => (
              <div {...stylex.attrs(styles.dropOverlay)} data-drop-overlay>
                <div {...stylex.attrs(styles.dropCard)}>
                  <span {...stylex.attrs(styles.dropIcon)}>
                    <Icon name="file-down" size={22} />
                  </span>
                  <span {...stylex.attrs(styles.dropTitle)}>
                    {target().tabId ? "Drop to open it here" : "Drop to open in a new tab"}
                  </span>
                  <span {...stylex.attrs(styles.dropHint)}>
                    PDFs, images, video, audio and text open in Rune; other files are downloaded.
                  </span>
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>
      <AgentSidebar />
    </div>
  );
}

const styles = stylex.create({
  root: {
    display: "flex",
    height: "100%",
    fontFamily: font.sans,
    fontSize: font.md,
    color: colors.text,
    // The frame around the page: the sidebars' color.
    backgroundColor: colors.sidebar,
  },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    paddingBlock: space.sm,
    paddingRight: space.sm,
  },
  // Pages scroll vertically; nothing in it should ever scroll the whole area sideways.
  content: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflowX: "hidden",
    overflowY: "auto",
    // A thin scrollbar on a clear track, inside the rounded corners.
    scrollbarWidth: "thin",
    scrollbarColor: "rgb(127 127 127 / 0.45) transparent",
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    boxShadow: `0 0 0 1px ${colors.border}, 0 1px 3px rgb(0 0 0 / 0.06)`,
  },
  // The panes are the cards; the gaps between them show the frame.
  contentSplit: { backgroundColor: "transparent", boxShadow: "none" },
  // Plain colors on purpose: it must stay readable whatever the theme did.
  safeMode: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    paddingBlock: 8,
    paddingInline: 14,
    borderRadius: radius.md,
    backgroundColor: "#fef3c7",
    color: "#422006",
    fontSize: 13,
    flexShrink: 0,
  },
  safeModeText: { flex: 1 },
  safeModeButton: {
    paddingBlock: 4,
    paddingInline: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "#b45309",
    borderRadius: 6,
    backgroundColor: "#fffbeb",
    color: "#422006",
    fontSize: 12,
    cursor: "pointer",
  },
  layer: {
    position: "absolute",
    inset: 0,
    zIndex: 1,
    overflow: "hidden",
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
  pane: { boxShadow: `0 0 0 1px ${colors.border}, 0 1px 3px rgb(0 0 0 / 0.06)` },
  // Not display:none: webviews must keep their size to stay rendered.
  hidden: { visibility: "hidden", pointerEvents: "none", zIndex: 0 },
  // Where dropped files open: over the page area, never in the way of the drop itself.
  dropOverlay: {
    position: "absolute",
    inset: space.sm,
    zIndex: 60,
    display: "grid",
    placeItems: "center",
    borderRadius: radius.md,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: colors.accent,
    backgroundColor: `color-mix(in srgb, ${colors.bg} 60%, transparent)`,
    backdropFilter: "blur(2px)",
    pointerEvents: "none",
  },
  dropCard: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    maxWidth: 320,
    paddingBlock: space.lg,
    paddingInline: space.xl,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    boxShadow: `0 0 0 1px ${colors.border}, 0 12px 32px rgb(0 0 0 / 0.18)`,
    textAlign: "center",
  },
  dropIcon: {
    display: "grid",
    placeItems: "center",
    width: 44,
    height: 44,
    marginBottom: 4,
    borderRadius: 999,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  dropTitle: { fontSize: font.md, fontWeight: 600, color: colors.text },
  dropHint: { fontSize: font.sm, color: colors.muted, lineHeight: 1.4 },
  emptyActions: { display: "flex", gap: space.sm },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    height: "100%",
    color: colors.muted,
  },
});
