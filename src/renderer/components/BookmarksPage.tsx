// The bookmarks page (Ctrl+Shift+O), like Chrome's bookmark manager: folders on
// the left, the chosen folder's bookmarks on the right, or what a search
// finds in all of them. Bookmarks and folders are renamed in place, moved and
// put in order by dragging (or from their menu), and deleted; bookmarks come in
// from other browsers or an HTML file and go out as one.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  ancestors,
  BAR_ID,
  isFolder,
  ROOT_FOLDERS,
  searchBookmarks,
  type BookmarkNode,
  type BookmarkSource,
} from "../../shared/bookmarks";
import {
  addBookmark,
  bookmarkById,
  bookmarkFolders,
  bookmarkSources,
  bookmarkTree,
  editBookmark,
  exportBookmarks,
  importBookmarks,
  openAll,
  openBookmark,
  removeBookmark,
} from "../lib/bookmarks";
import { BOOKMARKS_VIEW, selectApp } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { BookmarkIcon, bookmarksPageFocus, setBookmarksPageFocus } from "./Bookmarks";
import { confirmDialog } from "./ConfirmDialog";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";
import { toast } from "./Toast";
import { Button, Input } from "./ui";

const DRAG_TYPE = "application/x-rune-bookmark";

/** The import dialog, also opened from the command bar and the empty bookmarks bar. */
const [importing, setImporting] = createSignal(false);
export function openBookmarkImport() {
  setImporting(true);
  void selectApp(BOOKMARKS_VIEW);
}

const errorToast = (err: unknown) =>
  void toast({ message: err instanceof Error ? err.message : String(err), kind: "error" });

/** Where a dragged bookmark lands: before or after a row, or into a folder. */
type Drop = { id: string; where: "before" | "after" | "into" };

export function BookmarksPage() {
  const [folder, setFolder] = createSignal(BAR_ID);
  const [query, setQuery] = createSignal("");
  const [editing, setEditing] = createSignal<string | null>(null);
  const [highlight, setHighlight] = createSignal<string | null>(null);
  const [dragging, setDragging] = createSignal<string | null>(null);
  const [drop, setDrop] = createSignal<Drop | null>(null);
  const [menu, setMenu] = createSignal<{ items: (MenuItem | "separator")[]; at: MenuPosition }>();

  const current = () => bookmarkById(folder()) ?? bookmarkById(BAR_ID)!;
  // A folder deleted meanwhile: back to the bar.
  createEffect(() => !bookmarkById(folder()) && setFolder(BAR_ID));
  const rows = createMemo(() =>
    query().trim() ? searchBookmarks(bookmarkTree(), query().trim()) : (current().children ?? []),
  );
  const searching = () => !!query().trim();

  // Opened from the star's popover (More…): its folder, with it highlighted and being edited.
  createEffect(
    on(bookmarksPageFocus, (id) => {
      if (!id) return;
      setBookmarksPageFocus(null);
      const node = bookmarkById(id);
      if (!node) return;
      setQuery("");
      setFolder(node.parentId ?? BAR_ID);
      setHighlight(id);
      setEditing(id);
    }),
  );

  const pathOf = (node: BookmarkNode) =>
    ancestors(bookmarkTree(), node.id)
      .slice(1)
      .map((n) => n.title)
      .join(" › ");

  const move = (id: string, fields: { parentId?: string; index?: number }) =>
    void editBookmark(id, fields).catch(errorToast);

  const remove = async (node: BookmarkNode) => {
    const count = node.children?.length ?? 0;
    if (
      count &&
      !(await confirmDialog(`Delete “${node.title}” and the ${count} things in it?`, {
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    await removeBookmark(node.id).then(
      () => toast({ message: `Deleted “${node.title || node.url}”`, kind: "info" }),
      errorToast,
    );
  };

  const newFolder = async () => {
    const parent = searching() ? BAR_ID : current().id;
    setQuery("");
    setFolder(parent);
    const made = await addBookmark({ title: "New folder", parentId: parent }).catch((err) => errorToast(err));
    if (made) setEditing(made.id);
  };

  const rowMenu = (node: BookmarkNode, at: MenuPosition) => {
    const siblings = bookmarkById(node.parentId ?? "")?.children ?? [];
    const index = siblings.findIndex((n) => n.id === node.id);
    const opens: (MenuItem | "separator")[] = node.url
      ? [
          { label: "Open in new tab", icon: "square-plus", onSelect: () => openBookmark(node, "tab") },
          { label: "Open in a background tab", icon: "layers", onSelect: () => openBookmark(node, "background") },
        ]
      : [
          { label: "Show what's in it", icon: "folder-open", onSelect: () => (setQuery(""), setFolder(node.id)) },
          {
            label: "Open all in new tabs",
            icon: "square-stack",
            disabled: !(node.children ?? []).some((c) => c.url),
            onSelect: () => openAll(node),
          },
        ];
    setMenu({
      at,
      items: [
        ...opens,
        "separator",
        { label: "Rename or edit", icon: "pencil", onSelect: () => setEditing(node.id) },
        {
          label: "Move to…",
          icon: "folder-input",
          onSelect: () =>
            setMenu({
              at,
              items: bookmarkFolders()
                .filter(
                  ({ node: f }) => f.id !== node.id && !ancestors(bookmarkTree(), f.id).some((a) => a.id === node.id),
                )
                .map(({ node: f, depth }) => ({
                  label: `${" ".repeat(depth)}${f.title || "(no name)"}`,
                  icon: "folder",
                  checked: f.id === node.parentId,
                  // Already there: it stays where it is (a move with no index goes to the end).
                  onSelect: () => f.id !== node.parentId && move(node.id, { parentId: f.id }),
                })),
            }),
        },
        {
          label: "Move up",
          icon: "arrow-up",
          disabled: index <= 0,
          onSelect: () => move(node.id, { index: index - 1 }),
        },
        {
          label: "Move down",
          icon: "arrow-down",
          disabled: index === -1 || index >= siblings.length - 1,
          onSelect: () => move(node.id, { index: index + 2 }),
        },
        "separator",
        { label: "Delete", icon: "trash", danger: true, onSelect: () => void remove(node) },
      ],
    });
  };

  // --- Dragging ----------------------------------------------------------------------------

  const canDropOn = (target: BookmarkNode) => {
    const id = dragging();
    if (!id || id === target.id) return false;
    // Not into itself or a folder in it.
    return !ancestors(bookmarkTree(), target.id).some((a) => a.id === id);
  };
  const dropAt = (target: BookmarkNode, e: DragEvent, folderOnly = false): Drop => {
    if (folderOnly) return { id: target.id, where: "into" };
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (isFolder(target) && y > 0.25 && y < 0.75) return { id: target.id, where: "into" };
    return { id: target.id, where: y < 0.5 ? "before" : "after" };
  };
  const finishDrop = () => {
    const id = dragging();
    const d = drop();
    setDragging(null);
    setDrop(null);
    if (!id || !d) return;
    const target = bookmarkById(d.id);
    if (!target) return;
    if (d.where === "into") return target.id !== bookmarkById(id)?.parentId && move(id, { parentId: target.id });
    const siblings = bookmarkById(target.parentId ?? "")?.children ?? [];
    const at = siblings.findIndex((n) => n.id === target.id);
    move(id, { parentId: target.parentId, index: d.where === "before" ? at : at + 1 });
  };
  const dragProps = (node: BookmarkNode, folderOnly = false) => ({
    onDragOver: (e: DragEvent) => {
      if (!canDropOn(node) || (folderOnly && !isFolder(node))) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      setDrop(dropAt(node, e, folderOnly));
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node) && drop()?.id === node.id) setDrop(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      finishDrop();
    },
  });
  const dropIs = (id: string, where: Drop["where"]) => drop()?.id === id && drop()?.where === where;

  // --- Rows --------------------------------------------------------------------------------

  const Row = (p: { node: BookmarkNode }) => {
    const node = () => p.node;
    let el!: HTMLDivElement;
    createEffect(() => highlight() === node().id && queueMicrotask(() => el?.scrollIntoView({ block: "nearest" })));
    const isEditing = () => editing() === node().id;
    const isHighlighted = () => highlight() === node().id;
    const beforeDrop = () => dropIs(node().id, "before");
    const afterDrop = () => dropIs(node().id, "after");
    const intoDrop = () => dropIs(node().id, "into");
    const isDragged = () => dragging() === node().id;
    return (
      <div
        ref={el}
        role="row"
        tabIndex={0}
        draggable={!isEditing() && !searching()}
        onDragStart={(e) => {
          e.dataTransfer!.setData(DRAG_TYPE, node().id);
          if (node().url) e.dataTransfer!.setData("text/uri-list", node().url!);
          e.dataTransfer!.effectAllowed = "move";
          setDragging(node().id);
        }}
        onDragEnd={() => (setDragging(null), setDrop(null))}
        {...dragProps(node())}
        onDblClick={(e) => {
          // Not from the rename fields.
          if (isEditing() || e.target instanceof HTMLInputElement) return;
          node().url ? openBookmark(node(), "tab") : (setQuery(""), setFolder(node().id));
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          rowMenu(node(), { x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (isEditing() || e.target !== e.currentTarget) return;
          if (e.key === "Delete" || e.key === "Backspace") (e.preventDefault(), void remove(node()));
          else if (e.key === "Enter") node().url ? openBookmark(node(), "tab") : (setQuery(""), setFolder(node().id));
          else if (e.key === "F2") setEditing(node().id);
        }}
        {...stylex.attrs(
          styles.row,
          isHighlighted() && styles.rowHighlighted,
          beforeDrop() && styles.dropBefore,
          afterDrop() && styles.dropAfter,
          intoDrop() && styles.dropInto,
          isDragged() && styles.rowDragged,
        )}
        data-bookmark-row={node().id}
      >
        <Show
          when={isEditing()}
          fallback={
            <>
              <BookmarkIcon node={node()} size={16} />
              <div {...stylex.attrs(styles.rowText)}>
                <span {...stylex.attrs(styles.rowTitle)}>{node().title || node().url || "(no name)"}</span>
                <span {...stylex.attrs(styles.rowDetail)}>
                  {node().url
                    ? node().url!.replace(/^https?:\/\//, "")
                    : `${(node().children ?? []).length} item${(node().children ?? []).length === 1 ? "" : "s"}`}
                  {searching() && pathOf(node()) ? ` · ${pathOf(node())}` : ""}
                </span>
              </div>
              <div {...stylex.attrs(styles.rowActions)} data-row-actions>
                <button
                  type="button"
                  title="Rename or edit"
                  onClick={() => setEditing(node().id)}
                  {...stylex.attrs(styles.iconButton)}
                  data-bookmark-edit
                >
                  <Icon name="pencil" size={14} />
                </button>
                <button
                  type="button"
                  title="More"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    rowMenu(node(), { x: r.left - 180, y: r.bottom + 4 });
                  }}
                  {...stylex.attrs(styles.iconButton)}
                  data-bookmark-menu
                >
                  <Icon name="ellipsis" size={14} />
                </button>
              </div>
            </>
          }
        >
          <RowEditor node={node()} onDone={() => (setEditing(null), el?.focus())} />
        </Show>
      </div>
    );
  };

  // --- Folders on the left -------------------------------------------------------------------

  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(collapsed());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };
  const FolderTree = (p: { node: BookmarkNode; depth: number }) => {
    const subfolders = () => (p.node.children ?? []).filter(isFolder);
    const isOpen = () => !collapsed().has(p.node.id);
    const isCurrent = () => !searching() && folder() === p.node.id;
    const intoDrop = () => dropIs(p.node.id, "into");
    const hasSubfolders = () => subfolders().length > 0;
    return (
      <>
        <div
          role="treeitem"
          aria-expanded={hasSubfolders() ? isOpen() : undefined}
          aria-selected={isCurrent()}
          {...dragProps(p.node, true)}
          onClick={() => (setQuery(""), setFolder(p.node.id))}
          onContextMenu={(e) => {
            if (ROOT_FOLDERS.includes(p.node.id)) return;
            e.preventDefault();
            rowMenu(p.node, { x: e.clientX, y: e.clientY });
          }}
          {...stylex.attrs(styles.folder, isCurrent() && styles.folderOn, intoDrop() && styles.dropInto)}
          style={{ "padding-left": `${8 + p.depth * 14}px` }}
          data-bookmark-folder={p.node.id}
        >
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => (e.stopPropagation(), toggle(p.node.id))}
            {...stylex.attrs(styles.twisty, hasSubfolders() && styles.twistyShown)}
            aria-label={isOpen() ? "Collapse" : "Expand"}
          >
            <Icon name={isOpen() ? "chevron-down" : "chevron-right"} size={12} />
          </button>
          <Icon
            name={isOpen() && hasSubfolders() ? "folder-open" : "folder"}
            size={15}
            {...stylex.attrs(styles.folderIcon)}
          />
          <span {...stylex.attrs(styles.folderLabel)}>{p.node.title || "(no name)"}</span>
        </div>
        <Show when={isOpen()}>
          <For each={subfolders()}>{(child) => <FolderTree node={child} depth={p.depth + 1} />}</For>
        </Show>
      </>
    );
  };

  return (
    <div {...stylex.attrs(styles.page)} data-bookmarks-page>
      <header {...stylex.attrs(styles.header)}>
        <h1 {...stylex.attrs(styles.title)}>
          <Icon name="bookmark" size={24} {...stylex.attrs(styles.accent)} />
          Bookmarks
        </h1>
        <p {...stylex.attrs(styles.muted)}>
          The same in every workspace. Drag bookmarks to put them in order or into folders; right-click for more.
        </p>
      </header>
      <div {...stylex.attrs(styles.toolbar)}>
        <label {...stylex.attrs(styles.search)}>
          <Icon name="search" size={14} {...stylex.attrs(styles.searchIcon)} />
          <input
            type="search"
            placeholder="Search bookmarks"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            {...stylex.attrs(styles.searchInput)}
            data-bookmarks-search
          />
        </label>
        <Button onClick={() => void newFolder()} data-bookmarks-new-folder>
          <Icon name="folder-plus" size={14} />
          New folder
        </Button>
        <Button onClick={() => setImporting(true)} data-bookmarks-import>
          <Icon name="download" size={14} />
          Import
        </Button>
        <Button onClick={() => void exportBookmarks().catch(errorToast)} data-bookmarks-export>
          <Icon name="upload" size={14} />
          Export
        </Button>
      </div>
      <div {...stylex.attrs(styles.body)}>
        <nav role="tree" aria-label="Folders" {...stylex.attrs(styles.folders)}>
          <For each={bookmarkTree().children ?? []}>{(node) => <FolderTree node={node} depth={0} />}</For>
        </nav>
        <div
          role="grid"
          aria-label={searching() ? "Search results" : current().title}
          {...stylex.attrs(styles.list)}
          data-bookmarks-list
        >
          <div {...stylex.attrs(styles.listHeader)}>
            {searching()
              ? `${rows().length} found for “${query().trim()}”`
              : ancestors(bookmarkTree(), current().id)
                  .slice(1)
                  .map((n) => `${n.title} › `)
                  .join("") + current().title}
          </div>
          <For
            each={rows()}
            fallback={
              <p {...stylex.attrs(styles.empty)}>
                {searching()
                  ? "No bookmarks match."
                  : "Nothing here yet. Drag bookmarks here, or bookmark a page with the star in the address bar."}
              </p>
            }
          >
            {(node) => <Row node={node} />}
          </For>
          {/* Dropping below the last row puts it at the folder's end. */}
          <Show when={!searching()}>
            <div
              {...stylex.attrs(styles.endZone)}
              onDragOver={(e) => {
                if (!dragging() || !canDropOn(current())) return;
                e.preventDefault();
                setDrop({ id: current().id, where: "into" });
              }}
              onDrop={(e) => (e.preventDefault(), finishDrop())}
            />
          </Show>
        </div>
      </div>
      <Show when={menu()} keyed>
        {(m) => <ContextMenu items={m.items} position={m.at} onClose={() => setMenu()} />}
      </Show>
      <Show when={importing()}>
        <ImportDialog onClose={() => setImporting(false)} />
      </Show>
    </div>
  );
}

/** A row being renamed (and a bookmark's address changed): Enter saves, Escape leaves it as it was. */
function RowEditor(props: { node: BookmarkNode; onDone: () => void }) {
  const [title, setTitle] = createSignal(props.node.title);
  const [url, setUrl] = createSignal(props.node.url ?? "");
  let nameInput!: HTMLInputElement;
  onMount(() => {
    nameInput.focus();
    nameInput.select();
  });
  const save = async () => {
    const fields: { title?: string; url?: string } = {};
    if (title() !== props.node.title) fields.title = title();
    if (props.node.url !== undefined && url().trim() !== props.node.url) fields.url = url().trim();
    try {
      if (Object.keys(fields).length) await editBookmark(props.node.id, fields);
      props.onDone();
    } catch (err) {
      errorToast(err);
    }
  };
  return (
    <form
      onSubmit={(e) => (e.preventDefault(), void save())}
      onKeyDown={(e) => {
        if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), props.onDone());
      }}
      {...stylex.attrs(styles.editor)}
      data-bookmark-editing={props.node.id}
    >
      <Input
        ref={nameInput}
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
        placeholder="Name"
        data-edit-name
      />
      <Show when={props.node.url !== undefined}>
        <Input
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          placeholder="Address"
          spellcheck={false}
          data-edit-url
        />
      </Show>
      <Button type="submit" variant="primary" data-edit-save>
        Save
      </Button>
      <Button variant="ghost" onClick={() => props.onDone()}>
        Cancel
      </Button>
    </form>
  );
}

/** Import from another browser on this computer, or from an HTML file any browser exports. */
function ImportDialog(props: { onClose: () => void }) {
  const [sources, setSources] = createSignal<BookmarkSource[] | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  let file!: HTMLInputElement;
  void bookmarkSources().then(setSources, (err) => (errorToast(err), setSources([])));

  const done = (from: string, result: { added: number; skipped: number }) => {
    toast({
      message: `Imported ${result.added} bookmark${result.added === 1 ? "" : "s"} from ${from}${result.skipped ? ` (${result.skipped} left out: scripts and browser-only pages)` : ""}`,
      kind: "success",
    });
    props.onClose();
  };
  const fromSource = async (source: BookmarkSource) => {
    setBusy(source.id);
    try {
      done(source.browser, await importBookmarks({ source: source.id }));
    } catch (err) {
      errorToast(err);
    } finally {
      setBusy(null);
    }
  };
  const fromFile = async (picked: File | undefined) => {
    if (!picked) return;
    setBusy("file");
    try {
      done(picked.name, await importBookmarks({ html: await picked.text() }));
    } catch (err) {
      errorToast(err);
    } finally {
      setBusy(null);
    }
  };

  onMount(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  return (
    <Portal>
      <div {...stylex.attrs(styles.overlay)} onClick={(e) => e.target === e.currentTarget && props.onClose()}>
        <div role="dialog" aria-label="Import bookmarks" {...stylex.attrs(styles.dialog)} data-bookmarks-import-dialog>
          <h2 {...stylex.attrs(styles.dialogTitle)}>Import bookmarks</h2>
          <p {...stylex.attrs(styles.muted)}>
            The bookmarks bar's bookmarks go on yours, the rest into other bookmarks; where you have some already, they
            come in a folder of their own.
          </p>
          <div {...stylex.attrs(styles.sources)}>
            <Show when={sources()} fallback={<p {...stylex.attrs(styles.muted)}>Looking for browsers…</p>}>
              <For
                each={sources()}
                fallback={
                  <p {...stylex.attrs(styles.muted)}>No other browser with bookmarks was found on this computer.</p>
                }
              >
                {(source) => (
                  <div {...stylex.attrs(styles.source)} data-bookmark-source={source.id}>
                    <Icon name="globe" size={18} {...stylex.attrs(styles.accent)} />
                    <div {...stylex.attrs(styles.rowText)}>
                      <span {...stylex.attrs(styles.rowTitle)}>{source.browser}</span>
                      <span {...stylex.attrs(styles.rowDetail)}>
                        {source.profile} · {source.count} bookmark{source.count === 1 ? "" : "s"}
                      </span>
                    </div>
                    <Button
                      variant="primary"
                      disabled={busy() !== null}
                      onClick={() => void fromSource(source)}
                      data-import-source
                    >
                      {busy() === source.id ? "Importing…" : "Import"}
                    </Button>
                  </div>
                )}
              </For>
            </Show>
          </div>
          <div {...stylex.attrs(styles.dialogFooter)}>
            <input
              ref={file}
              type="file"
              accept=".html,.htm,text/html"
              hidden
              onChange={(e) => void fromFile(e.currentTarget.files?.[0])}
              data-import-file
            />
            <Button disabled={busy() !== null} onClick={() => file.click()}>
              <Icon name="file-code" size={14} />
              {busy() === "file" ? "Importing…" : "From an HTML file…"}
            </Button>
            <span {...stylex.attrs(styles.hint)}>Safari, Edge and others export one.</span>
            <span {...stylex.attrs(styles.grow)} />
            <Button variant="ghost" onClick={() => props.onClose()}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

const styles = stylex.create({
  page: {
    maxWidth: 1040,
    marginInline: "auto",
    paddingBlock: space.xxl,
    paddingInline: space.xl,
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  header: { display: "flex", flexDirection: "column", gap: space.xs },
  title: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    margin: 0,
    fontSize: font.xxl,
    fontWeight: 650,
    letterSpacing: "-0.02em",
  },
  accent: { color: colors.accent, flexShrink: 0 },
  muted: { margin: 0, color: colors.muted, fontSize: font.sm, lineHeight: 1.5 },
  toolbar: { display: "flex", alignItems: "center", gap: space.sm },
  search: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    flex: 1,
    height: 34,
    paddingInline: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus-within": colors.accent },
    backgroundColor: colors.surface,
  },
  searchIcon: { flexShrink: 0, color: colors.muted },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderWidth: 0,
    outline: "none",
    backgroundColor: "transparent",
    color: colors.text,
    fontSize: font.md,
  },
  body: { display: "grid", gridTemplateColumns: "230px 1fr", gap: space.lg, alignItems: "start" },
  folders: {
    position: "sticky",
    top: space.md,
    display: "flex",
    flexDirection: "column",
    gap: 1,
    padding: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  folder: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 30,
    paddingRight: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.sm,
    cursor: "pointer",
    userSelect: "none",
  },
  folderOn: { backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft }, fontWeight: 600 },
  folderIcon: { flexShrink: 0, color: colors.muted },
  folderLabel: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  twisty: {
    display: "grid",
    placeItems: "center",
    width: 16,
    height: 16,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: colors.muted,
    cursor: "pointer",
    visibility: "hidden",
  },
  twistyShown: { visibility: "visible" },
  list: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    padding: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  listHeader: {
    paddingBlock: 6,
    paddingInline: space.sm,
    color: colors.muted,
    fontSize: font.xs,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  row: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space.md,
    minHeight: 44,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "transparent",
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover, ":focus-visible": colors.surfaceHover },
    outline: "none",
    cursor: "default",
  },
  rowHighlighted: { borderColor: colors.accent },
  rowDragged: { opacity: 0.45 },
  dropBefore: { boxShadow: `inset 0 2px 0 ${colors.accent}` },
  dropAfter: { boxShadow: `inset 0 -2px 0 ${colors.accent}` },
  dropInto: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  rowText: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: font.sm, fontWeight: 500 },
  rowDetail: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.xs,
    color: colors.muted,
  },
  rowActions: { display: "flex", gap: 2, flexShrink: 0 },
  iconButton: {
    display: "grid",
    placeItems: "center",
    width: 28,
    height: 28,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.border },
    color: { default: colors.muted, ":hover": colors.text },
    cursor: "pointer",
  },
  editor: { display: "flex", alignItems: "center", gap: space.sm, flex: 1, paddingBlock: 6 },
  empty: { margin: 0, padding: space.lg, color: colors.muted, fontSize: font.sm, textAlign: "center" },
  endZone: { minHeight: 24, flex: 1 },
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1700,
    display: "grid",
    placeItems: "center",
    backgroundColor: "rgb(0 0 0 / 0.35)",
    fontFamily: font.sans,
  },
  dialog: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    width: "min(520px, calc(100vw - 48px))",
    padding: space.xl,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    color: colors.text,
    boxShadow: "0 24px 64px rgb(0 0 0 / 0.3)",
  },
  dialogTitle: { margin: 0, fontSize: font.xl, fontWeight: 650 },
  sources: { display: "flex", flexDirection: "column", gap: space.sm },
  source: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
  },
  dialogFooter: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  hint: { color: colors.muted, fontSize: font.xs },
  grow: { flex: 1 },
});
