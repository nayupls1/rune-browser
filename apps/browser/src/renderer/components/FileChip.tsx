// Files in the chat: what the user attached, what the agent saved or showed,
// the paths it mentions in `code` and the files and folders it links
// ([name](<path>)). Images as thumbnails, other files as cards with their kind
// and size, links and mentions as chips. Clicking one opens it in a tab
// (lib/files.ts), like a file dropped on Rune Browser, or in the system's app
// if a tab can't show it (folders too); right-click for showing it in its
// folder and copying its path. A linked path that's gone, or outside what the
// chat may show (the tab's chat folders and its app's project), is a chip
// marked unavailable.
import * as stylex from "@stylexjs/stylex";
import { createResource, createSignal, For, Show } from "solid-js";
import type { PathInfo } from "../../shared/api";
import { fileNameOf, isViewableFile, systemOpenAction } from "../../shared/web";
import { chatFileUrl, lookupPath, openLocal, revealLocal } from "../lib/files";
import { colors, font, radius, space } from "../theme.stylex";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { Icon } from "./Icon";
import { toast } from "./Toast";

export interface FileLike {
  /** Its name, or its path in the chat's folder. */
  name: string;
  /** Its absolute path. */
  path: string;
  mime: string;
  size?: number;
}

const THUMBNAILS = /^image\/(png|jpeg|gif|webp)$/;

export const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${Math.round(bytes / 1024)} kB`
      : `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;

/** The file's kind in a word or two, and its icon. */
function kindOf(file: FileLike): { label: string; icon: string } {
  const ext = (fileNameOf(file.name).split(".").pop() ?? "").toLowerCase();
  const mime = file.mime;
  if (mime === "application/pdf" || ext === "pdf") return { label: "PDF", icon: "file-text" };
  if (mime.startsWith("image/")) return { label: ext ? ext.toUpperCase() : "Image", icon: "file-image" };
  if (mime.startsWith("video/")) return { label: "Video", icon: "file-video-camera" };
  if (mime.startsWith("audio/")) return { label: "Audio", icon: "file-music" };
  if (/^(csv|tsv|xlsx?|ods|numbers)$/.test(ext)) return { label: ext.toUpperCase(), icon: "file-spreadsheet" };
  if (/^(zip|tar|gz|tgz|7z|rar|xz|bz2)$/.test(ext)) return { label: "Archive", icon: "file-archive" };
  if (/^(html?|xhtml)$/.test(ext)) return { label: "Web page", icon: "file-code" };
  if (/^(json|xml|ya?ml|toml|js|mjs|ts|tsx|jsx|css|py|rb|go|rs|java|c|h|cpp|sh|sql)$/.test(ext))
    return { label: ext.toUpperCase(), icon: "file-code" };
  if (/^(md|markdown)$/.test(ext)) return { label: "Markdown", icon: "file-text" };
  if (mime.startsWith("text/") || /^(txt|log)$/.test(ext)) return { label: "Text", icon: "file-text" };
  return { label: ext ? ext.toUpperCase() : "File", icon: "file" };
}

const report = (problem: Promise<string | null>) =>
  void problem.then(
    (message) => message && toast({ message }),
    (err) => toast({ kind: "error", message: err instanceof Error ? err.message : String(err) }),
  );

/** Opens a file or folder (a file in a tab if the browser can show it, else in the system's app). */
const openTarget = (target: { path: string; kind: "file" | "folder"; mime?: string }, e: MouseEvent) => {
  e.preventDefault();
  report(openLocal(target, { background: e.button === 1 || e.ctrlKey || e.metaKey }));
};
const open = (file: FileLike, e: MouseEvent) => openTarget({ path: file.path, kind: "file", mime: file.mime }, e);

/** Whether the system's app may open it (the main process decides for good: rune:open-path). */
const appOpens = (name: string, directory = false) => systemOpenAction(name, { directory }) === "open";

/** What a click does: open it in a tab, open it with its app, or (anything that could run) show it in its folder. */
const clickVerb = (name: string, mime?: string) =>
  isViewableFile(name, mime) ? "Open" : appOpens(name) ? "Open with its app" : "Show in its folder";

const tooltip = (file: FileLike) =>
  `${clickVerb(fileNameOf(file.name), file.mime)}: ${fileNameOf(file.name)}\n${file.path}\nRight-click for more`;

/** What a file's right-click menu offers: open (also in the system's app), show in its folder, copy its path. */
function menuItems(target: { path: string | null; kind: PathInfo["kind"]; mime?: string; copy: string }): MenuItem[] {
  const { path, kind } = target;
  const name = path ? fileNameOf(path) : "";
  const viewable = kind === "file" && !!path && isViewableFile(name, target.mime);
  const opens = viewable || ((kind === "file" || kind === "folder") && appOpens(name, kind === "folder"));
  return [
    ...(path && (kind === "file" || kind === "folder")
      ? [
          ...(opens
            ? [
                {
                  label: kind === "folder" ? "Open folder" : viewable ? "Open in a tab" : "Open with its app",
                  icon: kind === "folder" ? "folder-open" : "square-arrow-out-up-right",
                  id: "open",
                  onSelect: () => report(openLocal({ path, kind, mime: target.mime })),
                },
              ]
            : []),
          ...(viewable && appOpens(name)
            ? [
                {
                  label: "Open with its app",
                  icon: "app-window",
                  id: "open-with",
                  onSelect: () => report(openLocal({ path, kind, mime: target.mime }, { withSystemApp: true })),
                },
              ]
            : []),
          {
            label: "Show in folder",
            icon: "folder-search",
            id: "reveal",
            onSelect: () => report(revealLocal(path)),
          },
        ]
      : []),
    {
      label: "Copy path",
      icon: "copy",
      id: "copy-path",
      onSelect: () => void navigator.clipboard.writeText(target.copy),
    },
  ];
}

/** A right-click menu for a file: `onContextMenu` opens it, `menu` renders it. */
function useFileMenu(items: () => MenuItem[]) {
  const [position, setPosition] = createSignal<MenuPosition>();
  return {
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      setPosition({ x: e.clientX, y: e.clientY });
    },
    menu: () => (
      <Show when={position()}>
        {(at) => <ContextMenu items={items()} position={at()} onClose={() => setPosition()} />}
      </Show>
    ),
  };
}

const fileMenu = (file: FileLike) =>
  useFileMenu(() => menuItems({ path: file.path, kind: "file", mime: file.mime, copy: file.path }));

/** A file as a card (or an image as a thumbnail) that opens it. */
export function FileCard(props: { tabId: string; file: FileLike }) {
  const kind = () => kindOf(props.file);
  const thumbnail = () => THUMBNAILS.test(props.file.mime);
  const menu = fileMenu(props.file);
  return (
    <>
      {menu.menu()}
      <Show
        when={thumbnail()}
        fallback={
          <button
            type="button"
            title={tooltip(props.file)}
            onClick={(e) => open(props.file, e)}
            onAuxClick={(e) => e.button === 1 && open(props.file, e)}
            onContextMenu={menu.onContextMenu}
            {...stylex.attrs(stylex.defaultMarker(), styles.card)}
            data-file-card={props.file.name}
          >
            <span {...stylex.attrs(styles.cardIcon)}>
              <Icon name={kind().icon} size={16} />
            </span>
            <span {...stylex.attrs(styles.cardText)}>
              <span {...stylex.attrs(styles.cardName)}>{fileNameOf(props.file.name)}</span>
              <span {...stylex.attrs(styles.cardMeta)}>
                {kind().label}
                <Show when={props.file.size !== undefined}> · {formatSize(props.file.size!)}</Show>
              </span>
            </span>
            <span {...stylex.attrs(styles.cardOpen)}>
              <Icon name="square-arrow-out-up-right" size={13} />
            </span>
          </button>
        }
      >
        <button
          type="button"
          title={tooltip(props.file)}
          onClick={(e) => open(props.file, e)}
          onAuxClick={(e) => e.button === 1 && open(props.file, e)}
          onContextMenu={menu.onContextMenu}
          {...stylex.attrs(stylex.defaultMarker(), styles.thumb)}
          data-file-card={props.file.name}
        >
          <img
            src={chatFileUrl(props.tabId, props.file.path)}
            alt={fileNameOf(props.file.name)}
            loading="lazy"
            {...stylex.attrs(styles.thumbImage)}
          />
          <span {...stylex.attrs(styles.thumbName)}>{fileNameOf(props.file.name)}</span>
        </button>
      </Show>
    </>
  );
}

/** Several files, wrapping. */
export function FileCards(props: { tabId: string; files: FileLike[]; align?: "start" | "end" }) {
  const end = () => props.align === "end";
  return (
    <div {...stylex.attrs(styles.cards, end() && styles.cardsEnd)} data-file-cards>
      <For each={props.files}>{(file) => <FileCard tabId={props.tabId} file={file} />}</For>
    </div>
  );
}

/** A file named inline (in a reply, in `code`): its icon and name, opening it. */
export function FileMention(props: { file: FileLike; label: string }) {
  const menu = fileMenu(props.file);
  return (
    <>
      {menu.menu()}
      <button
        type="button"
        title={tooltip(props.file)}
        onClick={(e) => open(props.file, e)}
        onAuxClick={(e) => e.button === 1 && open(props.file, e)}
        onContextMenu={menu.onContextMenu}
        {...stylex.attrs(styles.mention)}
        data-file-mention={props.file.name}
      >
        <Icon name={kindOf(props.file).icon} size={12} />
        <span {...stylex.attrs(styles.mentionLabel)}>{props.label}</span>
      </button>
    </>
  );
}

/** The chip's icon and tooltip for what a linked path turned out to be. */
function linkLook(info: PathInfo | undefined, target: string): { icon: string; title: string } {
  if (!info) return { icon: "file", title: target };
  const where = info.path ?? info.input;
  switch (info.kind) {
    case "folder":
      return {
        icon: "folder",
        title: `${appOpens(info.name, true) ? "Open the folder" : "Show in its folder"} ${info.name}\n${where}\nRight-click for more`,
      };
    case "file":
      return {
        icon: kindOf({ name: info.name, path: where, mime: info.mime ?? "" }).icon,
        title: `${clickVerb(info.name, info.mime)}: ${info.name}${
          info.size !== undefined ? ` (${formatSize(info.size)})` : ""
        }\n${where}\nRight-click for more`,
      };
    case "missing":
      return { icon: "file-x", title: `Not available: ${info.name} isn't there (any more)\n${where}` };
    case "outside":
      return {
        icon: "file-lock",
        title: `Not available: the chat only opens files in its own folder (and an app's project)\n${where}`,
      };
  }
}

/**
 * A file or folder the agent linked in a reply (`[name](<path>)`): a chip with its kind's icon and the link's text,
 * the full path on hover. Gone or out of reach: shown as unavailable.
 */
export function FileLink(props: { tabId: string; target: string; label: string }) {
  const [info] = createResource(
    () => [props.tabId, props.target] as const,
    ([tabId, target]) => lookupPath(tabId, target),
  );
  const look = () => linkLook(info(), props.target);
  const available = () => {
    const i = info();
    return i && (i.kind === "file" || i.kind === "folder") && i.path ? { ...i, path: i.path, kind: i.kind } : null;
  };
  const unavailable = () => info()?.kind === "missing" || info()?.kind === "outside";
  const menu = useFileMenu(() => {
    const i = info();
    return menuItems({
      path: i?.path ?? null,
      kind: i?.kind ?? "outside",
      mime: i?.mime,
      copy: i?.path ?? props.target,
    });
  });
  const go = (e: MouseEvent) => {
    const target = available();
    if (target) openTarget(target, e);
    else e.preventDefault();
  };
  return (
    <>
      {menu.menu()}
      <button
        type="button"
        title={look().title}
        aria-disabled={unavailable() ? "true" : undefined}
        onClick={go}
        onAuxClick={(e) => e.button === 1 && go(e)}
        onContextMenu={menu.onContextMenu}
        {...stylex.attrs(styles.mention, styles.link, unavailable() && styles.unavailable)}
        data-file-link={props.target}
        data-file-kind={info()?.kind ?? "loading"}
      >
        <Icon name={look().icon} size={12} />
        <span {...stylex.attrs(styles.mentionLabel, unavailable() && styles.unavailableLabel)}>{props.label}</span>
      </button>
    </>
  );
}

const styles = stylex.create({
  cards: { display: "flex", flexWrap: "wrap", gap: space.sm, minWidth: 0 },
  cardsEnd: { justifyContent: "flex-end" },
  card: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
    maxWidth: 280,
    paddingBlock: 7,
    paddingLeft: 7,
    paddingRight: 10,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": `color-mix(in srgb, ${colors.muted} 45%, ${colors.border})` },
    borderRadius: radius.md,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: font.sans,
    textAlign: "left",
    cursor: "pointer",
    transitionProperty: "background-color, border-color",
    transitionDuration: "120ms",
  },
  cardIcon: {
    display: "grid",
    placeItems: "center",
    width: 32,
    height: 32,
    flexShrink: 0,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
  },
  cardText: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 },
  cardName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.sm,
    fontWeight: 500,
  },
  cardMeta: { fontSize: font.xs, color: colors.muted, whiteSpace: "nowrap" },
  cardOpen: {
    display: "grid",
    flexShrink: 0,
    color: colors.muted,
    opacity: { default: 0, [stylex.when.ancestor(":hover")]: 1, [stylex.when.ancestor(":focus-visible")]: 1 },
    transitionProperty: "opacity",
    transitionDuration: "120ms",
  },
  thumb: {
    position: "relative",
    display: "block",
    padding: 0,
    overflow: "hidden",
    maxWidth: 240,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": `color-mix(in srgb, ${colors.muted} 45%, ${colors.border})` },
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    cursor: "zoom-in",
  },
  thumbImage: { display: "block", maxWidth: 240, maxHeight: 160, objectFit: "cover" },
  thumbName: {
    position: "absolute",
    insetInline: 0,
    bottom: 0,
    paddingBlock: 4,
    paddingInline: 8,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    backgroundImage: "linear-gradient(transparent, rgb(0 0 0 / 0.6))",
    color: "white",
    fontFamily: font.sans,
    fontSize: font.xs,
    textAlign: "left",
    opacity: { default: 0, [stylex.when.ancestor(":hover")]: 1 },
    transitionProperty: "opacity",
    transitionDuration: "120ms",
  },
  mention: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    maxWidth: "100%",
    paddingBlock: 1,
    paddingInline: 6,
    marginInline: 1,
    verticalAlign: "baseline",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": colors.accent },
    borderRadius: radius.sm,
    backgroundColor: { default: colors.surface, ":hover": colors.accentSoft },
    color: colors.accent,
    fontFamily: font.mono,
    fontSize: "0.88em",
    lineHeight: 1.5,
    cursor: "pointer",
  },
  mentionLabel: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  link: { fontFamily: font.sans, fontSize: "0.92em" },
  unavailable: {
    borderStyle: "dashed",
    borderColor: colors.border,
    backgroundColor: "transparent",
    color: colors.muted,
    cursor: "default",
  },
  unavailableLabel: { textDecorationLine: "line-through", textDecorationColor: colors.muted },
});
