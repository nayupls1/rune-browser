// Settings → API map: the APIs the sites in this workspace call, learned from
// its web tabs (shared/endpoints.ts). Hosts with their endpoints, each with
// its parameters, body and responses as shapes. Mapping can be turned off, for
// everything or per site, and a host's map deleted.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { formatParams, formatShape, type Endpoint, type EndpointHost } from "../../shared/endpoints";
import { api } from "../lib/api";
import { settings, updateSettings } from "../lib/settings";
import { currentWorkspace } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Button, Input } from "./ui";

const setWeb = (value: Partial<ReturnType<typeof settings>["web"]>) =>
  updateSettings((s) => ({ ...s, web: { ...s.web, ...value } }));

/** "api.example.com:8080" → "example.com": the site a host belongs to, to turn off. */
const siteOf = (host: string) => {
  const name = host.split(":")[0]!;
  if (/^[\d.]+$/.test(name) || !name.includes(".")) return name;
  return name.split(".").slice(-2).join(".");
};

export function ApiMapPage() {
  const workspaceId = () => currentWorkspace()?.id;
  const [hosts, { refetch }] = createResource(workspaceId, (id) => api.endpointHosts(id));
  const [query, setQuery] = createSignal("");
  const [open, setOpen] = createSignal<string | null>(null);

  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    const list = hosts() ?? [];
    return q ? list.filter((h) => [h.host, ...h.sites].some((v) => v.toLowerCase().includes(q))) : list;
  });

  const turnOff = async (host: EndpointHost) => {
    const site = siteOf(host.host);
    const ok = await confirmDialog(
      `${`Stop mapping ${site}?`} ${`What was mapped for ${site} is deleted, and its APIs aren't mapped anymore. You can turn it back on here.`}`,
      { confirmLabel: "Stop mapping", danger: true },
    );
    if (!ok) return;
    setWeb({ apiMapOff: [...new Set([...settings().web.apiMapOff, site])] });
    await api.deleteEndpointSite(host.workspaceId, site).catch(() => {});
    void refetch();
  };

  const remove = async (host: EndpointHost) => {
    const ok = await confirmDialog(
      `${`Delete the map of ${host.host}?`} ${"Its endpoints are forgotten. They're mapped again when its sites are used."}`,
      { confirmLabel: "Delete", danger: true },
    );
    if (!ok) return;
    await api.deleteEndpointHost(host.workspaceId, host.host);
    if (open() === host.host) setOpen(null);
    void refetch();
  };

  return (
    <div {...stylex.attrs(styles.page)} data-api-map>
      <div {...stylex.attrs(styles.intro)}>
        <label {...stylex.attrs(styles.toggleRow)}>
          <input
            type="checkbox"
            checked={settings().web.apiMap}
            onChange={(e) => setWeb({ apiMap: e.currentTarget.checked })}
            data-api-map-toggle
          />
          <span>
            <strong>Map the APIs that sites use</strong>
            <span {...stylex.attrs(styles.muted)}>
              While you browse, Rune Browser notes every API endpoint a site calls, with its parameters and the shape of
              what it sends and gets back, so agents and apps can build on it. Only the shape is kept: names and kinds
              of values (a number, a date, an email), never the values themselves, your logins or personal data.
              {settings().web.recordNetwork ? "" : " Needs “Record web tabs' traffic” (Settings → Network)."}
            </span>
          </span>
        </label>
        <Show when={settings().web.apiMapOff.length}>
          <div {...stylex.attrs(styles.offList)}>
            <span {...stylex.attrs(styles.muted)}>Not mapped:</span>
            <For each={settings().web.apiMapOff}>
              {(site) => (
                <span {...stylex.attrs(styles.chip)} data-api-map-off={site}>
                  {site}
                  <button
                    type="button"
                    title={`Map ${site} again`}
                    onClick={() => setWeb({ apiMapOff: settings().web.apiMapOff.filter((s) => s !== site) })}
                    {...stylex.attrs(styles.chipButton)}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div {...stylex.attrs(styles.toolbar)}>
        <Input
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search hosts and sites"
          xstyle={styles.search}
        />
        <Button onClick={() => void refetch()} title="Refresh">
          <Icon name="refresh-cw" size={14} />
        </Button>
      </div>

      <Show
        when={shown().length}
        fallback={
          <p {...stylex.attrs(styles.empty)}>
            {hosts.loading
              ? "Loading…"
              : (hosts() ?? []).length
                ? "Nothing matches."
                : "Nothing mapped yet in this workspace. Browse sites in web tabs and their APIs show up here."}
          </p>
        }
      >
        <div {...stylex.attrs(styles.hosts)}>
          <For each={shown()}>
            {(host) => (
              <div {...stylex.attrs(styles.host)} data-api-host={host.host}>
                <div {...stylex.attrs(styles.hostRow)}>
                  <button
                    type="button"
                    onClick={() => setOpen(open() === host.host ? null : host.host)}
                    aria-expanded={open() === host.host}
                    {...stylex.attrs(styles.hostButton)}
                  >
                    <Icon name={open() === host.host ? "chevron-down" : "chevron-right"} size={14} />
                    <span {...stylex.attrs(styles.hostName)}>{host.host}</span>
                    <span {...stylex.attrs(styles.muted)}>
                      {host.endpoints} endpoint{host.endpoints === 1 ? "" : "s"} · {host.requests} requests
                      {host.sites.some((s) => s !== host.host.split(":")[0]) ? ` · from ${host.sites.join(", ")}` : ""}
                    </span>
                  </button>
                  <Button onClick={() => void turnOff(host)} title="Stop mapping this site">
                    <Icon name="eye-off" size={14} />
                  </Button>
                  <Button onClick={() => void remove(host)} title="Delete this host's map" data-api-host-delete>
                    <Icon name="trash" size={14} />
                  </Button>
                </div>
                <Show when={open() === host.host}>
                  <HostEndpoints workspaceId={host.workspaceId} host={host.host} />
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function HostEndpoints(props: { workspaceId: string; host: string }) {
  const [endpoints] = createResource(
    () => [props.workspaceId, props.host] as const,
    ([w, h]) => api.endpoints(w, h),
  );
  const [open, setOpen] = createSignal<string | null>(null);
  return (
    <div {...stylex.attrs(styles.endpoints)}>
      <Show when={!endpoints.loading} fallback={<p {...stylex.attrs(styles.empty)}>Loading…</p>}>
        <For each={endpoints() ?? []}>
          {(e) => (
            <div data-endpoint={`${e.method} ${e.path}${e.operation ? `#${e.operation}` : ""}`}>
              <button
                type="button"
                onClick={() => setOpen(open() === e.id ? null : e.id)}
                aria-expanded={open() === e.id}
                {...stylex.attrs(styles.endpointRow)}
              >
                <span {...stylex.attrs(styles.method)}>{e.method}</span>
                <span {...stylex.attrs(styles.path)}>
                  {e.path}
                  <Show when={e.operation}>
                    <span {...stylex.attrs(styles.operation)}> {e.operation}</span>
                  </Show>
                </span>
                <span {...stylex.attrs(styles.muted)}>
                  {e.responses.map((r) => r.status).join(", ")} · {e.seen}×
                </span>
              </button>
              <Show when={open() === e.id}>
                <EndpointDetail endpoint={e} />
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

function EndpointDetail(props: { endpoint: Endpoint }) {
  const e = () => props.endpoint;
  return (
    <div {...stylex.attrs(styles.detail)} data-endpoint-detail>
      <Show when={Object.keys(e().query).length}>
        <Part label="Query">{formatParams(e().query, e().seen)}</Part>
      </Show>
      <Show when={Object.keys(e().headers).length}>
        <Part label="Headers">{formatParams(e().headers, e().seen)}</Part>
      </Show>
      <Show when={e().requestBody}>
        <Part label={`Body${e().requestType ? ` (${e().requestType})` : ""}`}>{formatShape(e().requestBody)}</Part>
      </Show>
      <For each={e().responses}>
        {(r) => (
          <Part label={`Response ${r.status}${r.type ? ` (${r.type})` : ""} · ${r.seen}×`}>
            {r.shape ? formatShape(r.shape) : "No structured body"}
          </Part>
        )}
      </For>
      <span {...stylex.attrs(styles.muted)}>
        First seen {new Date(e().firstSeen).toLocaleString()} · last {new Date(e().lastSeen).toLocaleString()} · called
        from {e().sites.join(", ")}
      </span>
    </div>
  );
}

function Part(props: { label: string; children: string }) {
  return (
    <div {...stylex.attrs(styles.part)}>
      <span {...stylex.attrs(styles.partLabel)}>{props.label}</span>
      <pre {...stylex.attrs(styles.pre)}>{props.children}</pre>
    </div>
  );
}

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space.lg },
  intro: { display: "flex", flexDirection: "column", gap: space.md },
  toggleRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: font.md,
    cursor: "pointer",
  },
  muted: { display: "block", color: colors.muted, fontSize: font.sm },
  offList: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: space.sm },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    paddingLeft: 8,
    paddingRight: 2,
    height: 24,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceHover,
    fontSize: font.xs,
  },
  chipButton: {
    display: "grid",
    placeItems: "center",
    width: 18,
    height: 18,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.full,
    backgroundColor: "transparent",
    color: colors.muted,
    cursor: "pointer",
  },
  toolbar: { display: "flex", alignItems: "center", gap: space.sm },
  search: { flex: 1, minWidth: 0 },
  empty: { margin: 0, color: colors.muted, fontSize: font.sm },
  hosts: {
    display: "flex",
    flexDirection: "column",
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  host: {
    borderTopWidth: { default: 1, ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: colors.border,
  },
  hostRow: { display: "flex", alignItems: "center", gap: space.sm, paddingBlock: 6, paddingInline: space.md },
  hostButton: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "baseline",
    gap: space.sm,
    padding: space.xs,
    borderStyle: "none",
    backgroundColor: "transparent",
    color: colors.text,
    textAlign: "left",
    cursor: "pointer",
  },
  hostName: { fontSize: font.md, fontWeight: 600, whiteSpace: "nowrap" },
  endpoints: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    paddingBottom: space.md,
    paddingInline: space.lg,
  },
  endpointRow: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    width: "100%",
    paddingBlock: 6,
    paddingInline: space.sm,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    textAlign: "left",
    cursor: "pointer",
  },
  method: {
    flexShrink: 0,
    minWidth: 52,
    paddingInline: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    fontFamily: font.mono,
    fontSize: font.xs,
    fontWeight: 600,
    textAlign: "center",
  },
  path: { flex: 1, minWidth: 0, fontFamily: font.mono, fontSize: font.sm, overflowWrap: "anywhere" },
  operation: { color: colors.accent },
  detail: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    marginBottom: space.sm,
    marginLeft: 60,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
  },
  part: { display: "flex", flexDirection: "column", gap: 2 },
  partLabel: { color: colors.muted, fontSize: font.xs, fontWeight: 600 },
  pre: {
    margin: 0,
    fontFamily: font.mono,
    fontSize: font.xs,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    color: colors.text,
  },
});
