// Files in the chat: what the user attached, what the agent saved or showed
// and the paths it mentions. Images as thumbnails, other files as cards with
// their kind and size; clicking one opens it in a tab (lib/files.ts), like a
// file dropped on Rune Browser.
import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";
import { fileNameOf, isViewableFile } from "../../shared/web";
import { chatFileUrl, openFile } from "../lib/files";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";

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

/** Opens the file (shown in a tab, or downloaded if the browser can't show it). */
const open = (file: FileLike, e: MouseEvent) => {
  e.preventDefault();
  void openFile(file.path, { mime: file.mime, background: e.button === 1 || e.ctrlKey || e.metaKey });
};

const tooltip = (file: FileLike) =>
  `${isViewableFile(fileNameOf(file.name), file.mime) ? "Open" : "Download"} ${fileNameOf(file.name)}\n${file.path}`;

/** A file as a card (or an image as a thumbnail) that opens it. */
export function FileCard(props: { tabId: string; file: FileLike }) {
  const kind = () => kindOf(props.file);
  const thumbnail = () => THUMBNAILS.test(props.file.mime);
  return (
    <Show
      when={thumbnail()}
      fallback={
        <button
          type="button"
          title={tooltip(props.file)}
          onClick={(e) => open(props.file, e)}
          onAuxClick={(e) => e.button === 1 && open(props.file, e)}
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

/** A file named inline (in a reply): its icon and name, opening it. */
export function FileMention(props: { file: FileLike; label: string }) {
  return (
    <button
      type="button"
      title={tooltip(props.file)}
      onClick={(e) => open(props.file, e)}
      onAuxClick={(e) => e.button === 1 && open(props.file, e)}
      {...stylex.attrs(styles.mention)}
      data-file-mention={props.file.name}
    >
      <Icon name={kindOf(props.file).icon} size={12} />
      <span {...stylex.attrs(styles.mentionLabel)}>{props.label}</span>
    </button>
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
});
