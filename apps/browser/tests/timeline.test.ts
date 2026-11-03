import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseToolActivity, type ChatMessage } from "../src/shared/api";
import { buildRows, formatElapsed, summarize } from "../src/renderer/lib/timeline";
import { describeTool } from "../src/server/providers/Provider";
import { describeRuneTool } from "../src/server/agent/activity";

let id = 0;
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const msg = (role: ChatMessage["role"], content: string, s = 0): ChatMessage => ({
  id: ++id,
  role,
  content,
  createdAt: at(s),
});
const tool = (kind: string, title: string, s = 0) => msg("tool", JSON.stringify({ kind, title }), s);

describe("timeline rows", () => {
  const types = (rows: { type: string }[]) => rows.map((r) => r.type);

  test("a finished turn folds its steps into its end, before the final reply", () => {
    const rows = buildRows(
      [
        msg("user", "Build it", 0),
        tool("read", "Read a.ts", 1),
        tool("command", "Ran `bun test`", 2),
        msg("assistant", "Looking further", 3),
        tool("edit", "Edited b.ts", 4),
        msg("assistant", "Done", 5),
        msg("user", "Again", 10),
        msg("assistant", "Sure", 75),
      ],
      false,
      true,
    );
    expect(types(rows)).toEqual(["message", "turn-end", "message", "message", "turn-end", "message"]);
    const end = rows[1]!;
    if (end.type !== "turn-end") throw new Error("no end");
    expect(end.ms).toBe(5000);
    expect(types(end.steps)).toEqual(["work", "message", "work"]);
    expect(end.steps[0]!.type === "work" && end.steps[0]!.entries.length).toBe(2);
    expect(rows[2]!.type === "message" && rows[2]!.message.content).toBe("Done");
    expect(rows[4]).toMatchObject({ type: "turn-end", ms: 65000, steps: [] });
  });

  test("the running turn shows everything as it happens", () => {
    const messages = [msg("user", "Go", 0), tool("read", "Read a.ts", 1), msg("assistant", "Hm", 2)];
    expect(types(buildRows(messages, true, true))).toEqual(["message", "work", "message"]);
  });

  test("a stopped turn says so, and without a reply its errors stay in view", () => {
    const messages = [msg("user", "Go", 0), tool("read", "Read a.ts", 1)];
    const stopped = buildRows([...messages, msg("error", "Stopped.", 5)], false, true);
    expect(stopped.at(-1)).toMatchObject({ type: "turn-end", stopped: true, ms: 5000 });
    expect(stopped.some((r) => r.type === "message" && r.message.role === "error")).toBe(false);
    const failed = buildRows([...messages, msg("error", "Overloaded", 3)], false, true);
    expect(types(failed)).toEqual(["message", "turn-end", "message"]);
    expect(failed.at(-1)).toMatchObject({ type: "message", message: { content: "Overloaded" } });
  });

  test("requests for a secret stay in view", () => {
    const rows = buildRows(
      [msg("user", "Go", 0), msg("secret", "{}", 1), tool("read", "Read a.ts", 2), msg("assistant", "Done", 3)],
      false,
      true,
    );
    expect(rows.map((r) => (r.type === "message" ? r.message.role : r.type))).toEqual([
      "user",
      "turn-end",
      "secret",
      "assistant",
    ]);
  });

  test("files the agent showed stay in view, before its reply", () => {
    const rows = buildRows(
      [
        msg("user", "Go", 0),
        tool("screenshot", "Took a screenshot", 1),
        msg("files", "[]", 2),
        msg("assistant", "Here", 3),
      ],
      false,
      true,
    );
    expect(rows.map((r) => (r.type === "message" ? r.message.role : r.type))).toEqual([
      "user",
      "turn-end",
      "files",
      "assistant",
    ]);
  });

  test("context and attachments open the next turn", () => {
    const rows = buildRows(
      [msg("user", "One", 0), msg("assistant", "A", 2), msg("context", "{}", 3), msg("user", "Two", 3)],
      true,
      true,
    );
    expect(rows.map((r) => (r.type === "message" ? r.message.role : r.type))).toEqual([
      "user",
      "turn-end",
      "assistant",
      "context",
      "user",
    ]);
  });

  test("messages before your first one show as they are", () => {
    const rows = buildRows([tool("app", "Imported from x"), msg("user", "Hi", 1)], true, true);
    expect(types(rows)).toEqual(["work", "message"]);
  });

  test("tool calls can be hidden", () => {
    const rows = buildRows([msg("user", "Go"), tool("read", "Read a.ts"), msg("assistant", "Hi")], true, false);
    expect(types(rows)).toEqual(["message", "message"]);
  });

  test("summaries count kinds, and files once", () => {
    const entries = [
      { kind: "command", title: "Ran `a`" },
      { kind: "edit", title: "Edited a.ts" },
      { kind: "edit", title: "Edited a.ts" },
      { kind: "edit", title: "Edited b.ts" },
      { kind: "command", title: "Ran `b`" },
    ].map((a, i) => ({ id: i, activity: parseToolActivity(JSON.stringify(a)) }));
    expect(summarize(entries)).toBe("Edited 2 files and ran 2 commands");
    const many = ["read", "web", "screenshot", "network"].map((kind, i) => ({
      id: i,
      activity: { kind: kind as never, title: `${i}` },
    }));
    expect(summarize(many)).toBe("Read 1 file, used the web once and 2 more");
  });

  test("elapsed times", () => {
    expect(formatElapsed(4_200)).toBe("4s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_725_000)).toBe("1h 02m");
  });
});

describe("tool activity", () => {
  test("every provider tool shows, with a kind", () => {
    // Paths are shown relative to the project, with the platform's separator.
    expect(describeTool("Edit", { file_path: join("/p", "src", "a.ts") }, "/p")).toEqual({
      kind: "edit",
      title: `Edited ${join("src", "a.ts")}`,
    });
    expect(describeTool("Bash", { command: "bun test" }, "/p")).toEqual({ kind: "command", title: "Ran `bun test`" });
    expect(
      describeTool("TodoWrite", { todos: [{ content: "A", status: "completed" }, { content: "B" }] }, "/p"),
    ).toMatchObject({ kind: "plan", title: "Updated the plan (1/2 done)" });
    expect(describeTool("Task", { description: "Find the bug", prompt: "…" }, "/p")).toMatchObject({
      kind: "agent",
      title: "Started a subagent: Find the bug",
    });
    expect(describeTool("mcp__linear__get_issue", { id: "NAT-1" }, "/p")).toEqual({
      kind: "other",
      title: "Get issue (linear)",
      detail: "id: NAT-1",
    });
    expect(describeTool("SomethingNew", {}, "/p")).toMatchObject({ kind: "other", title: "Something new" });
  });

  test("long commands keep the whole command as detail", () => {
    const command = `echo ${"x".repeat(100)}`;
    const activity = describeTool("Bash", { command }, "/p");
    expect(activity.title.length).toBeLessThan(90);
    expect(activity.detail).toBe(command);
  });

  test("Rune Browser's tools that don't log get a line", () => {
    expect(describeRuneTool("screenshot", {})).toEqual({ kind: "screenshot", title: "Took a screenshot" });
    expect(describeRuneTool("inspect", { selector: ".buy" })).toMatchObject({
      kind: "inspect",
      title: "Inspected .buy",
    });
    expect(describeRuneTool("brand_new_tool", { a: 1 })).toEqual({
      kind: "other",
      title: "Brand new tool",
      detail: "a: 1",
    });
  });

  test("plain tool messages still read", () => {
    expect(parseToolActivity("Edited a.ts")).toEqual({ kind: "other", title: "Edited a.ts" });
  });
});
