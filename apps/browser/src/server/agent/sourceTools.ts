// The code attached to the tab (workspace/Sources.ts), for its agent: list,
// read and search it, look at its Git history, and change it. Every change
// asks the user first with its diff (permission agent.source, which can be
// remembered per folder), so an agent can go from a problem it found in a page
// or a trace to a fix in the code without the user connecting the dots.
import { Effect, Schema } from "effect";
import type { ContextSource } from "../../shared/api";
import { Audit } from "../security/Audit";
import { Permissions } from "../security/Permissions";
import { Sources, unifiedDiff } from "../workspace/Sources";
import { NoArgs, text, tool } from "./Mcp";
import type { ToolEnv } from "./tools";

const SourceArg = Schema.String.annotate({ description: "The source's id or name (see list_sources)" });

export const describeSource = (s: ContextSource) =>
  `${s.id} · ${s.name} · ${s.kind === "git" ? `Git repository ${s.url}${s.branch ? ` (${s.branch})` : ""}, Rune Browser's clone at ${s.path}` : `your folder ${s.path}`}${
    s.state === "ready" ? "" : ` · ${s.state}${s.error ? `: ${s.error}` : ""}`
  }`;

export const sourceTools = Effect.fn(function* (env: ToolEnv) {
  const sources = yield* Sources;
  const permissions = yield* Permissions;
  const audit = yield* Audit;

  /** The source the agent means, by id or name. */
  const find = (key: string | undefined) =>
    Effect.gen(function* () {
      const all = yield* sources.list(env.tabId);
      if (!all.length)
        return yield* Effect.fail(
          new Error(
            "No code is attached to this tab. The user can add a folder or a Git repository in the agent sidebar.",
          ),
        );
      if (!key) {
        if (all.length === 1) return all[0]!;
        return yield* Effect.fail(
          new Error(`Several sources are attached; say which: ${all.map((s) => s.id).join(", ")}`),
        );
      }
      const match = all.find((s) => s.id === key) ?? all.find((s) => s.name.toLowerCase() === key.toLowerCase());
      if (!match)
        return yield* Effect.fail(
          new Error(`No source “${key}”. Attached: ${all.map((s) => `${s.id} (${s.name})`).join(", ")}`),
        );
      return match;
    });

  /** Writes a change after the user approved its diff. */
  const change = (source: ContextSource, rel: string, before: string | null, after: string) =>
    Effect.gen(function* () {
      if (before === after) return text("That changes nothing.");
      const allowed = yield* permissions.ask({
        agentTab: env.tabId,
        subject: env.tabId,
        action: "agent.source",
        resource: source.path,
        title: `Let the agent ${before === null ? "create" : "change"} ${rel} in ${source.name}?`,
        detail:
          source.kind === "git"
            ? `In Rune Browser's copy of ${source.url}. Nothing is pushed.`
            : `In your folder ${source.path}. Rune Browser's history doesn't cover it: use your own Git to undo.`,
        diff: unifiedDiff(rel, before, after),
        timeoutMs: 300_000,
      });
      if (!allowed) return text(`The user didn't allow changing ${rel}. Nothing was written.`, true);
      yield* sources.writeText(source, rel, after);
      yield* audit.record({
        actor: "agent",
        actorLabel: env.label,
        tabId: env.tabId,
        action: "source.edit",
        target: `${source.name}/${rel}`,
        detail: `${after.length} characters`,
      });
      yield* env.log(`${before === null ? "Created" : "Changed"} ${rel} in ${source.name}`);
      return `${before === null ? "Created" : "Changed"} ${rel}.`;
    });

  return [
    tool(
      "list_sources",
      "The code attached to this tab: folders of the user's and Git repositories, with their ids. Read and search them with the other source tools.",
      NoArgs,
      () =>
        sources
          .list(env.tabId)
          .pipe(
            Effect.map((all) => (all.length ? all.map(describeSource).join("\n") : "No code is attached to this tab.")),
          ),
    ),

    tool(
      "list_source_files",
      "Files in an attached source (dependencies, builds and credential files left out). A folder lists what's under it; a glob pattern (e.g. **/*.tsx, *.css) finds files anywhere.",
      Schema.Struct({
        source: Schema.optionalKey(SourceArg),
        dir: Schema.optionalKey(Schema.String.annotate({ description: "A folder in it (default: all of it)" })),
        pattern: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Schema.Finite),
      }),
      ({ source, dir, pattern, limit }) =>
        Effect.gen(function* () {
          const s = yield* find(source);
          const files = yield* sources.listFiles(s, { dir, pattern, limit: limit ?? 300 });
          return files.length ? files.join("\n") : "No files there.";
        }),
    ),

    tool(
      "read_source_file",
      "A file of an attached source, with line numbers. Long files come in parts: offset and limit are lines.",
      Schema.Struct({
        source: Schema.optionalKey(SourceArg),
        path: Schema.String,
        offset: Schema.optionalKey(Schema.Finite.annotate({ description: "First line (1-based, default 1)" })),
        limit: Schema.optionalKey(Schema.Finite.annotate({ description: "Number of lines (default 500)" })),
      }),
      ({ source, path, offset, limit }) =>
        Effect.gen(function* () {
          const s = yield* find(source);
          const { rel, text: content } = yield* sources.readText(s, path);
          if (content === null) return text(`${rel} is a binary file.`, true);
          const lines = content.split("\n");
          const from = Math.max(1, Math.floor(offset ?? 1));
          const count = Math.min(Math.max(Math.floor(limit ?? 500), 1), 2000);
          const shown = lines
            .slice(from - 1, from - 1 + count)
            .map(
              (line, i) => `${String(from + i).padStart(5)}  ${line.length > 2000 ? `${line.slice(0, 2000)}…` : line}`,
            );
          const rest = lines.length - (from - 1 + shown.length);
          return `${rel} (${lines.length} lines)\n${shown.join("\n")}${rest > 0 ? `\n… ${rest} more lines (offset ${from + shown.length})` : ""}`;
        }),
    ),

    tool(
      "search_source",
      "Search the code attached to this tab (all of it, or one source) for text or a regular expression: file:line: the line. Use it to find where something comes from, e.g. a function from a trace, a CSS class or an error message.",
      Schema.Struct({
        query: Schema.String,
        source: Schema.optionalKey(SourceArg),
        regex: Schema.optionalKey(Schema.Boolean),
        glob: Schema.optionalKey(
          Schema.String.annotate({ description: "Only files matching this, e.g. *.ts or src/**/*.css" }),
        ),
        limit: Schema.optionalKey(Schema.Finite),
      }),
      ({ query, source, regex, glob, limit }) =>
        Effect.gen(function* () {
          const targets = source
            ? [yield* find(source)]
            : (yield* sources.list(env.tabId)).filter((s) => s.state === "ready" || s.state === "pulling");
          if (!targets.length) return text("No code is attached to this tab (or it's still being cloned).", true);
          const max = Math.min(Math.max(Math.floor(limit ?? 100), 1), 500);
          const results: string[] = [];
          for (const s of targets) {
            const found = yield* sources.search(s, { query, regex, glob, limit: max - results.length });
            results.push(...found.map((line) => (targets.length > 1 ? `[${s.id}] ${line}` : line)));
            if (results.length >= max) break;
          }
          return results.length
            ? `${results.join("\n")}${results.length >= max ? "\n… (more; narrow it down)" : ""}`
            : `Nothing matches ${query}.`;
        }),
    ),

    tool(
      "source_git",
      "Git information about an attached source (read-only): status, log (recent commits), diff (uncommitted changes, or of a commit with ref), show (a commit), blame (who changed each line of a file).",
      Schema.Struct({
        source: Schema.optionalKey(SourceArg),
        command: Schema.Literals(["status", "log", "diff", "show", "blame"]),
        path: Schema.optionalKey(Schema.String),
        ref: Schema.optionalKey(Schema.String.annotate({ description: "A commit or branch" })),
      }),
      ({ source, command, path, ref }) =>
        Effect.gen(function* () {
          const s = yield* find(source);
          if (ref !== undefined && !/^[\w./~^@{}-]{1,100}$/.test(ref))
            return text("That isn't a commit or branch name.", true);
          const file = path ? [(yield* sources.resolvePath(s, path)).rel] : [];
          const args =
            command === "status"
              ? ["status", "--short", "--branch"]
              : command === "log"
                ? [
                    "log",
                    "--max-count=30",
                    "--format=%h %ad %an: %s",
                    "--date=short",
                    ...(ref ? [ref] : []),
                    "--",
                    ...file,
                  ]
                : command === "diff"
                  ? ["diff", "--stat", "--patch", ...(ref ? [ref] : []), "--", ...file]
                  : command === "show"
                    ? ["show", "--stat", "--patch", ref ?? "HEAD", "--", ...file]
                    : file.length
                      ? ["blame", "--date=short", ...(ref ? [ref] : []), "--", ...file]
                      : null;
          if (!args) return text("blame needs a path.", true);
          const out = yield* sources.git(s, args);
          return out.trim() || "(nothing)";
        }),
    ),

    tool(
      "edit_source_file",
      "Change a file of an attached source by replacing text: old_string must appear exactly once (or use replace_all). The user sees the diff and approves it first.",
      Schema.Struct({
        source: Schema.optionalKey(SourceArg),
        path: Schema.String,
        old_string: Schema.String,
        new_string: Schema.String,
        replace_all: Schema.optionalKey(Schema.Boolean),
      }),
      ({ source, path, old_string, new_string, replace_all }) =>
        Effect.gen(function* () {
          const s = yield* find(source);
          const { rel, text: before } = yield* sources.readText(s, path);
          if (before === null) return text(`${rel} is a binary file.`, true);
          const count = old_string ? before.split(old_string).length - 1 : 0;
          if (!count) return text(`old_string isn't in ${rel}. Read the file again and copy the text exactly.`, true);
          if (count > 1 && !replace_all)
            return text(`old_string appears ${count} times in ${rel}: give more context, or replace_all.`, true);
          const after = replace_all
            ? before.split(old_string).join(new_string)
            : before.replace(old_string, () => new_string);
          return yield* change(s, rel, before, after);
        }),
    ),

    tool(
      "write_source_file",
      "Create a file in an attached source, or replace one completely. The user sees the diff and approves it first. Prefer edit_source_file for changes to existing files.",
      Schema.Struct({ source: Schema.optionalKey(SourceArg), path: Schema.String, content: Schema.String }),
      ({ source, path, content }) =>
        Effect.gen(function* () {
          const s = yield* find(source);
          const before = yield* sources.readText(s, path).pipe(
            Effect.map((r) => r.text),
            Effect.catch(() => Effect.succeed(null)),
          );
          const { rel } = yield* sources.resolvePath(s, path);
          return yield* change(s, rel, before, content);
        }),
    ),

    tool(
      "pull_source",
      "Get the latest commits of an attached Git repository (git pull). It runs in the background; list_sources shows when it's done.",
      Schema.Struct({ source: Schema.optionalKey(SourceArg) }),
      ({ source }) =>
        Effect.gen(function* () {
          const s = yield* find(source);
          const pulled = yield* sources.pull(s.id);
          return `${pulled.name}: ${pulled.state === "ready" ? "up to date" : pulled.state}…`;
        }),
    ),
  ];
});
