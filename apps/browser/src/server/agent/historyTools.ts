// Snapshots for agents (history/History.ts): an app builder sees its app's
// versions and a website agent the site customizations', so they can look at
// what they did before and go back to it. They can restore but never delete
// a snapshot; restoring saves the current state first, so it can be undone.
// The website agent's restore only touches the site it's on.
import { Effect, Schema } from "effect";
import { appTarget, type HistoryEntry, type PageChange } from "../../shared/api";
import { topics } from "../../shared/hub";
import { hostOf, scopeMatches } from "../../shared/web";
import { PageChanges } from "../db/PageChanges";
import { Sites } from "../db/Sites";
import { History } from "../history/History";
import { Hub } from "../Hub";
import { text, tool } from "./Mcp";
import type { ToolEnv } from "./tools";

const CHANGES = "@changes/";

const line = (e: HistoryEntry) => {
  const files = [
    e.added.length && `+${e.added.length}`,
    e.modified.length && `~${e.modified.length}`,
    e.removed.length && `-${e.removed.length}`,
  ]
    .filter(Boolean)
    .join(" ");
  return `#${e.id} ${e.at.slice(0, 16).replace("T", " ")} · ${e.actorLabel} · ${e.summary.slice(0, 120)}${files ? ` (${files} files)` : ""}`;
};

export const historyTools = Effect.fn(function* (env: ToolEnv, options: { site: boolean }) {
  const history = yield* History;
  const pageChanges = yield* PageChanges;
  const sites = yield* Sites;
  const hub = yield* Hub;
  const target = options.site ? "sites" : appTarget(env.tabId);
  const what = options.site
    ? "the site customizations (page changes and site overrides)"
    : "this app (its files; its data only when asked)";
  const currentUrl = hub.rpc<{ url: string }>("page.info", { tabId: env.tabId }).pipe(Effect.map((p) => p.url));

  /** A snapshot of this agent's target. */
  const own = (id: number) =>
    Effect.gen(function* () {
      const entry = yield* history.entry(id).pipe(Effect.orElseSucceed(() => null));
      if (!entry || entry.target !== target)
        return yield* Effect.fail(
          new Error(
            `No snapshot #${id} of ${options.site ? "the site customizations" : "this app"} (see list_snapshots).`,
          ),
        );
      return entry;
    });

  /** Whether a page change is about this site. */
  const concerns = (change: PageChange, url: string, host: string) =>
    scopeMatches(change.scope, url) || change.scope.value === host || change.scope.value.startsWith(`${host}/`);

  return [
    tool(
      "list_snapshots",
      `The saved versions of ${what}, newest first: snapshot id, when, who made the change and what it was. Taken before and after every agent turn and when the user changes things.`,
      Schema.Struct({ limit: Schema.optionalKey(Schema.Finite) }),
      ({ limit }) =>
        history
          .list({ target, limit: Math.min(Math.max(Math.floor(limit ?? 20), 1), 100) })
          .pipe(Effect.map((entries) => (entries.length ? entries.map(line).join("\n") : "No snapshots yet."))),
    ),

    tool(
      "view_snapshot",
      "What a snapshot changed compared with the one before it (line diffs), or one file as it was then (path). Page changes are the files @changes/<id>.json; a site's override is <host>/style.css and <host>/script.js.",
      Schema.Struct({ id: Schema.Finite, path: Schema.optionalKey(Schema.String) }),
      ({ id, path }) =>
        Effect.gen(function* () {
          const entry = yield* own(id);
          if (path) {
            const content = yield* history.fileAt(entry.id, path);
            if (content === null)
              return text(
                `${path} isn't in snapshot #${id} (or isn't text). Its files: ${(yield* history.paths(entry.id)).slice(0, 80).join(", ")}`,
                true,
              );
            return content.length > 30_000 ? `${content.slice(0, 30_000)}\n… (more)` : content;
          }
          const detail = yield* history.detail(entry.id);
          const out = [line(entry), ""];
          for (const f of detail.files) {
            out.push(`${f.status} ${f.path}${f.kind === "text" ? "" : ` (${f.kind})`}`);
            for (const h of f.hunks ?? []) {
              out.push(`@@ -${h.oldStart} +${h.newStart} @@`);
              for (const l of h.lines) out.push(`${l.type}${l.text}`);
            }
          }
          const all = out.join("\n");
          return all.length > 30_000 ? `${all.slice(0, 30_000)}\n… (more: view one file with path)` : all;
        }),
    ),

    tool(
      "restore_snapshot",
      options.site
        ? "Bring this site's page changes and override back to how they were in a snapshot (other sites stay as they are). The current state is saved first, so this can be undone too."
        : "Bring the app's files back to how they were in a snapshot (its data stays as it is unless data is true). The current state is saved first, so this can be undone too.",
      Schema.Struct({
        id: Schema.Finite,
        data: Schema.optionalKey(
          Schema.Boolean.annotate({
            description: options.site ? "Ignored for websites" : "Also bring back the app's data",
          }),
        ),
      }),
      (args) =>
        Effect.gen(function* () {
          const entry = yield* own(args.id);
          if (!options.site) {
            yield* history.restore(entry.id, { data: args.data ?? false });
            yield* env.log(`Restored the app to snapshot #${entry.id}`);
            return `Restored the app to snapshot #${entry.id} (“${entry.summary.slice(0, 80)}”).`;
          }
          const url = yield* currentUrl;
          const host = hostOf(url);
          if (!host) return text("The tab isn't on a website.", true);
          const by = { actor: "agent" as const, actorLabel: env.label };
          yield* history.record("sites", { ...by, summary: `Before restoring ${host} to snapshot #${entry.id}` });
          // Its page changes as they were then; the ones added since go.
          const paths = yield* history.paths(entry.id);
          const then: PageChange[] = [];
          for (const path of paths.filter((p) => p.startsWith(CHANGES))) {
            const change = JSON.parse((yield* history.fileAt(entry.id, path)) ?? "null") as PageChange | null;
            if (change && concerns(change, url, host)) then.push(change);
          }
          const now = (yield* pageChanges.list()).filter((c) => concerns(c, url, host));
          for (const change of now) if (!then.some((c) => c.id === change.id)) yield* pageChanges.remove(change.id);
          for (const change of then) yield* pageChanges.put(change);
          // The site's override.
          const css = (yield* history.fileAt(entry.id, `${host}/style.css`)) ?? "";
          const js = (yield* history.fileAt(entry.id, `${host}/script.js`)) ?? "";
          const meta = yield* history.fileAt(entry.id, `${host}/site.json`);
          if (meta === null) yield* sites.remove(host);
          else
            yield* sites.save(host, { css, js, enabled: (JSON.parse(meta) as { enabled?: boolean }).enabled ?? true });
          yield* history.record("sites", { ...by, summary: `Restored ${host} to snapshot #${entry.id}` });
          yield* hub.publish({ type: "page-changes", topic: topics.sites });
          yield* hub.publish({ type: "site", topic: topics.sites, host });
          yield* hub.rpc("page.applyOverride", { tabId: env.tabId }, 45_000).pipe(Effect.ignore);
          yield* env.log(`Restored ${host} to snapshot #${entry.id}`);
          return `Restored ${host} to snapshot #${entry.id}: ${then.length} page change${then.length === 1 ? "" : "s"}${meta === null ? "" : " and its override"} (${now.length} before).`;
        }),
    ),
  ];
});
