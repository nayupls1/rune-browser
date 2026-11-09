// A tab's icon wherever the tab shows up, and the picker for choosing one.
// A tab's own icon is a Lucide icon name, an emoji or an image (data URL);
// without one, apps show a window and web tabs their site's favicon.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { isEmojiIcon, isImageIcon, type AppSummary } from "../../shared/api";
import { rankIcons } from "../../shared/icons";
import { setTabIcon } from "../lib/store";
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

/**
 * Icons to choose from: a search over Lucide's icons (or an emoji typed in it), and before anything is typed,
 * suggestions and emojis. Used by the tab icon picker and the workspace editor.
 */
export function IconChoices(props: {
  current: string | null;
  disabled?: boolean;
  onChoose: (icon: string) => void;
  /** The search field, for focusing it. */
  searchRef?: (el: HTMLInputElement) => void;
  /** Before the search field (the icon's preview). */
  before?: JSX.Element;
}) {
  const [query, setQuery] = createSignal("");
  const typed = () => query().trim();
  const typedEmoji = () => (isEmojiIcon(typed()) ? typed() : null);
  const results = createMemo(() =>
    (typed() ? rankIcons(iconTags, typed(), 48) : suggestions).filter((name) => iconFor(name)),
  );
  const isCurrent = (icon: string) => props.current === icon;
  return (
    <>
      <div {...stylex.attrs(styles.header)}>
        {props.before}
        <input
          ref={props.searchRef}
          value={query()}
          placeholder="Search icons, or type an emoji"
          aria-label="Search icons"
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            const first = typedEmoji() ?? results()[0];
            if (first) props.onChoose(first);
          }}
          {...stylex.attrs(styles.search)}
          data-icon-search
        />
      </div>
      <Show when={typedEmoji()}>
        {(emoji) => (
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.onChoose(emoji())}
            {...stylex.attrs(styles.wide)}
          >
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
                disabled={props.disabled}
                aria-pressed={on()}
                onClick={() => props.onChoose(name)}
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
                  disabled={props.disabled}
                  aria-pressed={on()}
                  onClick={() => props.onChoose(emoji)}
                  {...stylex.attrs(styles.cell, styles.text, on() && styles.cellOn)}
                  data-emoji={emoji}
                >
                  {emoji}
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </>
  );
}

/** Picks a tab's own icon: a Lucide icon (searchable), an emoji, an uploaded image, or the default. */
export function IconPicker(props: { tab: AppSummary; position: { x: number; y: number }; onClose: () => void }) {
  let root!: HTMLDivElement;
  let fileInput!: HTMLInputElement;
  const [pos, setPos] = createSignal(props.position);
  const [busy, setBusy] = createSignal(false);

  const choose = async (icon: string | null) => {
    setBusy(true);
    try {
      await setTabIcon(props.tab.id, icon);
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

  return (
    <Portal>
      <div
        ref={root}
        role="dialog"
        aria-label={`Icon for ${props.tab.name}`}
        {...stylex.attrs(styles.picker)}
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        // Events from a portal reach the component that opened it (a sidebar tab, which would select or rename itself).
        onClick={(e) => e.stopPropagation()}
        onDblClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => (e.preventDefault(), e.stopPropagation())}
        data-icon-picker
      >
        <IconChoices
          current={props.tab.icon}
          disabled={busy()}
          onChoose={(icon) => void choose(icon)}
          before={
            <span {...stylex.attrs(styles.preview)}>
              <TabIcon tab={props.tab} size={18} />
            </span>
          }
        />
        <div {...stylex.attrs(styles.footer)}>
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
          <Show when={props.tab.icon}>
            <button
              type="button"
              disabled={busy()}
              onClick={() => void choose(null)}
              {...stylex.attrs(styles.action)}
              data-icon-reset
            >
              <Icon name="rotate-ccw" size={14} />
              {props.tab.kind === "web" ? "Use the site's icon" : "Use the default"}
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
