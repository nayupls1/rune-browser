// The app tab's tools panel: what the app offers in Rune Browser's tool registry
// (its own actions and the basic ones from its data), each runnable by hand.
import * as stylex from "@stylexjs/stylex";
import { createResource, createSignal, For, Show } from "solid-js";
import type { AppTool, ToolResult } from "../../shared/api";
import { api } from "../lib/api";
import { openInApp } from "../lib/commands";
import { colors, font, radius, space } from "../theme.stylex";
import { Icon } from "./Icon";
import { Button } from "./ui";

export function ToolsPanel(props: { appId: string; onClose: () => void }) {
  const [version, setVersion] = createSignal(0);
  const [tools] = createResource(
    () => [props.appId, version()] as const,
    ([id]) => api.appTools(id),
  );
  const actions = () => tools()?.filter((t) => t.source === "action") ?? [];
  const derived = () => tools()?.filter((t) => t.source === "data") ?? [];

  return (
    <div {...stylex.attrs(styles.panel)} data-tools-panel>
      <div {...stylex.attrs(styles.panelHeader)}>
        <Icon name="wrench" size={14} />
        <span {...stylex.attrs(styles.panelTitle)}>Tools</span>
        <button
          type="button"
          title="Refresh"
          onClick={() => setVersion((v) => v + 1)}
          {...stylex.attrs(styles.iconButton)}
        >
          <Icon name="refresh-cw" size={14} />
        </button>
        <button type="button" title="Close" onClick={props.onClose} {...stylex.attrs(styles.iconButton)}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div {...stylex.attrs(styles.panelBody)}>
        <p {...stylex.attrs(styles.note)}>
          What this app can do, for you, agents and other apps in this workspace (they need your OK). Actions come from
          its <code>rune.json</code>; the rest Rune Browser derives from its data.
        </p>
        <Show when={tools() && !tools()!.length}>
          <p {...stylex.attrs(styles.note)} data-tools-empty>
            No tools yet: the app declares no actions and has no tables.
          </p>
        </Show>
        <Show when={actions().length}>
          <span {...stylex.attrs(styles.subhead)}>Actions</span>
          <For each={actions()}>{(tool) => <ToolRow appId={props.appId} tool={tool} />}</For>
        </Show>
        <Show when={derived().length}>
          <span {...stylex.attrs(styles.subhead)}>From its data</span>
          <For each={derived()}>{(tool) => <ToolRow appId={props.appId} tool={tool} />}</For>
        </Show>
      </div>
    </div>
  );
}

function ToolRow(props: { appId: string; tool: AppTool }) {
  const [open, setOpen] = createSignal(false);
  const [values, setValues] = createSignal<Record<string, string>>({});
  const [input, setInput] = createSignal("");
  const [result, setResult] = createSignal<ToolResult>();
  const [running, setRunning] = createSignal(false);
  const params = () => Object.entries(props.tool.params);
  const set = (name: string, value: string) => setValues((v) => ({ ...v, [name]: value }));
  const failed = () => result()?.ok === false;

  const run = async (e: Event) => {
    e.preventDefault();
    if (props.tool.path) return void openInApp(props.appId, props.tool.path);
    const out: Record<string, unknown> = {};
    for (const [name, spec] of params()) {
      const raw = values()[name]?.trim();
      if (!raw) continue;
      if (spec.type === "boolean") out[name] = raw === "true";
      else if (spec.type === "object") {
        try {
          out[name] = JSON.parse(raw);
        } catch {
          return setResult({ ok: false, status: 400, message: `${name} isn't valid JSON` });
        }
      } else out[name] = raw;
    }
    setRunning(true);
    try {
      setResult(
        await api.callTool(props.appId, props.tool.id, {
          params: out,
          ...(props.tool.input ? { input: input() } : {}),
        }),
      );
    } catch (err) {
      setResult({ ok: false, status: 0, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div {...stylex.attrs(styles.tool)} data-tool={props.tool.id}>
      <button type="button" onClick={() => setOpen((o) => !o)} {...stylex.attrs(styles.toolHead)}>
        <Icon name={open() ? "chevron-down" : "chevron-right"} size={13} />
        <code {...stylex.attrs(styles.toolId)}>{props.tool.id}</code>
        <span {...stylex.attrs(styles.toolTitle)}>{props.tool.description ?? props.tool.title}</span>
        <Show when={props.tool.readOnly}>
          <span {...stylex.attrs(styles.badge)}>read-only</span>
        </Show>
      </button>
      <Show when={open()}>
        <form onSubmit={run} {...stylex.attrs(styles.form)}>
          <For each={params()}>
            {([name, spec]) => (
              <label {...stylex.attrs(styles.field)}>
                <span {...stylex.attrs(styles.fieldName)}>
                  {name}
                  <Show when={spec.required}>*</Show>
                </span>
                <Show
                  when={spec.type === "boolean"}
                  fallback={
                    <input
                      value={values()[name] ?? ""}
                      placeholder={spec.type === "object" ? "{ … } (JSON)" : (spec.description ?? spec.type)}
                      inputMode={spec.type === "number" || spec.type === "integer" ? "decimal" : undefined}
                      onInput={(e) => set(name, e.currentTarget.value)}
                      {...stylex.attrs(styles.input)}
                      data-tool-param={name}
                    />
                  }
                >
                  <input
                    type="checkbox"
                    checked={values()[name] === "true"}
                    onChange={(e) => set(name, e.currentTarget.checked ? "true" : "")}
                  />
                </Show>
              </label>
            )}
          </For>
          <Show when={props.tool.input}>
            <label {...stylex.attrs(styles.field)}>
              <span {...stylex.attrs(styles.fieldName)}>input</span>
              <input
                value={input()}
                placeholder={props.tool.input}
                onInput={(e) => setInput(e.currentTarget.value)}
                {...stylex.attrs(styles.input)}
              />
            </label>
          </Show>
          <div>
            <Button variant="primary" type="submit" disabled={running()} data-run-tool>
              {props.tool.path ? "Open" : running() ? "Running…" : "Run"}
            </Button>
          </div>
          <Show when={result()}>
            <div {...stylex.attrs(styles.result, failed() && styles.resultError)} data-tool-result>
              {result()!.message || (result()!.ok ? "Done" : `Failed (${result()!.status})`)}
            </div>
            <Show when={result()!.data !== undefined}>
              <pre {...stylex.attrs(styles.data)}>{JSON.stringify(result()!.data, null, 2)}</pre>
            </Show>
          </Show>
        </form>
      </Show>
    </div>
  );
}

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    maxHeight: 380,
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  panelHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 34,
    flexShrink: 0,
    paddingInline: space.md,
    color: colors.muted,
  },
  panelTitle: { flex: 1, fontSize: font.xs, fontWeight: 600 },
  panelBody: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    minHeight: 0,
    overflowY: "auto",
    paddingInline: space.md,
    paddingBottom: space.md,
  },
  note: { margin: 0, color: colors.muted, fontSize: font.xs, lineHeight: 1.5 },
  subhead: {
    marginTop: space.sm,
    color: colors.muted,
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
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
  tool: { display: "flex", flexDirection: "column" },
  toolHead: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    minWidth: 0,
    height: 28,
    paddingInline: 4,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    textAlign: "left",
    cursor: "pointer",
  },
  toolId: { flexShrink: 0, color: colors.text, fontFamily: font.mono, fontSize: font.xs, fontWeight: 600 },
  toolTitle: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: font.xs,
  },
  badge: {
    flexShrink: 0,
    paddingInline: 6,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceHover,
    color: colors.muted,
    fontSize: 11,
  },
  form: { display: "flex", flexDirection: "column", gap: 6, paddingBlock: space.sm, paddingLeft: 25 },
  field: { display: "flex", alignItems: "center", gap: space.sm },
  fieldName: { width: 110, flexShrink: 0, color: colors.muted, fontFamily: font.mono, fontSize: font.xs },
  input: {
    flex: 1,
    maxWidth: 360,
    height: 28,
    paddingInline: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus": colors.accent },
    outline: "none",
    backgroundColor: colors.bg,
    color: colors.text,
    fontSize: font.sm,
  },
  result: { color: colors.success, fontSize: font.xs },
  resultError: { color: colors.danger },
  data: {
    margin: 0,
    maxHeight: 180,
    overflow: "auto",
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily: font.mono,
    fontSize: 11,
  },
});
