// Bookmarks while browsing: the star in the address bar and its popover (also
// Ctrl+D), the bookmarks menu in the sidebar's top row, and the bookmarks bar
// above the page. The bookmarks page is BookmarksPage.tsx; the state is
// lib/bookmarks.ts.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { BAR_ID, OTHER_ID, type BookmarkNode } from "../../shared/bookmarks";
import {
  barFolder,
  bookmarkAllTabs,
  bookmarkById,
  bookmarkEditor,
  bookmarkFolders,
  bookmarkOf,
  bookmarkTab,
  canBookmark,
  editBookmark,
  faviconFor,
  isBookmarksBarShown,
  openAll,
  openBookmark,
  otherFolder,
  rememberFolder,
  removeBookmark,
  setBookmarkEditor,
  toggleBookmarksBar,
} from "../lib/bookmarks";
import { BOOKMARKS_VIEW, isTab, selectApp, selectedId, appById } from "../lib/store";
import { shortcutLabel, withKeys } from "../lib/shortcuts";
import { colors, font, radius, space } from "../theme.stylex";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";
import { Button, Input, Select } from "./ui";
import { openBookmarkImport } from "./BookmarksPage";
import { toast } from "./Toast";

/** A bookmark's icon: a folder, or the site's icon when a tab knows it. */
export function BookmarkIcon(props: { node: BookmarkNode; size?: number }) {
  const size = () => props.size ?? 14;
  const [broken, setBroken] = createSignal(false);
  const favicon = () => (props.node.url && !broken() ? faviconFor(props.node.url) : null);
  return (
    <Show
      when={props.node.url !== undefined}
      fallback={<Icon name="folder" size={size()} {...stylex.attrs(styles.icon)} />}
    >
      <Show
        when={favicon()}
        fallback={
          <Icon
            name={/^file:/i.test(props.node.url ?? "") ? "file" : "globe"}
            size={size()}
            {...stylex.attrs(styles.icon)}
          />
        }
      >
        {(src) => (
          <img
            src={src()}
            alt=""
            width={size()}
            height={size()}
            onError={() => setBroken(true)}
            {...stylex.attrs(styles.image)}
          />
        )}
      </Show>
    </Show>
  );
}

/** How a click on a bookmark opens it: Ctrl/Cmd or the middle button in a background tab, Shift in a new tab. */
const whereFor = (e: MouseEvent): "here" | "tab" | "background" =>
  e.button === 1 || e.ctrlKey || e.metaKey ? "background" : e.shiftKey ? "tab" : "here";

/** Right-click on a bookmark or folder: open, edit, delete. */
function itemMenu(node: BookmarkNode, onDone?: () => void): (MenuItem | "separator")[] {
  const items: (MenuItem | "separator")[] = node.url
    ? [
        { label: "Open in new tab", icon: "square-plus", onSelect: () => openBookmark(node, "tab") },
        { label: "Open in a background tab", icon: "layers", onSelect: () => openBookmark(node, "background") },
      ]
    : [
        {
          label: `Open all (${(node.children ?? []).filter((c) => c.url).length})`,
          icon: "square-stack",
          disabled: !(node.children ?? []).some((c) => c.url),
          onSelect: () => openAll(node),
        },
      ];
  const all: (MenuItem | "separator")[] = [
    ...items,
    "separator",
    { label: "Edit…", icon: "pencil", onSelect: () => setBookmarkEditor({ id: node.id, created: false }) },
    {
      label: "Delete",
      icon: "trash",
      danger: true,
      onSelect: () =>
        void removeBookmark(node.id).then(
          () => toast({ message: `Deleted “${node.title || node.url}”`, kind: "info" }),
          (err) => toast({ message: (err as Error).message, kind: "error" }),
        ),
    },
  ];
  // Whatever's picked, the menu it was opened from closes too.
  return all.map((item) =>
    item === "separator"
      ? item
      : {
          ...item,
          onSelect: () => {
            onDone?.();
            item.onSelect();
          },
        },
  );
}

// --- The star --------------------------------------------------------------------------------

/** In the address bar of a web tab: filled when the page is bookmarked; adds or edits the bookmark. */
export function BookmarkStar(props: { tabId: string; url: string }) {
  const bookmarked = () => !!bookmarkOf(props.url);
  return (
    <Show when={canBookmark(props.url)}>
      <button
        type="button"
        title={withKeys(bookmarked() ? "Edit bookmark" : "Bookmark this tab", "bookmark.page")}
        onClick={() => void bookmarkTab(props.tabId)}
        {...stylex.attrs(styles.star, bookmarked() && styles.starOn)}
        data-bookmark-star={bookmarked() ? "on" : "off"}
      >
        <Icon name="star" size={14} fill={bookmarked() ? "currentColor" : "none"} />
      </button>
    </Show>
  );
}

// --- The popover -----------------------------------------------------------------------------

/** Folders to pick from, indented, the folder itself and what's in it left out (a folder can't go into itself). */
function FolderOptions(props: { except?: string }) {
  const options = () => {
    const out: { id: string; label: string }[] = [];
    let skipBelow: number | null = null;
    for (const { node, depth } of bookmarkFolders()) {
      if (skipBelow !== null && depth > skipBelow) continue;
      skipBelow = null;
      if (node.id === props.except) {
        skipBelow = depth;
        continue;
      }
      out.push({ id: node.id, label: `${" ".repeat(depth)}${node.title || "(no name)"}` });
    }
    return out;
  };
  return <For each={options()}>{(o) => <option value={o.id}>{o.label}</option>}</For>;
}

/**
 * Under the star (Ctrl+D, the star, Edit… in a menu): the bookmark's name and folder,
 * changed right away, like Chrome's bubble; More… opens it on the bookmarks page.
 */
export function BookmarkEditor() {
  return (
    <Show when={bookmarkEditor()} keyed>
      {(state) => <EditorPopover id={state.id} created={state.created} />}
    </Show>
  );
}

function EditorPopover(props: { id: string; created: boolean }) {
  const node = () => bookmarkById(props.id);
  const original = bookmarkById(props.id);
  const [title, setTitle] = createSignal(original?.title ?? "");
  const [url, setUrl] = createSignal(original?.url ?? "");
  const [parent, setParent] = createSignal(original?.parentId ?? BAR_ID);
  const [error, setError] = createSignal<string>();
  let box!: HTMLDivElement;
  let nameInput!: HTMLInputElement;
  const isFolder = () => original?.url === undefined;

  // Under the star of the tab on screen, or else at the top of the window, right of the sidebar.
  const anchor = () => {
    const star = document.querySelector("[data-address-bar] [data-bookmark-star]");
    const rect = star?.getBoundingClientRect();
    return rect && rect.width ? { x: rect.right - 320, y: rect.bottom + 8 } : { x: 260, y: 60 };
  };
  const pos = anchor();
  const close = () => setBookmarkEditor(null);

  // It went away meanwhile (deleted elsewhere).
  createEffect(on(node, (n) => !n && close(), { defer: true }));

  const save = async () => {
    const n = node();
    if (!n) return close();
    try {
      const fields: { title?: string; url?: string; parentId?: string } = {};
      if (title() !== n.title) fields.title = title();
      if (!isFolder() && url().trim() !== n.url) fields.url = url().trim();
      if (parent() !== n.parentId) fields.parentId = parent();
      if (Object.keys(fields).length) await editBookmark(n.id, fields);
      if (fields.parentId) rememberFolder(fields.parentId);
      close();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async () => {
    close();
    await removeBookmark(props.id).catch((err) => toast({ message: (err as Error).message, kind: "error" }));
  };
  const more = () => {
    void save();
    setPageFocus(props.id);
    void selectApp(BOOKMARKS_VIEW);
  };

  onMount(() => {
    nameInput.focus();
    nameInput.select();
    const onPointer = (e: PointerEvent) => {
      if (!box.contains(e.target as Node)) void save();
    };
    document.addEventListener("pointerdown", onPointer, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPointer, true));
  });

  const heading = () =>
    isFolder() ? (props.created ? "Folder added" : "Edit folder") : props.created ? "Bookmark added" : "Edit bookmark";

  return (
    <Portal>
      <div
        ref={box}
        role="dialog"
        aria-label={heading()}
        {...stylex.attrs(styles.popover)}
        style={{ left: `${Math.max(8, pos.x)}px`, top: `${pos.y}px` }}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), void save());
        }}
        data-bookmark-editor={props.id}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          {...stylex.attrs(styles.form)}
        >
          <div {...stylex.attrs(styles.popoverTitle)}>
            <Icon name={isFolder() ? "folder" : "star"} size={15} fill={isFolder() ? "none" : "currentColor"} />
            {heading()}
          </div>
          <label {...stylex.attrs(styles.label)}>
            Name
            <Input
              ref={nameInput}
              value={title()}
              onInput={(e) => setTitle(e.currentTarget.value)}
              data-bookmark-name
            />
          </label>
          <Show when={!isFolder() && !props.created}>
            <label {...stylex.attrs(styles.label)}>
              Address
              <Input
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
                spellcheck={false}
                data-bookmark-url
              />
            </label>
          </Show>
          <label {...stylex.attrs(styles.label)}>
            Folder
            <Select value={parent()} onChange={(e) => setParent(e.currentTarget.value)} data-bookmark-folder>
              <FolderOptions except={isFolder() ? props.id : undefined} />
            </Select>
          </label>
          <Show when={error()}>
            <p {...stylex.attrs(styles.error)}>{error()}</p>
          </Show>
          <div {...stylex.attrs(styles.actions)}>
            <Button variant="ghost" onClick={() => void remove()} data-bookmark-remove>
              Remove
            </Button>
            <span {...stylex.attrs(styles.spacer)} />
            <Button onClick={more} data-bookmark-more>
              More…
            </Button>
            <Button type="submit" variant="primary" data-bookmark-done>
              Done
            </Button>
          </div>
        </form>
      </div>
    </Portal>
  );
}

/** The bookmarks page opens at this bookmark's folder, with it highlighted (More…). */
const [pageFocus, setPageFocus] = createSignal<string | null>(null);
export { pageFocus as bookmarksPageFocus, setPageFocus as setBookmarksPageFocus };

// --- Menus of folders ---------------------------------------------------------------------------

/**
 * A folder's bookmarks as a menu; folders open in it (with a way back), pages
 * open on click. `top` adds rows before the folder's (the bookmarks menu's commands).
 */
function FolderMenu(props: {
  folder: string;
  position: MenuPosition;
  onClose: () => void;
  top?: (MenuItem | "separator")[];
  bottom?: BookmarkNode[];
}) {
  const [path, setPath] = createSignal<string[]>([props.folder]);
  const current = () => bookmarkById(path()[path().length - 1]!) ?? bookmarkById(props.folder);
  const atStart = () => path().length === 1;
  const [menu, setMenu] = createSignal<{ node: BookmarkNode; at: MenuPosition }>();
  let box!: HTMLDivElement;
  const [pos, setPos] = createSignal(props.position);

  onMount(() => {
    const rect = box.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(props.position.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(props.position.y, window.innerHeight - rect.height - 4)),
    });
    const onPointer = (e: PointerEvent) => {
      if (!box.contains(e.target as Node) && !(e.target as Element).closest?.("[data-context-menu]")) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !menu()) props.onClose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", props.onClose);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", props.onClose);
    });
  });

  const Row = (p: { node: BookmarkNode }) => (
    <button
      type="button"
      title={p.node.url ?? p.node.title}
      onClick={(e) => {
        if (p.node.url === undefined) return setPath([...path(), p.node.id]);
        openBookmark(p.node, whereFor(e));
        props.onClose();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1 || !p.node.url) return;
        e.preventDefault();
        openBookmark(p.node, "background");
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ node: p.node, at: { x: e.clientX, y: e.clientY } });
      }}
      {...stylex.attrs(styles.menuRow)}
      data-bookmark-item={p.node.id}
    >
      <BookmarkIcon node={p.node} />
      <span {...stylex.attrs(styles.menuLabel)}>{p.node.title || p.node.url || "(no name)"}</span>
      <Show when={p.node.url === undefined}>
        <Icon name="chevron-right" size={14} {...stylex.attrs(styles.icon)} />
      </Show>
    </button>
  );

  return (
    <Portal>
      <div
        ref={box}
        role="menu"
        {...stylex.attrs(styles.menu)}
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        data-bookmarks-menu
      >
        <Show when={!atStart()}>
          <button
            type="button"
            onClick={() => setPath(path().slice(0, -1))}
            {...stylex.attrs(styles.menuRow, styles.menuBack)}
            data-bookmarks-back
          >
            <Icon name="chevron-left" size={14} />
            <span {...stylex.attrs(styles.menuLabel)}>{current()?.title}</span>
          </button>
          <div {...stylex.attrs(styles.separator)} />
        </Show>
        <Show when={atStart() && props.top}>
          <For each={props.top}>
            {(item) =>
              item === "separator" ? (
                <div {...stylex.attrs(styles.separator)} />
              ) : (
                <button
                  type="button"
                  disabled={item.disabled}
                  onClick={() => {
                    props.onClose();
                    item.onSelect();
                  }}
                  {...stylex.attrs(styles.menuRow)}
                  data-bookmarks-command={item.label}
                >
                  <Icon name={item.icon ?? "dot"} size={14} {...stylex.attrs(styles.icon)} />
                  <span {...stylex.attrs(styles.menuLabel)}>{item.label}</span>
                  <Show when={item.checked}>
                    <Icon name="check" size={14} />
                  </Show>
                </button>
              )
            }
          </For>
        </Show>
        <div {...stylex.attrs(styles.menuList)}>
          <For each={current()?.children ?? []} fallback={<p {...stylex.attrs(styles.menuEmpty)}>No bookmarks here</p>}>
            {(node) => <Row node={node} />}
          </For>
        </div>
        <Show when={atStart() && props.bottom?.length}>
          <div {...stylex.attrs(styles.separator)} />
          <For each={props.bottom}>{(node) => <Row node={node} />}</For>
        </Show>
      </div>
      <Show when={menu()} keyed>
        {(m) => <ContextMenu items={itemMenu(m.node, props.onClose)} position={m.at} onClose={() => setMenu()} />}
      </Show>
    </Portal>
  );
}

/** The bookmarks menu in the sidebar's top row: bookmarking, the bar, the page, and every bookmark. */
export function BookmarksMenuButton() {
  const [at, setAt] = createSignal<MenuPosition>();
  const isOpen = () => at() !== undefined;
  const tabId = () => (isTab(selectedId()) ? selectedId() : null);
  const tabUrl = () => appById(tabId())?.url;
  const top = (): (MenuItem | "separator")[] => [
    {
      label: bookmarkOf(tabUrl()) ? "Edit bookmark…" : "Bookmark this tab…",
      icon: "star",
      disabled: !canBookmark(tabUrl()),
      onSelect: () => void bookmarkTab(tabId()!),
    },
    { label: "Bookmark all tabs…", icon: "folder-plus", onSelect: () => void bookmarkAllTabs() },
    { label: "Show bookmarks bar", icon: "panel-top", checked: isBookmarksBarShown(), onSelect: toggleBookmarksBar },
    { label: "Bookmarks", icon: "library", onSelect: () => void selectApp(BOOKMARKS_VIEW) },
    "separator",
  ];
  return (
    <>
      <button
        type="button"
        title={withKeys("Bookmarks", "open.bookmarks")}
        onClick={(e) => {
          if (at()) return setAt();
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ x: r.left, y: r.bottom + 4 });
        }}
        {...stylex.attrs(styles.navButton, isOpen() && styles.navButtonOn)}
        data-bookmarks-button
      >
        <Icon name="bookmark" size={16} />
      </button>
      <Show when={at()} keyed>
        {(position) => (
          <FolderMenu
            folder={BAR_ID}
            position={position}
            onClose={() => setAt()}
            top={top()}
            bottom={[otherFolder()]}
          />
        )}
      </Show>
    </>
  );
}

// --- The bookmarks bar --------------------------------------------------------------------------

/** Above the page, like Chrome's: the bar's bookmarks and folders, other bookmarks at its end. */
export function BookmarksBar() {
  const [open, setOpen] = createSignal<{ folder: string; at: MenuPosition }>();
  const [menu, setMenu] = createSignal<{ node: BookmarkNode; at: MenuPosition }>();
  const [overflowing, setOverflowing] = createSignal(false);
  let list!: HTMLDivElement;

  onMount(() => {
    const measure = () => setOverflowing(list.scrollWidth > list.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    onCleanup(() => observer.disconnect());
  });
  createEffect(
    on(
      // A new, removed or renamed bookmark changes how much fits.
      () =>
        barFolder()
          ?.children?.map((c) => c.title)
          .join("\n"),
      () => queueMicrotask(() => list && setOverflowing(list.scrollWidth > list.clientWidth + 1)),
    ),
  );

  const openFolder = (folder: string, e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOpen(open()?.folder === folder ? undefined : { folder, at: { x: r.left, y: r.bottom + 4 } });
  };
  const Item = (p: { node: BookmarkNode }): JSX.Element => (
    <button
      type="button"
      title={p.node.url ? `${p.node.title}\n${p.node.url}` : p.node.title}
      onClick={(e) => (p.node.url === undefined ? openFolder(p.node.id, e) : openBookmark(p.node, whereFor(e)))}
      onAuxClick={(e) => {
        if (e.button !== 1 || !p.node.url) return;
        e.preventDefault();
        openBookmark(p.node, "background");
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ node: p.node, at: { x: e.clientX, y: e.clientY } });
      }}
      {...stylex.attrs(styles.barItem)}
      data-bar-item={p.node.id}
    >
      <BookmarkIcon node={p.node} />
      <Show when={p.node.title}>
        <span {...stylex.attrs(styles.barLabel)}>{p.node.title}</span>
      </Show>
    </button>
  );
  return (
    <div {...stylex.attrs(styles.bar)} data-bookmarks-bar>
      <div ref={list} {...stylex.attrs(styles.barList)}>
        <For
          each={barFolder()?.children ?? []}
          fallback={
            <span {...stylex.attrs(styles.barEmpty)}>
              {`Bookmark pages with the star in the address bar${shortcutLabel("bookmark.page") ? ` (${shortcutLabel("bookmark.page")})` : ""}, or `}
              <button type="button" onClick={openBookmarkImport} {...stylex.attrs(styles.link)} data-bar-import>
                import them from another browser
              </button>
            </span>
          }
        >
          {(node) => <Item node={node} />}
        </For>
      </div>
      <Show when={overflowing()}>
        <button
          type="button"
          title="More bookmarks"
          onClick={(e) => openFolder(BAR_ID, e)}
          {...stylex.attrs(styles.barItem)}
          data-bar-more
        >
          <Icon name="chevrons-right" size={14} />
        </button>
      </Show>
      <Show when={otherFolder()?.children?.length}>
        <span {...stylex.attrs(styles.barDivider)} />
        <button
          type="button"
          onClick={(e) => openFolder(OTHER_ID, e)}
          {...stylex.attrs(styles.barItem)}
          data-bar-item={OTHER_ID}
        >
          <Icon name="folder" size={14} {...stylex.attrs(styles.icon)} />
          <span {...stylex.attrs(styles.barLabel)}>{otherFolder()!.title}</span>
        </button>
      </Show>
      <Show when={open()} keyed>
        {(o) => <FolderMenu folder={o.folder} position={o.at} onClose={() => setOpen()} />}
      </Show>
      <Show when={menu()} keyed>
        {(m) => <ContextMenu items={itemMenu(m.node)} position={m.at} onClose={() => setMenu()} />}
      </Show>
    </div>
  );
}

const styles = stylex.create({
  icon: { flexShrink: 0, color: colors.muted },
  image: { flexShrink: 0, borderRadius: 3, objectFit: "contain" },
  star: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 24,
    height: 24,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  starOn: { color: { default: colors.accent, ":hover": colors.accent } },
  navButton: {
    display: "grid",
    placeItems: "center",
    width: 30,
    height: 30,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  navButtonOn: { backgroundColor: colors.surfaceHover, color: colors.text },
  popover: {
    position: "fixed",
    zIndex: 1600,
    width: 320,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    boxShadow: "0 12px 32px rgb(0 0 0 / 0.18)",
    fontFamily: font.sans,
    fontSize: font.sm,
  },
  form: { display: "flex", flexDirection: "column", gap: space.sm },
  popoverTitle: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    fontSize: font.md,
    fontWeight: 600,
    color: colors.text,
  },
  label: { display: "flex", flexDirection: "column", gap: 4, color: colors.muted, fontSize: font.xs },
  error: { margin: 0, color: colors.danger, fontSize: font.xs },
  actions: { display: "flex", alignItems: "center", gap: space.sm, marginTop: space.xs },
  spacer: { flex: 1 },
  menu: {
    position: "fixed",
    zIndex: 1500,
    display: "flex",
    flexDirection: "column",
    width: 300,
    maxHeight: "min(70vh, 560px)",
    padding: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    boxShadow: "0 12px 32px rgb(0 0 0 / 0.18)",
    fontFamily: font.sans,
    fontSize: font.sm,
  },
  menuList: { display: "flex", flexDirection: "column", minHeight: 0, overflowY: "auto" },
  menuRow: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flexShrink: 0,
    height: 30,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover, ":focus-visible": colors.surfaceHover },
    color: { default: colors.text, ":disabled": colors.muted },
    fontFamily: font.sans,
    fontSize: font.sm,
    textAlign: "left",
    cursor: { default: "pointer", ":disabled": "default" },
    outline: "none",
  },
  menuBack: { fontWeight: 600 },
  menuLabel: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  menuEmpty: { margin: 0, paddingBlock: 6, paddingInline: space.sm, color: colors.muted },
  separator: { flexShrink: 0, height: 1, marginBlock: 4, backgroundColor: colors.border },
  bar: { display: "flex", alignItems: "center", gap: 2, flexShrink: 0, height: 28, minWidth: 0, marginTop: -2 },
  barList: { display: "flex", alignItems: "center", gap: 2, flex: 1, minWidth: 0, overflow: "hidden" },
  barItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
    maxWidth: 180,
    height: 26,
    paddingInline: 8,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: font.sans,
    fontSize: font.xs,
    cursor: "pointer",
  },
  barLabel: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  barDivider: { flexShrink: 0, width: 1, height: 16, backgroundColor: colors.border },
  barEmpty: { paddingInline: 8, color: colors.muted, fontSize: font.xs, whiteSpace: "nowrap" },
  link: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.accent,
    fontFamily: font.sans,
    fontSize: font.xs,
    cursor: "pointer",
    textDecoration: { default: "none", ":hover": "underline" },
  },
});
