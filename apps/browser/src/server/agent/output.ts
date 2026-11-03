// What tools that return data give back: the result in the agent's context
// (cut off at 20 kB), or, with save_as, the whole of it in a file in the chat's
// folder and only its size in the context. With fields, only the parts of a JSON
// result the agent names (`results[].issue.number`), returned or saved. Every
// data tool takes the same two options (dataTool), so big results never have to
// go through the agent's context.
import { Effect, Schema } from "effect";
import { ChatFiles, type ChatFilesShape } from "./ChatFiles";
import { saveOutput } from "./fileTools";
import { text, tool, type Tool, type ToolResult } from "./Mcp";
import type { ToolEnv } from "./tools";

/** What a data tool returns in the agent's context at most (characters). */
export const MAX_RESULT = 20_000;
/** What it saves to a file at most. */
export const MAX_SAVED = 5_000_000;

export const clip = (body: string, max = MAX_RESULT) =>
  body.length > max ? `${body.slice(0, max)}… (${body.length - max} more characters; save_as saves all of it)` : body;

/** A data tool's result: `head` is always shown (a status line, headers), `body` is the data that's returned or saved. */
export interface Data {
  readonly head?: string;
  readonly body: string | null;
  /** The body as a value, if the tool has it (fields pick from it instead of parsing the body). */
  readonly value?: unknown;
  /** Shown instead of a missing body. */
  readonly empty?: string;
}

export const OutputFields = {
  save_as: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Save the whole result to this path in the chat's folder (e.g. data/orders.json) instead of returning it; you get only its size",
    }),
  ),
  fields: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "Only these parts of a JSON result, e.g. ['results[].issue.number', 'results[].issue.title', 'total']: `.` goes into an object, `[]` into every item of a list, `[0]` into one item",
    }),
  ),
};

export interface OutputOptions {
  readonly save_as?: string;
  readonly fields?: readonly string[];
}

// --- Picking fields -----------------------------------------------------------------------

type Step = { key: string } | { index: number } | { each: true };
/** What to keep: `true` keeps a value whole. */
type Pick = true | Map<string, Pick>;

/** `results[].issue.number` → results, each, issue, number. */
export function parsePath(path: string): Step[] {
  const steps: Step[] = [];
  const re = /\[(\d*)\]|\.?([^.[\]]+)/gy;
  const source = path.trim().replace(/^\$?\.?/, "");
  let match: RegExpExecArray | null;
  let at = 0;
  while (at < source.length && (match = re.exec(source))) {
    at = re.lastIndex;
    if (match[2] !== undefined) steps.push({ key: match[2] });
    else if (match[1]) steps.push({ index: Number(match[1]) });
    else steps.push({ each: true });
  }
  if (at < source.length || !steps.length) throw new Error(`Can't read the field ${JSON.stringify(path)}`);
  return steps;
}

const stepKey = (s: Step) => ("key" in s ? `.${s.key}` : "index" in s ? `[${s.index}]` : "[]");

function compile(paths: readonly string[]): Pick {
  const root = new Map<string, Pick>();
  for (const path of paths) {
    let node = root;
    const steps = parsePath(path);
    steps.forEach((step, i) => {
      const k = stepKey(step);
      if (i === steps.length - 1) node.set(k, true);
      else {
        let next = node.get(k);
        if (next === true) return;
        if (!next) node.set(k, (next = new Map()));
        node = next;
      }
    });
  }
  return root;
}

function apply(value: unknown, pick: Pick): unknown {
  if (pick === true) return value;
  // A list where an object's field is asked for: the field of each item.
  if (Array.isArray(value) && !pick.has("[]") && [...pick.keys()].every((k) => k.startsWith(".")))
    return value.map((item) => apply(item, pick));
  if (Array.isArray(value)) {
    const each = pick.get("[]");
    if (each) return value.map((item) => apply(item, each));
    // Single items ([0], [3]): those, in order.
    return [...pick]
      .filter(([k]) => k.startsWith("[") && Number(k.slice(1, -1)) < value.length)
      .sort(([a], [b]) => Number(a.slice(1, -1)) - Number(b.slice(1, -1)))
      .map(([k, sub]) => apply(value[Number(k.slice(1, -1))], sub));
  }
  if (value === null || typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, sub] of pick) {
    if (!k.startsWith(".")) continue;
    const key = k.slice(1);
    if (Object.hasOwn(value, key)) {
      const picked = apply((value as Record<string, unknown>)[key], sub);
      if (picked !== undefined) out[key] = picked;
    }
  }
  return out;
}

/** Only the named parts of a value, in the same shape (fields that aren't there are left out). */
export const pickFields = (value: unknown, fields: readonly string[]) => apply(value, compile(fields)) ?? null;

// --- The tools ----------------------------------------------------------------------------

/** Turns a data tool's result into what the agent gets, per save_as and fields. */
export const finish = (files: ChatFilesShape, env: ToolEnv, data: Data, options: OutputOptions) =>
  Effect.gen(function* () {
    let body = data.body;
    if (options.fields?.length) {
      let value = data.value;
      if (value === undefined) {
        if (body === null)
          return text(`${data.head ? `${data.head}\n\n` : ""}There's no body to pick fields from.`, true);
        try {
          value = JSON.parse(body);
        } catch {
          return text(
            `${data.head ? `${data.head}\n\n` : ""}fields only work on JSON, and this result isn't JSON (${clip(body, 200)}).`,
            true,
          );
        }
      }
      const picked = yield* Effect.try({
        try: () => pickFields(value, options.fields!),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      body = JSON.stringify(picked, null, 1);
    }
    const head = data.head ? [data.head, ""] : [];
    if (options.save_as) {
      if (body === null) return [...head, data.empty ?? "There's no text to save."].join("\n");
      const saved = body.length > MAX_SAVED ? body.slice(0, MAX_SAVED) : body;
      const file = yield* saveOutput(files, env, options.save_as, saved);
      return [
        ...head,
        `Saved ${options.fields?.length ? "the fields" : "the result"} in ${file.name} (${saved.length} characters${
          saved.length < body.length ? `, cut off at ${MAX_SAVED}` : ""
        }). read_file reads it.`,
      ].join("\n");
    }
    return [...head, body === null ? (data.empty ?? "(no text body)") : clip(body)].join("\n");
  });

/**
 * A tool that returns data: it gets save_as and fields (OutputFields) on top of
 * its own arguments, and its result goes through `finish`. `run` gets only its
 * own arguments; a ToolResult it returns (an error) is passed on as it is.
 */
export const dataTools = Effect.fn(function* (env: ToolEnv) {
  const files = yield* ChatFiles;
  return <F extends Schema.Struct.Fields>(
    name: string,
    description: string,
    input: Schema.Struct<F>,
    run: (args: Schema.Struct<F>["Type"]) => Effect.Effect<Data | ToolResult | string, unknown>,
  ): Tool =>
    tool(
      name,
      description,
      Schema.Struct({ ...input.fields, ...OutputFields }),
      ({ save_as, fields, ...args }: OutputOptions & Record<string, unknown>) =>
        run(args as Schema.Struct<F>["Type"]).pipe(
          Effect.flatMap((result) =>
            typeof result === "object" && "content" in result
              ? Effect.succeed(result)
              : finish(files, env, typeof result === "string" ? { body: result } : result, { save_as, fields }),
          ),
        ),
    );
});
