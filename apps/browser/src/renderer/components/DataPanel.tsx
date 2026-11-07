// The app tab's data panel: what the app has stored (its tables and files,
// kept by Rune Browser outside the project), with a row browser, export and delete.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { api } from "../lib/api";
import { appById } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Button } from "./ui";

const PAGE = 50;

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const show = (value: unknown) =>
  value === null || value === undefined ? "NULL" : typeof value === "object" ? JSON.stringify(value) : String(value);

export function DataPanel(props: { appId: string; onClose: () => void }) {
  const [version, setVersion] = createSignal(0);
  const [overview] = createResource(
    () => [props.appId, version()] as const,
    ([id]) => api.appData(id),
  );
  const [table, setTable] = createSignal<string>();
  const [search, setSearch] = createSignal("");
  const [offset, setOffset] = createSignal(0);
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  // The first table, or none once it's gone.
  createEffect(() => {
    const tables = overview()?.tables;
    if (!tables) return;
    if (!table() || !tables.some((t) => t.name === table())) setTable(tables[0]?.name);
  });
  createEffect(on([table, search], () => setOffset(0), { defer: true }));

  const [rows] = createResource(
    () => (table() ? ([props.appId, table()!, search(), offset(), version()] as const) : undefined),
    ([id, name, text, from]) =>
      api.appDataRows(id, name, { offset: from, limit: PAGE, search: text.trim() || undefined }).catch((err: Error) => {
        setError(err.message);
        return undefined;
      }),
  );

  const empty = () => !!overview() && !overview()!.tables.length && !overview()!.files.count;
  const hasPrev = () => offset() > 0;
  const hasNext = () => !!rows() && offset() + PAGE < rows()!.total;
  const range = () => {
    const r = rows();
    if (!r?.total) return "no rows";
    return `${r.offset + 1}–${Math.min(r.offset + r.rows.length, r.total)} of ${r.total}`;
  };

  const exportData = async () => {
    setError();
    setBusy(true);
    try {
      const { blob, name } = await api.exportAppData(props.appId);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteData = async () => {
    const name = appById(props.appId)?.name ?? "this app";
    const ok = await confirmDialog(
      `Delete everything ${name} has stored (its database and files)? A snapshot is saved first, so you can restore it from History.`,
      { confirmLabel: "Delete data", danger: true },
    );
    if (!ok) return;
    setError();
    setBusy(true);
    try {
      await api.deleteAppData(props.appId);
      setVersion((v) => v + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div {...stylex.attrs(styles.panel)} data-data-panel>
      <div {...stylex.attrs(styles.panelHeader)}>
        <Icon name="database" size={14} />
        <span {...stylex.attrs(styles.panelTitle)}>Data</span>
        <Show when={overview()}>
          <span {...stylex.attrs(styles.meta)}>
            database {size(overview()!.databaseBytes)} · {overview()!.files.count} files (
            {size(overview()!.files.bytes)})
          </span>
        </Show>
        <button
          type="button"
          title="Refresh"
          onClick={() => setVersion((v) => v + 1)}
          {...stylex.attrs(styles.iconButton)}
        >
          <Icon name="refresh-cw" size={14} />
        </button>
        <button
          type="button"
          title="Export (.tar.gz)"
          disabled={busy()}
          onClick={() => void exportData()}
          {...stylex.attrs(styles.iconButton)}
          data-export-data
        >
          <Icon name="download" size={14} />
        </button>
        <button
          type="button"
          title="Delete all data"
          disabled={busy()}
          onClick={() => void deleteData()}
          {...stylex.attrs(styles.iconButton)}
          data-delete-data
        >
          <Icon name="trash" size={14} />
        </button>
        <button type="button" title="Close" onClick={props.onClose} {...stylex.attrs(styles.iconButton)}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div {...stylex.attrs(styles.panelBody)}>
        <Show when={error() ?? overview()?.error}>
          <p {...stylex.attrs(styles.error)}>{error() ?? overview()?.error}</p>
        </Show>
        <Show when={empty()}>
          <p {...stylex.attrs(styles.note)} data-data-empty>
            This app hasn't stored anything yet. Its database (<code>DATABASE_PATH</code>) and files (
            <code>RUNE_FILES_DIR</code>) are kept by Rune Browser outside the project, so rebuilds and resets don't
            touch them.
          </p>
        </Show>
        <Show when={overview()?.tables.length}>
          <div {...stylex.attrs(styles.tabs)}>
            <For each={overview()!.tables}>
              {(t) => {
                const active = () => table() === t.name;
                return (
                  <button
                    type="button"
                    onClick={() => setTable(t.name)}
                    {...stylex.attrs(styles.tab, active() && styles.tabOn)}
                    data-data-table={t.name}
                  >
                    {t.name}
                    <span {...stylex.attrs(styles.count)}>{t.rows}</span>
                  </button>
                );
              }}
            </For>
          </div>
          <div {...stylex.attrs(styles.toolbar)}>
            <input
              value={search()}
              placeholder="Search"
              spellcheck={false}
              onInput={(e) => setSearch(e.currentTarget.value)}
              {...stylex.attrs(styles.search)}
              data-data-search
            />
            <span {...stylex.attrs(styles.meta)}>{range()}</span>
            <Button variant="ghost" disabled={!hasPrev()} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
              Previous
            </Button>
            <Button variant="ghost" disabled={!hasNext()} onClick={() => setOffset((o) => o + PAGE)}>
              Next
            </Button>
          </div>
          <Show when={rows()}>
            <div {...stylex.attrs(styles.gridWrap)}>
              <table {...stylex.attrs(styles.grid)} data-data-rows>
                <thead>
                  <tr>
                    <For each={rows()!.columns}>
                      {(c) => (
                        <th {...stylex.attrs(styles.th)} title={c.type}>
                          {c.name}
                          <Show when={c.primaryKey}>
                            <Icon name="key" size={11} {...stylex.attrs(styles.pk)} />
                          </Show>
                        </th>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows()!.rows}>
                    {(row) => (
                      <tr>
                        <For each={rows()!.columns}>
                          {(c) => (
                            <td {...stylex.attrs(styles.td)} title={show(row[c.name])}>
                              {show(row[c.name])}
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>
      </div>
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
  panelTitle: { fontSize: font.xs, fontWeight: 600 },
  panelBody: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    minHeight: 0,
    overflowY: "auto",
    paddingInline: space.md,
    paddingBottom: space.md,
  },
  meta: {
    flex: 1,
    minWidth: 0,
    color: colors.muted,
    fontSize: font.xs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  note: { margin: 0, color: colors.muted, fontSize: font.xs, lineHeight: 1.5 },
  error: { margin: 0, color: colors.danger, fontSize: font.xs },
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
    cursor: { default: "pointer", ":disabled": "default" },
    opacity: { default: 1, ":disabled": 0.5 },
  },
  tabs: { display: "flex", flexWrap: "wrap", gap: 4 },
  tab: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 26,
    paddingInline: space.sm,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontFamily: font.mono,
    fontSize: font.xs,
    cursor: "pointer",
  },
  tabOn: { borderColor: colors.accent, color: colors.accent },
  count: { color: colors.muted, fontFamily: font.sans, fontSize: 11 },
  toolbar: { display: "flex", alignItems: "center", gap: space.sm },
  search: {
    width: 200,
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
  gridWrap: {
    overflow: "auto",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.sm,
  },
  grid: { borderCollapse: "collapse", width: "100%", fontSize: font.xs, fontFamily: font.mono },
  th: {
    position: "sticky",
    top: 0,
    paddingBlock: 4,
    paddingInline: space.sm,
    textAlign: "left",
    fontWeight: 600,
    whiteSpace: "nowrap",
    color: colors.muted,
    backgroundColor: colors.bg,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
  pk: { marginLeft: 4, color: colors.accent, verticalAlign: "middle" },
  td: {
    maxWidth: 260,
    paddingBlock: 3,
    paddingInline: space.sm,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.text,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
  },
});
