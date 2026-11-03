// Secrets in the UI: the app tab's secrets panel, the form to add or replace
// a secret, and the card the agent's request_secret shows in the chat.
// Values go to the server once and are never shown again.
import * as stylex from "@stylexjs/stylex";
import { createResource, createSignal, For, Show } from "solid-js";
import { isReservedSecretName, SECRET_NAME_PATTERN, workspaceScope, type SecretInfo } from "../../shared/api";
import { api } from "../lib/api";
import { securityVersion } from "../lib/security";
import { appById, workspaceById } from "../lib/store";
import { colors, font, radius, space } from "../theme.stylex";
import { confirmDialog } from "./ConfirmDialog";
import { Icon } from "./Icon";
import { Button } from "./ui";

const nameProblem = (name: string) =>
  !name
    ? null
    : !SECRET_NAME_PATTERN.test(name)
      ? "Capital letters, digits and _ only, e.g. STRIPE_KEY"
      : isReservedSecretName(name)
        ? "Rune Browser sets this one itself"
        : null;

/** Name and value; the value field never shows a saved value. */
export function SecretForm(props: {
  name?: string;
  saveLabel?: string;
  onSave: (name: string, value: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [name, setName] = createSignal(props.name ?? "");
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const problem = () => nameProblem(name());
  const fixedName = () => !!props.name;

  const save = async (e: Event) => {
    e.preventDefault();
    if (!name() || !value() || problem()) return;
    setSaving(true);
    setError();
    try {
      await props.onSave(name(), value());
      setValue("");
      if (!props.name) setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} {...stylex.attrs(styles.form)} data-secret-form>
      <div {...stylex.attrs(styles.formRow)}>
        <Show when={!fixedName()}>
          <input
            value={name()}
            placeholder="NAME"
            spellcheck={false}
            autocomplete="off"
            onInput={(e) => setName(e.currentTarget.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
            {...stylex.attrs(styles.input, styles.nameInput)}
            data-secret-name
          />
        </Show>
        <input
          type="password"
          value={value()}
          placeholder={fixedName() ? `Value for ${props.name}` : "Value"}
          spellcheck={false}
          autocomplete="new-password"
          onInput={(e) => setValue(e.currentTarget.value)}
          {...stylex.attrs(styles.input, styles.valueInput)}
          data-secret-value
        />
        <Button variant="primary" type="submit" disabled={!name() || !value() || !!problem() || saving()}>
          {props.saveLabel ?? "Save"}
        </Button>
        <Show when={props.onCancel}>
          <Button type="button" onClick={() => props.onCancel!()}>
            Cancel
          </Button>
        </Show>
      </div>
      <Show when={problem() ?? error()}>
        <span {...stylex.attrs(styles.error)}>{problem() ?? error()}</span>
      </Show>
    </form>
  );
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";

/** One saved secret: its name and dates, with replace and delete. */
export function SecretRow(props: { secret: SecretInfo; scopeLabel: string }) {
  const [replacing, setReplacing] = createSignal(false);
  return (
    <div {...stylex.attrs(styles.row)} data-secret={props.secret.name}>
      <div {...stylex.attrs(styles.rowHead)}>
        <Icon name="key-round" size={14} {...stylex.attrs(styles.rowIcon)} />
        <code {...stylex.attrs(styles.name)}>{props.secret.name}</code>
        <span {...stylex.attrs(styles.meta)}>
          updated {when(props.secret.updatedAt)} · used {when(props.secret.lastUsedAt)}
        </span>
        <button
          type="button"
          title="Replace the value"
          onClick={() => setReplacing((r) => !r)}
          {...stylex.attrs(styles.iconButton)}
        >
          <Icon name="pencil" size={14} />
        </button>
        <button
          type="button"
          title="Delete"
          onClick={async () => {
            if (
              await confirmDialog(
                `Delete the secret ${props.secret.name} (${props.scopeLabel})? Apps using it restart without it.`,
                { confirmLabel: "Delete", danger: true },
              )
            ) {
              await api.deleteSecret(props.secret.id);
            }
          }}
          {...stylex.attrs(styles.iconButton)}
          data-delete-secret
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
      <Show when={replacing()}>
        <SecretForm
          name={props.secret.name}
          saveLabel="Replace"
          onSave={async (name, value) => {
            await api.saveSecret(props.secret.scope, name, value);
            setReplacing(false);
          }}
          onCancel={() => setReplacing(false)}
        />
      </Show>
    </div>
  );
}

/** The app tab's secrets: its own, its workspace's, and which global ones it may use. */
export function SecretsPanel(props: { appId: string; onClose: () => void }) {
  const workspace = () => workspaceById(appById(props.appId)?.workspaceId ?? null);
  const [own] = createResource(
    () => [props.appId, securityVersion()] as const,
    ([id]) => api.secrets(id),
  );
  const [shared] = createResource(
    () => (workspace() ? ([workspace()!.id, securityVersion()] as const) : undefined),
    ([id]) => api.secrets(workspaceScope(id)),
  );
  const [globals] = createResource(securityVersion, () => api.secrets("global"));
  const [grants] = createResource(securityVersion, () => api.permissions());
  const grantFor = (name: string) =>
    grants()?.find((g) => g.subject === props.appId && g.action === "app.secret" && g.resource === name);
  // The app's own choice wins; else the one for its whole workspace.
  const workspaceGrant = (name: string) =>
    grants()?.find(
      (g) =>
        workspace() &&
        g.subject === workspaceScope(workspace()!.id) &&
        g.action === "app.secret" &&
        g.resource === name,
    );
  const allowed = (name: string) => (grantFor(name) ?? workspaceGrant(name))?.decision === "allow";
  const viaWorkspace = (name: string) => !grantFor(name) && !!workspaceGrant(name);

  const toggle = async (name: string) => {
    const grant = grantFor(name);
    if (allowed(name)) await api.revokePermission(grant!.id);
    else await api.setPermission(props.appId, "app.secret", name, "allow");
  };

  return (
    <div {...stylex.attrs(styles.panel)} data-secrets-panel>
      <div {...stylex.attrs(styles.panelHeader)}>
        <Icon name="key-round" size={14} />
        <span {...stylex.attrs(styles.panelTitle)}>Secrets</span>
        <button type="button" title="Close" onClick={props.onClose} {...stylex.attrs(styles.iconButton)}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div {...stylex.attrs(styles.panelBody)}>
        <p {...stylex.attrs(styles.note)}>
          The app's server gets these as environment variables (<code>process.env.NAME</code>). Values can't be viewed
          after saving, agents never see them, and they're masked in the logs.
          <Show when={own()?.protection === "file"}>
            {" "}
            They're encrypted with a key protected by file permissions (no OS keychain found).
          </Show>
        </p>
        <Show when={own()?.protection === "locked"}>
          <p {...stylex.attrs(styles.error)}>
            Secrets are locked: Rune Browser couldn't unlock its key from the OS keychain.
          </p>
        </Show>
        <For each={own()?.secrets}>{(secret) => <SecretRow secret={secret} scopeLabel="this app" />}</For>
        <SecretForm onSave={(name, value) => api.saveSecret(props.appId, name, value)} saveLabel="Add" />
        <Show when={shared()?.secrets.length}>
          <span {...stylex.attrs(styles.subhead)}>
            Shared by the workspace {workspace()?.name} (managed in Settings)
          </span>
          <For each={shared()!.secrets}>
            {(secret) => (
              <div {...stylex.attrs(styles.globalRow)} data-workspace-secret={secret.name}>
                <Icon name="layers" size={13} {...stylex.attrs(styles.rowIcon)} />
                <code {...stylex.attrs(styles.name)}>{secret.name}</code>
              </div>
            )}
          </For>
        </Show>
        <Show when={globals()?.secrets.length}>
          <span {...stylex.attrs(styles.subhead)}>Global secrets this app may use</span>
          <For each={globals()!.secrets}>
            {(secret) => (
              <label {...stylex.attrs(styles.globalRow)} data-global-secret={secret.name}>
                <input
                  type="checkbox"
                  checked={allowed(secret.name)}
                  disabled={viaWorkspace(secret.name)}
                  onChange={() => void toggle(secret.name)}
                />
                <code {...stylex.attrs(styles.name)}>{secret.name}</code>
                <Show when={viaWorkspace(secret.name)}>
                  <span {...stylex.attrs(styles.meta)}>
                    {allowed(secret.name) ? "allowed" : "denied"} for the whole workspace
                  </span>
                </Show>
              </label>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

/** The agent asked for a secret (request_secret): a form right in the chat. */
export function SecretRequestCard(props: { appId: string; content: string }) {
  const request = () => {
    try {
      return JSON.parse(props.content) as { name: string; description: string };
    } catch {
      return { name: "?", description: "" };
    }
  };
  const [own] = createResource(
    () => [props.appId, securityVersion()] as const,
    ([id]) => api.secrets(id),
  );
  const [globals] = createResource(securityVersion, () => api.secrets("global"));
  const [grants] = createResource(securityVersion, () => api.permissions());
  const has = () =>
    own()?.secrets.some((s) => s.name === request().name) ||
    grants()?.some(
      (g) =>
        g.subject === props.appId &&
        g.action === "app.secret" &&
        g.resource === request().name &&
        g.decision === "allow",
    );
  const globalExists = () => globals()?.secrets.some((s) => s.name === request().name);

  return (
    <div {...stylex.attrs(styles.card)} data-secret-request={request().name}>
      <div {...stylex.attrs(styles.rowHead)}>
        <Icon name="key-round" size={14} {...stylex.attrs(styles.rowIcon)} />
        <span>
          The agent needs <code {...stylex.attrs(styles.name)}>{request().name}</code>
        </span>
      </div>
      <Show when={request().description}>
        <p {...stylex.attrs(styles.note)}>{request().description}</p>
      </Show>
      <Show
        when={!has()}
        fallback={
          <span {...stylex.attrs(styles.done)}>
            <Icon name="check" size={14} /> Added. The app gets it as process.env.{request().name}.
          </span>
        }
      >
        <SecretForm
          name={request().name}
          saveLabel="Add secret"
          onSave={(name, value) => api.saveSecret(props.appId, name, value)}
        />
        <Show when={globalExists()}>
          <Button onClick={() => void api.setPermission(props.appId, "app.secret", request().name, "allow")}>
            Use the global {request().name}
          </Button>
        </Show>
        <span {...stylex.attrs(styles.meta)}>Only the app's server gets it; the agent never sees the value.</span>
      </Show>
    </div>
  );
}

const styles = stylex.create({
  form: { display: "flex", flexDirection: "column", gap: 4 },
  formRow: { display: "flex", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  input: {
    height: 32,
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
  nameInput: { width: 170, fontFamily: font.mono, fontSize: font.xs },
  valueInput: { flex: 1, minWidth: 160 },
  error: { color: colors.danger, fontSize: font.xs },
  row: { display: "flex", flexDirection: "column", gap: space.sm, paddingBlock: 6 },
  rowHead: { display: "flex", alignItems: "center", gap: space.sm, minWidth: 0, fontSize: font.sm },
  rowIcon: { color: colors.accent, flexShrink: 0 },
  name: { fontFamily: font.mono, fontSize: font.xs, fontWeight: 600 },
  meta: {
    flex: 1,
    minWidth: 0,
    color: colors.muted,
    fontSize: font.xs,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
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
  panel: {
    display: "flex",
    flexDirection: "column",
    maxHeight: 320,
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
    gap: space.sm,
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
  globalRow: { display: "flex", alignItems: "center", gap: space.sm, cursor: "pointer" },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  done: { display: "inline-flex", alignItems: "center", gap: 6, color: colors.success, fontSize: font.sm },
});
