// A tab's icon wherever the tab shows up, and the picker for choosing one.
// A tab's own icon is a Lucide icon name, an emoji or an image (data URL);
// without one, apps show a window and web tabs their site's favicon.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { isEmojiIcon, isImageIcon, type AppSummary, type WorkspaceInfo } from "../../shared/api";
import { rankIcons } from "../../shared/icons";
import { setTabIcon, updateWorkspace } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon, iconFor, iconTags } from "./Icon";
import { toast } from "./Toast";

export function TabIcon(props: {
  tab: Pick<AppSummary, "kind" | "icon" | "favicon"> & Partial<Pick<AppSummary, "url">>;
  size?: number;
}) {
  const size = () => props.size ?? 16;
  const isFile = () => /^file:/i.test(props.tab.url ?? "");
  const fallback = () =>
    props.tab.kind === "web" ? (
      <Show when={!isFile()} fallback={<Icon name="file" size={size()} {...stylex.attrs(styles.icon)} />}>
        <Favicon url={props.tab.favicon} size={size()} />
      </Show>
    ) : (
      <Icon name="app-window" size={size()} {...stylex.attrs(styles.icon)} />
    );
  return (
    <Show when={props.tab.icon} fallback={fallback()}>
      {(icon) => (
        <Show
          when={isImageIcon(icon())}
          fallback={
            <Icon
              name={icon()}
              size={size()}
              {...stylex.attrs(styles.icon)}
              fallback={<span {...stylex.attrs(styles.icon, styles.text)}>{icon()}</span>}
            />
          }
        >
          <img src={icon()} alt="" width={size()} height={size()} {...stylex.attrs(styles.image)} data-tab-icon-image />
        </Show>
      )}
    </Show>
  );
}

function Favicon(props: { url: string | null; size: number }) {
  const [broken, setBroken] = createSignal<string | null>(null);
  return (
    <Show
      when={props.url && broken() !== props.url}
      fallback={<Icon name="globe" size={props.size} {...stylex.attrs(styles.icon)} />}
    >
      <img
        src={props.url!}
        alt=""
        width={props.size}
        height={props.size}
        onError={() => setBroken(props.url)}
        {...stylex.attrs(styles.image)}
      />
    </Show>
  );
}

/** Shown before anything is typed. */
const suggestions = [
  "app-window",
  "layout-dashboard",
  "list-todo",
  "notebook-pen",
  "calendar",
  "wallet",
  "chart-line",
  "shopping-cart",
  "book-open",
  "music",
  "image",
  "camera",
  "mail",
  "message-circle",
  "users",
  "briefcase",
  "house",
  "heart",
  "star",
  "flame",
  "rocket",
  "sparkles",
  "lightbulb",
  "target",
  "globe",
  "code",
  "terminal",
  "database",
  "bot",
  "gamepad-2",
  "dumbbell",
  "utensils",
  "plane",
  "map",
  "graduation-cap",
  "palette",
  "leaf",
  "coffee",
  "film",
  "newspaper",
];
const emojis = ["😀", "🚀", "✨", "🔥", "📚", "📝", "💰", "📈", "🛒", "🎵", "🎮", "🏠", "❤️", "⭐", "🌱", "☕"];

/** Scales an uploaded image down to a 64px square PNG (whatever its format), so it stays small. */
async function toIconImage(file: File): Promise<string> {
  if (file.size > 10_000_000) throw new Error("That image is too big (at most 10 MB).");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {
      throw new Error("That file isn't an image Rune Browser can read.");
    });
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const w = img.naturalWidth || size;
    const h = img.naturalHeight || size;
    const scale = Math.min(size / w, size / h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, (size - w * scale) / 2, (size - h * scale) / 2, w * scale, h * scale);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Picks a tab's icon: a Lucide icon (searchable), an emoji, an uploaded image, or the default. */
/** Picks a tab's own icon (Lucide, emoji or an uploaded image), or a workspace's (Lucide or emoji). */
export function IconPicker(props: {
  tab?: AppSummary;
  workspace?: WorkspaceInfo;
  position: { x: number; y: number };
  onClose: () => void;
}) {
  let root!: HTMLDivElement;
  let fileInput!: HTMLInputElement;
  const [query, setQuery] = createSignal("");
  const [pos, setPos] = createSignal(props.position);
  const [busy, setBusy] = createSignal(false);

  const typed = () => query().trim();
  const typedEmoji = () => (isEmojiIcon(typed()) ? typed() : null);
  const results = createMemo(() =>
    (typed() ? rankIcons(iconTags, typed(), 48) : suggestions).filter((name) => iconFor(name)),
  );

  const choose = async (icon: string | null) => {
    setBusy(true);
    try {
      if (props.tab) await setTabIcon(props.tab.id, icon);
      else if (props.workspace) await updateWorkspace(props.workspace.id, { icon });
      props.onClose();
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : String(err), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    try {
      await choose(await toIconImage(file));
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : String(err), kind: "error" });
    }
  };

  onMount(() => {
    const rect = root.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(props.position.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(props.position.y, window.innerHeight - rect.height - 4)),
    });
    root.querySelector("input")?.focus();
    // Not closed on blur: the file dialog takes the focus away.
    const onPointer = (e: PointerEvent) => {
      if (!root.contains(e.target as Node)) props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  const currentIcon = () => (props.tab ? props.tab.icon : (props.workspace?.icon ?? null));
  const isCurrent = (icon: string) => currentIcon() === icon;

  return (
    <Portal>
      <div
        ref={root}
        role="dialog"
        aria-label={`Icon for ${props.tab?.name ?? props.workspace?.name ?? ""}`}
        {...stylex.attrs(styles.picker)}
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        // Events from a portal reach the component that opened it (a sidebar tab, which would select or rename itself).
        onClick={(e) => e.stopPropagation()}
        onDblClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => (e.preventDefault(), e.stopPropagation())}
        data-icon-picker
      >
        <div {...stylex.attrs(styles.header)}>
          <span {...stylex.attrs(styles.preview)}>
            <Show
              when={props.tab}
              fallback={
                <Icon
                  name={currentIcon()}
                  size={18}
                  fallback={
                    <span {...stylex.attrs(styles.text)}>
                      {currentIcon() ?? props.workspace?.name.charAt(0).toUpperCase()}
                    </span>
                  }
                />
              }
            >
              {(tab) => <TabIcon tab={tab()} size={18} />}
            </Show>
          </span>
          <input
            value={query()}
            placeholder="Search icons, or type an emoji"
            aria-label="Search icons"
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const first = typedEmoji() ?? results()[0];
              if (first) void choose(first);
            }}
            {...stylex.attrs(styles.search)}
          />
        </div>
        <Show when={typedEmoji()}>
          {(emoji) => (
            <button type="button" disabled={busy()} onClick={() => void choose(emoji())} {...stylex.attrs(styles.wide)}>
              <span {...stylex.attrs(styles.text)}>{emoji()}</span> Use this emoji
            </button>
          )}
        </Show>
        <div {...stylex.attrs(styles.grid)}>
          <For each={results()} fallback={<p {...stylex.attrs(styles.empty)}>No icons match.</p>}>
            {(name) => {
              const on = () => isCurrent(name);
              return (
                <button
                  type="button"
                  title={name}
                  disabled={busy()}
                  aria-pressed={on()}
                  onClick={() => void choose(name)}
                  {...stylex.attrs(styles.cell, on() && styles.cellOn)}
                  data-icon={name}
                >
                  <Icon name={name} size={18} />
                </button>
              );
            }}
          </For>
        </div>
        <Show when={!typed()}>
          <div {...stylex.attrs(styles.grid)}>
            <For each={emojis}>
              {(emoji) => {
                const on = () => isCurrent(emoji);
                return (
                  <button
                    type="button"
                    disabled={busy()}
                    aria-pressed={on()}
                    onClick={() => void choose(emoji)}
                    {...stylex.attrs(styles.cell, styles.text, on() && styles.cellOn)}
                  >
                    {emoji}
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
        <div {...stylex.attrs(styles.footer)}>
          <Show when={props.tab}>
            <button
              type="button"
              disabled={busy()}
              onClick={() => fileInput.click()}
              {...stylex.attrs(styles.action)}
              data-icon-upload
            >
              <Icon name="upload" size={14} />
              Upload image…
            </button>
          </Show>
          <Show when={currentIcon()}>
            <button
              type="button"
              disabled={busy()}
              onClick={() => void choose(null)}
              {...stylex.attrs(styles.action)}
              data-icon-reset
            >
              <Icon name="rotate-ccw" size={14} />
              {props.workspace
                ? "Use its initial"
                : props.tab?.kind === "web"
                  ? "Use the site's icon"
                  : "Use the default"}
            </button>
          </Show>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            void upload(file);
          }}
          data-icon-file
        />
      </div>
    </Portal>
  );
}

const styles = stylex.create({
  icon: { width: 18, textAlign: "center", flexShrink: 0, color: colors.muted },
  text: { fontSize: 15, lineHeight: 1, color: colors.text },
  image: { flexShrink: 0, objectFit: "contain", borderRadius: 3, marginInline: 1 },
  picker: {
    position: "fixed",
    zIndex: 1000,
    width: 316,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    padding: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.14), 0 2px 6px rgb(0 0 0 / 0.08)",
    fontFamily: font.sans,
    fontSize: font.sm,
    color: colors.text,
  },
  header: { display: "flex", alignItems: "center", gap: space.sm },
  preview: {
    display: "grid",
    placeItems: "center",
    width: 32,
    height: 32,
    flexShrink: 0,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceHover,
  },
  search: {
    flex: 1,
    minWidth: 0,
    height: 32,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    backgroundColor: colors.bg,
    outline: "none",
    fontSize: font.sm,
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 2, maxHeight: 216, overflowY: "auto" },
  cell: {
    display: "grid",
    placeItems: "center",
    aspectRatio: "1",
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    cursor: "pointer",
  },
  cellOn: { backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft }, color: colors.accent },
  empty: { gridColumn: "1 / -1", margin: 0, paddingBlock: space.md, color: colors.muted, textAlign: "center" },
  wide: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    height: 32,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: colors.surfaceHover, ":hover": colors.accentSoft },
    color: colors.text,
    cursor: "pointer",
  },
  footer: {
    display: "flex",
    gap: space.xs,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  action: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.xs,
    cursor: { default: "pointer", ":disabled": "progress" },
  },
});
