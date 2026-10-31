// The website agent using pages for the user: clicking, typing, filling in
// forms and pressing keys, with real input events, in the tab the user is
// looking at (its webview, with their logins there). Every action names its
// element first (page.target), so Rune Browser can check it before anything
// happens:
// - acting on a site with the user's session needs their OK once per site
//   (agent.browse, rememberable);
// - something with consequences (buying, paying, sending, posting, deleting,
//   entering card details) is confirmed every time (agent.confirm, never
//   remembered), and the agent can ask for that itself (confirm_action);
// - passwords are never typed: the user signs in themselves.
// The renderer shows what the agent does and lets the user take over.
import { Effect, Schema } from "effect";
import { hostOf } from "../../shared/web";
import { Hub } from "../Hub";
import { Permissions, WEBSITE_AGENT } from "../security/Permissions";
import { ChatFiles } from "./ChatFiles";
import { text, tool } from "./Mcp";
import type { ToolEnv } from "./tools";

/** An element an action is about, as the page describes it (page.target). */
export interface Target {
  /** Where to click, in the page's viewport (CSS pixels). */
  x: number;
  y: number;
  tag: string;
  /** input type, or the element's role. */
  type: string;
  /** What it says: text, value, aria-label, title or alt. */
  label: string;
  name: string;
  autocomplete: string;
  href: string;
  /** It's in a form (or submits one): that form's action and whether it asks for card details. */
  form: { action: string; label: string; payment: boolean } | null;
  url: string;
}

const CONSEQUENTIAL =
  /\b(buy|purchase|pay|payment|checkout|check out|place (an |your )?order|order now|complete order|confirm (order|purchase|payment)|subscribe|donate|send|post|publish|tweet|reply|comment|share|transfer|withdraw|delete|remove|erase|unsubscribe|cancel (my |your )?(subscription|account|order|membership)|book now|reserve|apply now|submit (payment|order|application))\b/i;
const PAYMENT_FIELD = /^cc-|card|cvc|cvv|iban|expir/i;

const isPassword = (t: Target) => t.type === "password" || /current-password|new-password/.test(t.autocomplete);
const isPaymentField = (t: Target) => PAYMENT_FIELD.test(t.autocomplete) || PAYMENT_FIELD.test(t.name);
const describeTarget = (t: Target) =>
  `${t.label ? `“${t.label.slice(0, 80)}”` : t.name ? `the ${t.name} field` : "an element"} (${t.type || t.tag})`;

/**
 * Why acting on `target` needs the user's confirmation each time, or null.
 * Clicking (or pressing Enter in) something that buys, pays, sends, posts or
 * deletes; submitting a form with card details; typing card details.
 */
export function needsConfirmation(target: Target, action: "click" | "type" | "submit"): string | null {
  if (action === "type") return isPaymentField(target) ? `enter payment details into ${describeTarget(target)}` : null;
  const words = [
    target.label,
    target.name,
    target.href,
    action === "submit" ? (target.form?.label ?? "") : "",
    action === "submit" ? (target.form?.action ?? "") : "",
  ].join(" ");
  if (CONSEQUENTIAL.test(words))
    return action === "submit"
      ? `submit the form “${target.form?.label || target.label || "on the page"}”`
      : `click ${describeTarget(target)}`;
  if (target.form?.payment && (action === "submit" || /submit|button/.test(target.type)))
    return `submit a form with payment details (${describeTarget(target)})`;
  return null;
}

const Locator = {
  selector: Schema.optionalKey(Schema.String.annotate({ description: "CSS selector of the element" })),
  text: Schema.optionalKey(
    Schema.String.annotate({ description: "Or: visible text of a button, link or label to find it by" }),
  ),
  index: Schema.optionalKey(Schema.Finite.annotate({ description: "Which match, when several (0 = first)" })),
};

export const browseTools = Effect.fn(function* (env: ToolEnv) {
  const hub = yield* Hub;
  const chatFiles = yield* ChatFiles;
  const permissions = yield* Permissions;
  const call = <T>(method: string, params: object = {}, timeoutMs?: number) =>
    hub.rpc<T>(method, { tabId: env.tabId, ...params }, timeoutMs);

  const find = (locator: { selector?: string; text?: string; index?: number; x?: number; y?: number }) =>
    call<Target | { error: string }>("page.target", locator);

  /** The user's OK to act on this site with their session (once per site, or remembered). */
  const allowSite = (url: string) =>
    Effect.gen(function* () {
      const host = hostOf(url);
      if (!host) return "No website is open in this tab.";
      const ok = yield* permissions.ask({
        agentTab: env.tabId,
        subject: WEBSITE_AGENT,
        action: "agent.browse",
        resource: host,
        title: `Let the website agent use ${host} for you?`,
        detail: `It wants to click, type and fill in forms on ${host} as you, with your login there. You can watch it in the tab and take over at any time. Buying, paying, sending, posting or deleting something still needs your OK each time.`,
        timeoutMs: 120_000,
      });
      return ok ? null : `The user didn't allow using ${host}. Tell them what you would have done.`;
    });

  /** The user's OK for this one action. */
  const confirm = (what: string, url: string) =>
    permissions.ask({
      agentTab: env.tabId,
      subject: WEBSITE_AGENT,
      action: "agent.confirm",
      resource: hostOf(url) || url,
      title: `Let the website agent ${what}?`,
      detail: `On ${url.slice(0, 200)}. This can't necessarily be undone, so Rune Browser asks every time.`,
      timeoutMs: 180_000,
      once: true,
    });

  /** Checks a target (site permission, confirmation, passwords) and runs the action. */
  const act = (
    target: Target | { error: string },
    action: "click" | "type" | "submit",
    run: (t: Target) => Effect.Effect<string, unknown>,
  ) =>
    Effect.gen(function* () {
      if ("error" in target) return text(target.error, true);
      if (action === "type" && isPassword(target)) {
        return text(
          "Rune Browser doesn't let agents type passwords. Ask the user to sign in themselves, then go on.",
          true,
        );
      }
      const refused = yield* allowSite(target.url);
      if (refused) return text(refused, true);
      const why = needsConfirmation(target, action);
      if (why && !(yield* confirm(why, target.url)))
        return text(`The user didn't confirm: ${why}. Don't try another way; ask them what to do.`, true);
      return yield* run(target);
    });

  /** What the page is now, after an action (it may have navigated). */
  const after = (done: string) =>
    call<{ url: string; title: string }>("page.settle", {}, 20_000).pipe(
      Effect.map((page) => `${done}. Now at ${page.url} — ${page.title}`),
      Effect.orElseSucceed(() => done),
    );

  return [
    tool(
      "click",
      "Click an element of the page like the user would (a real mouse click): by CSS selector, by its visible text, or at x/y from a screenshot. Buying, paying, sending, posting or deleting asks the user first.",
      Schema.Struct({ ...Locator, x: Schema.optionalKey(Schema.Finite), y: Schema.optionalKey(Schema.Finite) }),
      (args) =>
        Effect.gen(function* () {
          const target = yield* find(args);
          return yield* act(target, "click", (t) =>
            call("page.act", { kind: "click", x: t.x, y: t.y }).pipe(
              Effect.andThen(env.log(`Clicked ${describeTarget(t)}`)),
              Effect.andThen(after(`Clicked ${describeTarget(t)}`)),
            ),
          );
        }),
    ),

    tool(
      "type_text",
      "Type into a field of the page (focuses it, types like a keyboard). clear replaces what's in it; submit presses Enter afterwards. Never for passwords: the user signs in themselves.",
      Schema.Struct({
        ...Locator,
        value: Schema.String,
        clear: Schema.optionalKey(Schema.Boolean),
        submit: Schema.optionalKey(Schema.Boolean),
      }),
      ({ value, clear, submit, ...locator }) =>
        Effect.gen(function* () {
          const target = yield* find(locator);
          const typed = yield* act(target, "type", (t) =>
            call("page.act", { kind: "type", x: t.x, y: t.y, value, clear: clear ?? false }).pipe(
              Effect.andThen(env.log(`Typed into ${describeTarget(t)}`)),
              Effect.as(`Typed into ${describeTarget(t)}`),
            ),
          );
          if (typeof typed !== "string" || !submit) return typed;
          return yield* act(target, "submit", () =>
            call("page.act", { kind: "key", key: "Enter" }).pipe(Effect.andThen(after(`${typed} and pressed Enter`))),
          );
        }),
    ),

    tool(
      "fill_form",
      'Fill in several fields at once (text fields, selects, checkboxes: value "true"/"false", radio buttons: "true"). Doesn\'t submit: click the form\'s button afterwards.',
      Schema.Struct({
        fields: Schema.Array(Schema.Struct({ selector: Schema.String, value: Schema.String })).annotate({
          description: "Each field's CSS selector and value",
        }),
      }),
      ({ fields }) =>
        Effect.gen(function* () {
          const done: string[] = [];
          for (const field of fields.slice(0, 40)) {
            const target = yield* find({ selector: field.selector });
            const result = yield* act(target, "type", (t) =>
              call("page.act", { kind: "fill", selector: field.selector, x: t.x, y: t.y, value: field.value }).pipe(
                Effect.as(describeTarget(t)),
              ),
            );
            if (typeof result !== "string")
              return done.length
                ? text(
                    `Filled ${done.join(", ")}; then: ${result.content[0]?.type === "text" ? result.content[0].text : "failed"}`,
                    true,
                  )
                : result;
            done.push(result);
          }
          yield* env.log(`Filled in ${done.length} field${done.length === 1 ? "" : "s"}`);
          return `Filled ${done.join(", ")}.`;
        }),
    ),

    tool(
      "press_key",
      "Press a key in the page (Enter, Tab, Escape, Backspace, ArrowDown, PageDown…), in the focused element. Enter in a form submits it, which may ask the user first.",
      Schema.Struct({ key: Schema.String }),
      ({ key }) =>
        Effect.gen(function* () {
          const focused = yield* call<Target | { error: string }>("page.target", { focused: true });
          if ("error" in focused) {
            const refused = yield* allowSite((yield* call<{ url: string }>("page.info")).url);
            if (refused) return text(refused, true);
            return yield* call("page.act", { kind: "key", key }).pipe(Effect.andThen(after(`Pressed ${key}`)));
          }
          // Enter submits or activates the focused element, Space activates it: checked like a click. Other keys only need the site's OK.
          const activates = key === "Enter" || key === " " || key === "Space";
          if (!activates) {
            const refused = yield* allowSite(focused.url);
            if (refused) return text(refused, true);
            return yield* call("page.act", { kind: "key", key }).pipe(Effect.andThen(after(`Pressed ${key}`)));
          }
          return yield* act(focused, key === "Enter" && focused.form ? "submit" : "click", () =>
            call("page.act", { kind: "key", key }).pipe(Effect.andThen(after(`Pressed ${key}`))),
          );
        }),
    ),

    tool(
      "scroll",
      "Scroll the page: down or up by about a screen (or `pixels`), or to an element.",
      Schema.Struct({
        direction: Schema.optionalKey(Schema.Literals(["down", "up"])),
        pixels: Schema.optionalKey(Schema.Finite),
        selector: Schema.optionalKey(Schema.String),
      }),
      ({ direction, pixels, selector }) =>
        call<{ scrollY: number; pageHeight: number }>("page.act", {
          kind: "scroll",
          direction: direction ?? "down",
          pixels: pixels ?? null,
          selector: selector ?? null,
        }).pipe(Effect.map((r) => `Scrolled to ${Math.round(r.scrollY)} of ${Math.round(r.pageHeight)} px.`)),
    ),

    tool(
      "wait_for",
      "Wait until the page shows some text or an element matching a selector (e.g. after a click that loads something), up to timeout_seconds (default 10).",
      Schema.Struct({
        text: Schema.optionalKey(Schema.String),
        selector: Schema.optionalKey(Schema.String),
        timeout_seconds: Schema.optionalKey(Schema.Finite),
      }),
      ({ text: wanted, selector, timeout_seconds }) =>
        Effect.gen(function* () {
          if (!wanted && !selector) return text("Give text or selector.", true);
          const seconds = Math.min(Math.max(timeout_seconds ?? 10, 1), 60);
          const found = yield* call<boolean>(
            "page.waitFor",
            { text: wanted ?? null, selector: selector ?? null, timeoutMs: seconds * 1000 },
            (seconds + 5) * 1000,
          );
          return found ? "It's there." : text(`Not there after ${seconds} s.`, true);
        }),
    ),

    tool(
      "upload_file",
      "Put files from the chat's folder (a screenshot you saved, the user's attachments, a file you wrote) into a file upload field of the page, like the user picking them; the user confirms each upload. Finds <input type=\"file\"> by selector (the first one by default; sites often hide it behind a button). Doesn't submit: click the page's button afterwards.",
      Schema.Struct({
        paths: Schema.Array(Schema.String).annotate({ description: "Paths in the chat's folder" }),
        selector: Schema.optionalKey(
          Schema.String.annotate({ description: 'CSS selector of the file input (default input[type="file"])' }),
        ),
        index: Schema.optionalKey(Schema.Finite.annotate({ description: "Which match, when several (0 = first)" })),
      }),
      ({ paths, selector, index }) =>
        Effect.gen(function* () {
          if (!paths.length) return text("Give at least one path.", true);
          const files: string[] = [];
          for (const path of paths.slice(0, 20)) {
            const file = yield* chatFiles.resolve(env.tabId, path);
            if (!(yield* chatFiles.describe(yield* chatFiles.dir(env.tabId), file)))
              return text(`${path} doesn't exist. list_files shows what's there.`, true);
            files.push(file);
          }
          const { url } = yield* call<{ url: string }>("page.info");
          const refused = yield* allowSite(url);
          if (refused) return text(refused, true);
          // The user's files leave Rune Browser for the site: confirmed every time.
          const names = paths.map((p) => p.split("/").pop()).join(", ");
          if (!(yield* confirm(`upload ${names} to ${hostOf(url) || "this page"}`, url)))
            return text("The user didn't want these files uploaded. Don't try another way; ask them.", true);
          yield* call("devtools", { command: "upload", params: { selector, index, files } }, 30_000);
          yield* env.log(`Uploaded ${names} to ${hostOf(url) || "the page"}`);
          return `Put ${names} into the file field. Submit the form or click its button to send it.`;
        }),
    ),

    tool(
      "confirm_action",
      "Ask the user to confirm something with consequences before you do it (buying, booking, sending a message, deleting, changing an account setting), when Rune Browser might not notice on its own. Returns whether they agreed.",
      Schema.Struct({
        action: Schema.String.annotate({ description: "What you're about to do, e.g. “order 2 tickets for 34 €”" }),
      }),
      ({ action }) =>
        Effect.gen(function* () {
          const { url } = yield* call<{ url: string }>("page.info");
          return (yield* confirm(action.slice(0, 200), url))
            ? "The user agreed. Go ahead."
            : text("The user said no. Don't do it.", true);
        }),
    ),
  ];
});
