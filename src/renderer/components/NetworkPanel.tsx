// A web tab's network traffic (recorded in the main process, see main/network.ts):
// requests and their data, sending one again with the session, saving it for
// later, blocking ones like it. Credentials are hidden until you ask to see them.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import type { NetworkEntry, NetworkEntrySummary, ReplayResult, SavedRequest } from "../../shared/api";
import { topics } from "../../shared/hub";
import { api } from "../lib/api";
import { watchTopic } from "../lib/realtime";
import { isPrivate } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { toast } from "./Toast";
import { Button } from "./ui";

const network = window.rune.web.network;

export function NetworkPanel(props: {
  webContentsId: () => number | null;
  workspaceId: () => string;
  onClose: () => void;
}) {
  const [view, setView] = createSignal<"requests" | "saved">("requests");
  const [query, setQuery] = createSignal("");
  const [dataOnly, setDataOnly] = createSignal(true);
  const [entries, setEntries] = createSignal<NetworkEntrySummary[]>([]);
  const [selected, setSelected] = createSignal<string>();

  const refresh = async () => {
    const id = props.webContentsId();
    if (id === null) return;
    setEntries(
      await network.list(id, { query: query(), kind: dataOnly() ? "data" : "all", limit: 500 }).catch(() => []),
    );
  };
  createEffect(on([query, dataOnly], () => void refresh()));
  onCleanup(
    network.onChanged((id) => {
      if (id === props.webContentsId()) void refresh();
    }),
  );

  const clear = async () => {
    const id = props.webContentsId();
    if (id !== null) await network.clear(id);
    setSelected();
    void refresh();
  };

  const isRequests = () => view() === "requests";
  const isSaved = () => view() === "saved";

  return (
    <section {...stylex.attrs(styles.panel)} data-network-panel>
      <header {...stylex.attrs(styles.header)}>
        <div {...stylex.attrs(styles.tabs)} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={isRequests()}
            onClick={() => setView("requests")}
            {...stylex.attrs(styles.tab, isRequests() && styles.tabActive)}
          >
            Requests
          </button>
          {/* Saved requests and rules are kept: a private window keeps nothing. */}
          <Show when={!isPrivate}>
            <button
              type="button"
              role="tab"
              aria-selected={isSaved()}
              onClick={() => setView("saved")}
              {...stylex.attrs(styles.tab, isSaved() && styles.tabActive)}
              data-network-saved-tab
            >
              Saved
            </button>
          </Show>
        </div>
        <Show when={isRequests()}>
          <input
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            placeholder="Filter"
            spellcheck={false}
            {...stylex.attrs(styles.filter)}
            data-network-filter
          />
          <label {...stylex.attrs(styles.check)}>
            <input
              type="checkbox"
              checked={dataOnly()}
              onChange={(e) => setDataOnly(e.currentTarget.checked)}
              data-network-data-only
            />
            Data only
          </label>
          <span {...stylex.attrs(styles.muted)}>
            {entries().length} {entries().length === 1 ? "request" : "requests"}
          </span>
        </Show>
        <span {...stylex.attrs(styles.spacer)} />
        <Show when={isRequests()}>
          <button type="button" title="Clear" onClick={() => void clear()} {...stylex.attrs(styles.iconButton)}>
            <Icon name="ban" size={14} />
          </button>
        </Show>
        <button type="button" title="Close" onClick={() => props.onClose()} {...stylex.attrs(styles.iconButton)}>
          <Icon name="x" size={15} />
        </button>
      </header>
      <Show when={isRequests()} fallback={<SavedRequests workspaceId={props.workspaceId} />}>
        <div {...stylex.attrs(styles.body)}>
          <div {...stylex.attrs(styles.list)} role="list">
            <For
              each={entries()}
              fallback={
                <p {...stylex.attrs(styles.empty)}>
                  {dataOnly()
                    ? "No data requests yet. Reload the page, or show everything."
                    : "Nothing recorded yet. Reload the page."}
                </p>
              }
            >
              {(entry) => (
                <RequestRow entry={entry} selected={selected() === entry.id} onSelect={() => setSelected(entry.id)} />
              )}
            </For>
          </div>
          <Show when={selected()}>
            {(id) => (
              <RequestDetail
                id={id()}
                webContentsId={props.webContentsId}
                workspaceId={props.workspaceId}
                onClose={() => setSelected()}
              />
            )}
          </Show>
        </div>
      </Show>
    </section>
  );
}

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return { path: `${u.pathname}${u.search}`, host: u.host };
  } catch {
    return { path: url, host: "" };
  }
};

const sizeLabel = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} kB` : `${n} B`;

function StatusBadge(props: { status: number | null; error: string | null }) {
  const bad = () => !!props.error || (props.status ?? 0) >= 400;
  return (
    <span {...stylex.attrs(styles.status, bad() && styles.statusBad)}>
      {props.error ? "failed" : (props.status ?? "…")}
    </span>
  );
}

function RequestRow(props: { entry: NetworkEntrySummary; selected: boolean; onSelect: () => void }) {
  const where = () => pathOf(props.entry.url);
  const blocked = () => !!props.entry.rule;
  const isSelected = () => props.selected;
  return (
    <button
      type="button"
      role="listitem"
      onClick={() => props.onSelect()}
      {...stylex.attrs(styles.row, isSelected() && styles.rowSelected)}
      title={props.entry.error ?? props.entry.url}
      data-network-entry={props.entry.id}
    >
      <span {...stylex.attrs(styles.method)}>{props.entry.method}</span>
      <StatusBadge status={props.entry.status} error={props.entry.error} />
      <span {...stylex.attrs(styles.path)}>
        {where().path}
        <span {...stylex.attrs(styles.host)}> {where().host}</span>
      </span>
      <Show when={blocked()}>
        <Icon name="shield" size={12} {...stylex.attrs(styles.ruleIcon)} />
      </Show>
      <Show when={props.entry.override}>
        <span title={`Overridden: ${props.entry.override}`} {...stylex.attrs(styles.overrideMark)} data-overridden>
          <Icon name="flask-conical" size={12} />
        </span>
      </Show>
      <span {...stylex.attrs(styles.cell)}>{props.entry.type}</span>
      <span {...stylex.attrs(styles.cell)}>{props.entry.size ? sizeLabel(props.entry.size) : ""}</span>
      <span {...stylex.attrs(styles.cell)}>
        {props.entry.durationMs !== null ? `${props.entry.durationMs} ms` : ""}
      </span>
    </button>
  );
}

/** JSON pretty-printed; anything else as it is. */
const pretty = (body: string) => {
  try {
    const text = JSON.stringify(JSON.parse(body), null, 2);
    return text.length > 300_000 ? `${text.slice(0, 300_000)}…` : text;
  } catch {
    return body.length > 300_000 ? `${body.slice(0, 300_000)}…` : body;
  }
};

function RequestDetail(props: {
  id: string;
  webContentsId: () => number | null;
  workspaceId: () => string;
  onClose: () => void;
}) {
  const [reveal, setReveal] = createSignal(false);
  const [result, setResult] = createSignal<ReplayResult>();
  const [sending, setSending] = createSignal(false);
  const [naming, setNaming] = createSignal(false);
  const [entry, { refetch }] = createResource(
    () => ({ id: props.id, reveal: reveal() }),
    ({ id, reveal }): Promise<NetworkEntry | null> => {
      const wc = props.webContentsId();
      return wc === null ? Promise.resolve(null) : network.get(wc, id, reveal);
    },
  );
  createEffect(
    on(
      () => props.id,
      () => setResult(),
    ),
  );
  // Bodies arrive a moment after the request finished.
  onCleanup(
    network.onChanged((id) => {
      if (id === props.webContentsId() && !entry()?.responseBody && !entry()?.bodyNote) void refetch();
    }),
  );

  const send = async () => {
    const wc = props.webContentsId();
    if (wc === null) return;
    setSending(true);
    try {
      setResult(await network.replay({ webContentsId: wc, id: props.id }, {}, reveal()));
    } catch (err) {
      toast({ title: "Couldn't send it", message: err instanceof Error ? err.message : String(err), kind: "error" });
    } finally {
      setSending(false);
    }
  };

  const save = async (name: string) => {
    const wc = props.webContentsId();
    if (wc === null || !name.trim()) return;
    setNaming(false);
    try {
      const saved = await api.saveRequest(props.workspaceId(), name.trim(), await network.draft(wc, props.id));
      toast({
        message: `Saved “${saved.name}”. Send it again from the Saved tab, even without opening the site.`,
        kind: "success",
      });
    } catch (err) {
      toast({ title: "Couldn't save it", message: err instanceof Error ? err.message : String(err), kind: "error" });
    }
  };

  const block = async (e: NetworkEntry) => {
    const { path, host } = pathOf(e.url);
    const pattern = `*://${host}${path.split("?")[0]}*`;
    if (
      !(await confirmDialog(`Block requests matching ${pattern} in this workspace's web tabs?`, {
        confirmLabel: "Block",
      }))
    )
      return;
    await api.addNetworkRule({
      workspaceId: props.workspaceId(),
      pattern,
      action: "block",
      requestHeaders: {},
      responseHeaders: {},
    });
    toast({
      message: `Blocking ${pattern}. Rules are in Settings → Web tools → Network rules.`,
      kind: "success",
    });
  };

  return (
    <div {...stylex.attrs(styles.detail)} data-network-detail>
      <Show
        when={entry()}
        fallback={<p {...stylex.attrs(styles.empty)}>{entry.loading ? "" : "This request is no longer in the log."}</p>}
      >
        {(e) => (
          <>
            <div {...stylex.attrs(styles.detailHead)}>
              <span {...stylex.attrs(styles.method)}>{e().method}</span>
              <StatusBadge status={e().status} error={e().error} />
              <Show when={e().override}>
                <span title={`Overridden: ${e().override}`} {...stylex.attrs(styles.overrideMark)}>
                  <Icon name="flask-conical" size={12} />
                </span>
              </Show>
              <span {...stylex.attrs(styles.url)}>{e().url}</span>
              <button type="button" title="Close" onClick={() => props.onClose()} {...stylex.attrs(styles.iconButton)}>
                <Icon name="x" size={14} />
              </button>
            </div>
            <div {...stylex.attrs(styles.actions)}>
              <Button onClick={() => void send()} disabled={sending()} data-network-replay>
                <Icon name="send" size={13} />
                {sending() ? "Sending…" : "Send again"}
              </Button>
              <Show
                when={naming()}
                fallback={
                  <Show when={!isPrivate}>
                    <Button onClick={() => setNaming(true)} data-network-save>
                      <Icon name="bookmark" size={13} />
                      Save
                    </Button>
                  </Show>
                }
              >
                <input
                  ref={(el) => queueMicrotask(() => el.focus())}
                  placeholder="Name, then Enter"
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter") void save(ev.currentTarget.value);
                    else if (ev.key === "Escape") setNaming(false);
                  }}
                  onBlur={() => setNaming(false)}
                  {...stylex.attrs(styles.filter)}
                  data-network-save-name
                />
              </Show>
              <Show when={!isPrivate}>
                <Button onClick={() => void block(e())} data-network-block>
                  <Icon name="shield-ban" size={13} />
                  Block like this
                </Button>
              </Show>
              <span {...stylex.attrs(styles.spacer)} />
              <label
                {...stylex.attrs(styles.check)}
                title="Cookies, tokens and passwords are hidden until you show them"
              >
                <input
                  type="checkbox"
                  checked={reveal()}
                  onChange={(ev) => setReveal(ev.currentTarget.checked)}
                  data-network-reveal
                />
                Show credentials
              </label>
            </div>
            <div {...stylex.attrs(styles.sections)}>
              <Show when={result()}>
                {(r) => (
                  <Block
                    title={`Sent again: HTTP ${r().status} ${r().statusText} · ${sizeLabel(r().size)} · ${r().durationMs} ms`}
                    data-network-result
                  >
                    <pre {...stylex.attrs(styles.pre)}>{r().body !== null ? pretty(r().body!) : "(no text body)"}</pre>
                  </Block>
                )}
              </Show>
              <Block title="Response">
                <Show
                  when={e().responseBody !== null}
                  fallback={
                    <p {...stylex.attrs(styles.muted)}>
                      {e().bodyNote ?? (e().status === null ? "Waiting…" : "No body")}
                    </p>
                  }
                >
                  <pre {...stylex.attrs(styles.pre)} data-network-response>
                    {pretty(e().responseBody!)}
                  </pre>
                </Show>
              </Block>
              <Show when={e().requestBody !== null}>
                <Block title="Request body">
                  <pre {...stylex.attrs(styles.pre)}>{pretty(e().requestBody!)}</pre>
                </Block>
              </Show>
              <Block title="Response headers">
                <Headers headers={e().responseHeaders} />
              </Block>
              <Block title="Request headers">
                <Headers headers={e().requestHeaders} />
              </Block>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

function Block(props: { title: string; children: JSX.Element; "data-network-result"?: boolean }) {
  return (
    <div {...stylex.attrs(styles.block)} data-network-result={props["data-network-result"]}>
      <h4 {...stylex.attrs(styles.blockTitle)}>{props.title}</h4>
      {props.children}
    </div>
  );
}

function Headers(props: { headers: Record<string, string> }) {
  const list = createMemo(() => Object.entries(props.headers).sort(([a], [b]) => a.localeCompare(b)));
  return (
    <Show when={list().length} fallback={<p {...stylex.attrs(styles.muted)}>None</p>}>
      <dl {...stylex.attrs(styles.headers)}>
        <For each={list()}>
          {([name, value]) => (
            <>
              <dt {...stylex.attrs(styles.headerName)}>{name}</dt>
              <dd {...stylex.attrs(styles.headerValue)}>{value}</dd>
            </>
          )}
        </For>
      </dl>
    </Show>
  );
}

/** Requests saved in the workspace: sent with its session, without opening the site. */
function SavedRequests(props: { workspaceId: () => string }) {
  const [list, { refetch }] = createResource(props.workspaceId, (id) => api.savedRequests(id));
  onCleanup(
    watchTopic(topics.network, (msg) => {
      if (msg.type === "network-changed" && msg.what === "requests") void refetch();
    }),
  );
  const [results, setResults] = createSignal<Record<string, ReplayResult | string>>({});
  const [sending, setSending] = createSignal<string>();

  const send = async (saved: SavedRequest) => {
    setSending(saved.id);
    try {
      const result = await api.sendSavedRequest(saved.id);
      setResults({ ...results(), [saved.id]: result });
    } catch (err) {
      setResults({ ...results(), [saved.id]: err instanceof Error ? err.message : String(err) });
    } finally {
      setSending();
    }
  };

  return (
    <div {...stylex.attrs(styles.savedList)}>
      <For
        each={list()}
        fallback={
          <p {...stylex.attrs(styles.empty)}>
            Nothing saved yet. Pick a request and Save it to fetch its data again later, without opening the site.
          </p>
        }
      >
        {(saved) => {
          const result = () => results()[saved.id];
          return (
            <div {...stylex.attrs(styles.saved)} data-saved-request={saved.name}>
              <div {...stylex.attrs(styles.savedHead)}>
                <strong>{saved.name}</strong>
                <span {...stylex.attrs(styles.method)}>{saved.method}</span>
                <span {...stylex.attrs(styles.url)}>{saved.url}</span>
                <Show when={saved.hasCredentials}>
                  <Icon name="lock" size={12} {...stylex.attrs(styles.ruleIcon)} />
                </Show>
                <Button onClick={() => void send(saved)} disabled={sending() === saved.id} data-send-saved>
                  {sending() === saved.id ? "Sending…" : "Send"}
                </Button>
                <button
                  type="button"
                  title="Delete"
                  onClick={async () => {
                    if (
                      await confirmDialog(`Delete the saved request “${saved.name}”?`, {
                        confirmLabel: "Delete",
                        danger: true,
                      })
                    )
                      await api.deleteSavedRequest(saved.id);
                  }}
                  {...stylex.attrs(styles.iconButton)}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
              <Show when={result()}>
                {(r) => {
                  const value = r();
                  return typeof value === "string" ? (
                    <p {...stylex.attrs(styles.error)}>{value}</p>
                  ) : (
                    <Block
                      title={`HTTP ${value.status} ${value.statusText} · ${sizeLabel(value.size)} · ${value.durationMs} ms`}
                      data-network-result
                    >
                      <pre {...stylex.attrs(styles.pre)}>
                        {value.body !== null ? pretty(value.body) : "(no text body)"}
                      </pre>
                    </Block>
                  );
                }}
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    height: "45%",
    minHeight: 180,
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: font.sm,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    paddingBlock: 6,
    paddingInline: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  tabs: { display: "flex", gap: 2 },
  tab: {
    paddingBlock: 4,
    paddingInline: space.sm,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    fontSize: font.sm,
    cursor: "pointer",
  },
  tabActive: { backgroundColor: colors.accentSoft, color: colors.accent, fontWeight: 500 },
  filter: {
    width: 200,
    height: 26,
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    color: colors.text,
    fontSize: font.sm,
    outline: "none",
  },
  check: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    color: colors.muted,
    whiteSpace: "nowrap",
    cursor: "pointer",
  },
  muted: { margin: 0, color: colors.muted, fontSize: font.xs },
  spacer: { flex: 1 },
  iconButton: {
    display: "grid",
    placeItems: "center",
    width: 26,
    height: 26,
    flexShrink: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: "pointer",
  },
  body: { display: "flex", flex: 1, minHeight: 0 },
  list: { flex: 1, minWidth: 0, overflowY: "auto", paddingBlock: 2 },
  empty: { margin: 0, padding: space.lg, color: colors.muted, textAlign: "center" },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    width: "100%",
    paddingBlock: 3,
    paddingInline: space.sm,
    borderWidth: 0,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.xs,
    textAlign: "left",
    cursor: "pointer",
  },
  rowSelected: { backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft } },
  method: { flexShrink: 0, width: 46, fontFamily: font.mono, fontSize: font.xs, color: colors.muted },
  status: { flexShrink: 0, width: 40, fontFamily: font.mono, fontSize: font.xs, color: colors.success },
  statusBad: { color: colors.danger },
  path: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: font.mono,
  },
  host: { color: colors.muted },
  ruleIcon: { flexShrink: 0, color: colors.warning },
  overrideMark: { display: "inline-flex", flexShrink: 0, color: colors.warning },
  cell: {
    flexShrink: 0,
    width: 64,
    color: colors.muted,
    textAlign: "right",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  detail: {
    display: "flex",
    flexDirection: "column",
    width: "48%",
    minWidth: 320,
    borderLeftWidth: 1,
    borderLeftStyle: "solid",
    borderLeftColor: colors.border,
    minHeight: 0,
  },
  detailHead: { display: "flex", alignItems: "center", gap: space.sm, paddingBlock: 6, paddingInline: space.sm },
  url: {
    flex: 1,
    minWidth: 0,
    fontFamily: font.mono,
    fontSize: font.xs,
    overflowWrap: "anywhere",
    maxHeight: 48,
    overflowY: "auto",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    flexWrap: "wrap",
    paddingInline: space.sm,
    paddingBottom: 6,
  },
  sections: { flex: 1, minHeight: 0, overflowY: "auto", paddingInline: space.sm, paddingBottom: space.sm },
  block: { display: "flex", flexDirection: "column", gap: 4, paddingBlock: 6 },
  blockTitle: {
    margin: 0,
    fontSize: font.xs,
    fontWeight: 600,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  pre: {
    margin: 0,
    padding: space.sm,
    maxHeight: 360,
    overflow: "auto",
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    fontFamily: font.mono,
    fontSize: font.xs,
    lineHeight: 1.45,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  headers: {
    display: "grid",
    gridTemplateColumns: "minmax(110px, max-content) 1fr",
    columnGap: space.md,
    rowGap: 2,
    margin: 0,
    fontSize: font.xs,
  },
  headerName: { color: colors.muted, fontFamily: font.mono },
  headerValue: { margin: 0, fontFamily: font.mono, overflowWrap: "anywhere" },
  savedList: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: space.sm,
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
  },
  saved: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  savedHead: { display: "flex", alignItems: "center", gap: space.sm },
  error: { margin: 0, color: colors.danger, fontSize: font.xs },
});
