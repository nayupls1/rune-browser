// End-to-end check of the built app: launches Electron against a throwaway
// profile and drives the real UI over the DevTools protocol.
//
//   bun run e2e                 UI checks (providers, app previews, dev/live, web tabs, settings)
//   bun run e2e --agent         also has the agents build an app and customize a site (uses your Claude plan)
//   bun run e2e --agent "..."   ...with a custom prompt
//   bun run e2e --visible       show the window while testing (default: offscreen)
//   bun run e2e --only <text>   only the checks whose name contains it ("a|b": either; and the boot check)
//
// Screenshots go to test-results/. Run `bun run build` first.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launchElectron } from "./electron";
import { Page } from "./lib/cdp";
import { writeFixtureBrowser } from "./lib/fixture-browser";
import { fileUrl } from "../src/shared/web";

const args = process.argv.slice(2);
const agentIndex = args.indexOf("--agent");
const agentPrompt =
  agentIndex === -1
    ? undefined
    : (args[agentIndex + 1] ?? "A tiny reading list: book title, author, and whether I've finished it.");

if (!existsSync("dist/electron/main.cjs")) {
  console.error("No build found — run `bun run build` first.");
  process.exit(1);
}

const outDir = "test-results";
mkdirSync(outDir, { recursive: true });
// The long form of the path: Windows' temp folder can be an 8.3 name (C:\Users\RUNNER~1\…), which file
// watchers there (Bun's --hot in app previews) don't match with the changes they're told about.
const tempDir = realpathSync.native(tmpdir());
const profile = mkdtempSync(join(tempDir, "rune-e2e-"));
// A browser to import extensions from (instead of the real ones on this computer).
const browserDir = mkdtempSync(join(tempDir, "rune-e2e-browser-"));
const fixture = writeFixtureBrowser(browserDir);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1];

const port = await new Promise<number>((resolve) => {
  const srv = createServer().listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(port));
  });
});

// Rendered offscreen by default: always painted (reliable screenshots). The
// headless ozone platform doesn't connect to the display server at all, so no
// window can show up on the user's screen (Wayland compositors ignore window
// positions and would open it wherever the user is). --visible shows it.
const visible = args.includes("--visible");
const electron = await launchElectron(
  {
    RUNE_USER_DATA_DIR: profile,
    RUNE_OFFSCREEN: visible ? undefined : "1",
    RUNE_BROWSER_DIRS: fixture.dirs,
    RUNE_EXTENSION_UPDATES: "0",
  },
  [
    ...(visible ? [] : ["--ozone-platform=headless", "--ozone-override-screen-size=1920,1080"]),
    // No OS keychain (it could ask to be unlocked): the secrets key falls back to a file.
    "--password-store=basic",
    `--remote-debugging-port=${port}`,
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ],
);

// A small website for the web tab checks. /feed loads its data from /api/feed
// with credentials of every kind (a cookie, a key in the URL, a bearer token).
const siteSeen: { url: string; authorization: string | null; cookie: string | null }[] = [];
const feedPage = `<title>Feed</title><h1>Feed</h1><p id="status">Loading…</p><script>
  document.cookie = "sid=cookie-secret-1; path=/";
  fetch("/api/feed?page=1&api_key=key-secret-2", { headers: { Authorization: "Bearer bearer-secret-3" } })
    .then((r) => r.json())
    .then((d) => (document.getElementById("status").textContent = "Loaded " + d.items.length + " items"))
    .catch(() => (document.getElementById("status").textContent = "Failed to load"));
</script>`;
const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    // Pages behind a sign-in (HTTP Basic): the fixture extension fills in /auth/extension, you /auth/you.
    if (path.startsWith("/auth/")) {
      const user = path === "/auth/extension" ? "fixture:from-extension" : "you:typed";
      if (req.headers.get("authorization") !== `Basic ${btoa(user)}`) {
        return new Response("<title>Denied</title>", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="E2E"', "Content-Type": "text/html" },
        });
      }
      return new Response(`<title>Signed in as ${user.split(":")[0]}</title>`, {
        headers: { "Content-Type": "text/html" },
      });
    }
    // A page that takes a while (the address bar's loading spinner).
    if (path === "/slow") {
      await Bun.sleep(2500);
      return new Response("<title>Slow</title><h1>Slow</h1>", { headers: { "Content-Type": "text/html" } });
    }
    if (path === "/api/feed") {
      siteSeen.push({
        url: req.url,
        authorization: req.headers.get("authorization"),
        cookie: req.headers.get("cookie"),
      });
      return Response.json({
        items: [
          { id: 1, title: "First post" },
          { id: 2, title: "Second post" },
        ],
        page: Number(url.searchParams.get("page")),
        sessionToken: "resp-secret-4",
      });
    }
    const body =
      path === "/feed"
        ? feedPage
        : path === "/act"
          ? `<title>Act page</title><h1>Act</h1><form action="/act-done"><input id="q" name="q"><button id="go">Search</button></form>
           <select id="size"><option>S</option><option>M</option></select><input type="checkbox" id="gift">
           <button id="next" onclick="document.getElementById('out').textContent = 'clicked next ' + event.isTrusted">Next</button><p id="out"></p>`
          : path === "/act-done"
            ? `<title>Searched</title><h1>Results for ${url.searchParams.get("q")}</h1>`
            : path === "/form"
              ? `<title>Form page</title><h1>Form</h1><div style="height:2400px"></div><input id="note" value=""><textarea id="long"></textarea><input id="pw" type="password">`
              : path === "/devtools"
                ? `<title>DevTools page</title><style>.box { color: rgb(1, 2, 3); padding: 4px; } #target.box { margin: 7px; }</style>
           <h1>DevTools</h1><button id="target" class="box" aria-label="Save the draft">Save</button>
           <script>
             document.cookie = "session=devtools-cookie-secret; path=/";
             localStorage.setItem("authToken", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNlY3JldA");
             localStorage.setItem("theme", "dark");
             console.log("hello from devtools", { answer: 42 });
             console.warn("careful with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXNlY3JldA");
             function slowWork() { const end = performance.now() + 150; while (performance.now() < end) {} }
             document.getElementById("target").addEventListener("click", slowWork);
             setTimeout(() => { throw new Error("boom from the page"); }, 0);
           </script>`
                : path === "/keys"
                  ? `<title>Keys page</title><h1>Keys</h1><input id="box"><p>needle one</p><p>needle two</p><p>needle three</p>
           <script>
             window.got = [];
             addEventListener("keydown", (e) => {
               if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); got.push("k:" + e.keyCode); }
             });
           </script>`
                  : path === "/second"
                    ? `<title>Second page</title><h1>Second</h1>`
                    : path === "/blocked-by-extension"
                      ? `<title>Should be blocked</title>`
                      : `<title>Test site</title><main><h1 id="headline">Hello from the test site</h1><p class="lead">Plain text</p>
           <button class="cta">Buy now</button> <a id="popup" href="/second" target="_blank">open popup</a></main>`;
    return new Response(`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">${body}`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

/** A one-page PDF saying `text`. */
function minimalPdf(text: string) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 24 Tf 40 100 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 24 Tf 40 100 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/** Shortcuts' "Mod": Cmd on macOS, Ctrl elsewhere (a KeyboardEvent's property, and sendInputEvent's modifier). */
const mod = process.platform === "darwin" ? "metaKey" : "ctrlKey";
const modKey = process.platform === "darwin" ? "meta" : "control";

const results: { name: string; ok: boolean; detail?: string }[] = [];
let webTabId: string | undefined;
const pageErrors: string[] = [];
let page: Page | undefined;
const skippedShots: string[] = [];

/**
 * Screenshots are for looking at, not assertions. A window the compositor
 * doesn't paint (e.g. on another workspace) never delivers a frame, so give up
 * after a few seconds instead of failing the check.
 */
async function shot(name: string) {
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 8000));
  const result = await Promise.race([page!.screenshot(join(outDir, name)).catch(() => "timeout" as const), timeout]);
  if (result === "timeout") skippedShots.push(name);
}

async function check(name: string, fn: () => Promise<string | void>) {
  if (only && !only.split("|").some((o) => name.includes(o)) && !name.startsWith("app boots")) return;
  const started = Date.now();
  try {
    // Toasts left by earlier checks would cover this one's screenshots.
    if (page)
      await page
        .eval(
          `[...document.querySelectorAll('[data-toast] button[aria-label="Dismiss"]')].forEach((b) => b.click()), true`,
        )
        .catch(() => {});
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || undefined });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""} (${Date.now() - started}ms)`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.log(`  ✗ ${name} — ${detail}`);
    if (page) await shot(`failure-${results.length}.png`);
  }
}

/** Polls an async function until it returns something other than undefined. */
async function waitForValue<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(100);
  }
}

/** Opens the sidebar's "New tab" menu and picks an entry. */
async function newTab(label: "New app" | "New web tab") {
  await click("[data-new-tab]");
  await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "new tab menu" });
  await click("[data-context-menu] button", label);
}

/** Authenticated request to the Rune Browser server, made from the renderer. */
const apiCall = <T>(path: string, init: { method?: string; body?: unknown } = {}) =>
  page!.eval<T>(`fetch(window.rune.serverUrl + ${JSON.stringify(path)}, {
    method: ${JSON.stringify(init.method ?? "GET")},
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + window.rune.token },
    ${init.body !== undefined ? `body: ${JSON.stringify(JSON.stringify(init.body))},` : ""}
  }).then(async (r) => { if (!r.ok) throw new Error(r.status + " " + (await r.text())); return r.status === 204 ? null : r.json(); })`);

/** Waits for an app to be running; if it doesn't get there, the error has its status and last log lines. */
async function waitForAppRunning(root: string, appId: string, label: string, timeoutMs = 60_000) {
  try {
    await page!.waitFor(`!!document.querySelector('${root}[data-runtime-state="running"]')`, { timeoutMs, label });
  } catch (err) {
    const runtime = await apiCall<{
      status: { state: string; mode: string };
      logs: { stream: string; text: string }[];
    }>(`/api/apps/${appId}/runtime`).catch(() => null);
    if (!runtime) throw err;
    const logs = runtime.logs
      .slice(-30)
      .map((l) => `    [${l.stream}] ${l.text.trimEnd()}`)
      .join("\n");
    throw new Error(`${(err as Error).message} (${runtime.status.mode}, ${runtime.status.state}); logs:\n${logs}`);
  }
}

/** Picks provider, model and effort in the agent picker inside `root`. */
async function chooseAgent(root: string, provider: string, model: string, effort?: string) {
  await click(`${root} [data-agent-picker]`);
  await page!.waitFor(`!!document.querySelector("[data-agent-popover]")`, { label: "agent picker" });
  await click(`[data-agent-popover] [data-provider="${provider}"]`);
  await page!.waitFor(`!!document.querySelector('[data-agent-popover] [data-model="${model}"]')`, {
    timeoutMs: 30_000,
    label: `${model} in the list`,
  });
  await click(`[data-agent-popover] [data-model="${model}"]`);
  await page!.waitFor(`!document.querySelector("[data-agent-popover]")`);
  if (effort) {
    await click(`${root} [data-effort-picker]`);
    await page!.waitFor(`!!document.querySelector("[data-context-menu]")`);
    await click("[data-context-menu] button", effort);
  }
}

/** Types a prompt into the composer inside `root` and sends it. */
const sendPrompt = (root: string, prompt: string) =>
  page!.eval(`(() => {
    const t = document.querySelector(${JSON.stringify(`${root} textarea`)});
    t.value = ${JSON.stringify(prompt)};
    t.dispatchEvent(new InputEvent("input", { bubbles: true }));
    t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  })()`);

/** The agent sidebar while it shows a tab's agent. */
const agentOf = (tabId: string) => `[data-agent-for="${tabId}"]`;

/** Waits until the agent in the agent sidebar `panel` started and finished. */
async function agentDone(panel: string) {
  await page!.waitFor(`!!document.querySelector(${JSON.stringify(panel)})`, {
    label: "chat to open",
    timeoutMs: 15_000,
  });
  await page!.waitFor(
    `[...document.querySelectorAll(${JSON.stringify(`${panel} button`)})].some((b) => b.textContent === "Send") && !document.querySelector(${JSON.stringify(panel)}).innerText.includes("Working…")`,
    { timeoutMs: 300_000, label: "agent to finish" },
  );
  return page!.eval<string>(`document.querySelector(${JSON.stringify(panel)}).innerText`);
}

/** Runs code in the webview inside `root` (an app preview or web tab). */
const inView = <T>(root: string, code: string, gesture = false) =>
  page!.eval<T>(
    `document.querySelector(${JSON.stringify(`${root} webview`)}).executeJavaScript(${JSON.stringify(code)}, ${gesture})`,
  );

const click = (selector: string, text?: string) =>
  page!.eval(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = ${text ? `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))` : "els[0]"};
    if (!el) throw new Error(${JSON.stringify(`not found: ${selector} ${text ?? ""}`)});
    el.click();
    return true;
  })()`);

/** Where the sidebar shows a tab's navigation, address and tools (when it's the tab on screen). */
const chromeFor = (tabSelector: string) => tabSelector.replace(/^\[data-(?:web|app)-tab=/, "[data-tab-chrome=");

/** Opens Settings at a category of its sidebar, or one of the pages in it (History, Schedules, Mods, Activity). */
const openSettingsAt = async (section: string) => {
  await click('[data-page-link="Settings"]');
  await page!.waitFor(`!!document.querySelector('[data-settings-nav="${section}"]')`, { label: "settings sidebar" });
  await click(`[data-settings-nav="${section}"]`);
  await page!.waitFor(`document.querySelector("[data-settings-shell]")?.dataset.settingsShell === "${section}"`, {
    label: `settings: ${section}`,
  });
};
/** The workspace shown (its icon is the selected one at the bottom of the sidebar). */
const currentWorkspaceName = `document.querySelector("[data-workspace-bar]")?.dataset.currentWorkspace`;

/** Sets an input's value the way typing does. */
const type = (selector: string, value: string) =>
  page!.eval(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    return true;
  })()`);
/** Runs a command from the command bar (Ctrl+K): typed, then the first match with this id. */
const runCommand = async (text: string, id: string) => {
  await page!.eval(
    `window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ${mod}: true, bubbles: true })), true`,
  );
  await page!.waitFor(`!!document.querySelector("[data-command-bar] input")`, { label: "command bar" });
  await type("[data-command-bar] input", text);
  await page!.waitFor(
    `document.querySelector("[data-command-bar] [data-index='0']")?.dataset.command === ${JSON.stringify(id)}`,
    { label: `"${text}" → ${id}` },
  );
  await page!.eval(
    `document.querySelector("[data-command-bar] input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })), true`,
  );
};
/** Starts picking an element for the tab's agent: the crosshair is in its composer, so the agent sidebar opens first. */
const startPicking = async (tabId: string) => {
  if (!(await page!.eval<boolean>(`!!document.querySelector('[data-agent-for="${tabId}"]')`)))
    await click(`[data-tab-chrome="${tabId}"] [data-agent-show]`);
  await page!.waitFor(`!!document.querySelector('[data-agent-for="${tabId}"] [data-pick-element]')`, {
    label: "picker button",
  });
  await click(`[data-agent-for="${tabId}"] [data-pick-element]`);
};

try {
  console.log("Launching Rune Browser…");
  page = await Page.connect(port);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  page.acceptDialogs();
  page.on("Runtime.exceptionThrown", (e) =>
    pageErrors.push(e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text),
  );
  page.on("Runtime.consoleAPICalled", (e) => {
    if (e.type === "error")
      pageErrors.push(e.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(" "));
  });
  await page.attachChildren();
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // The window is offscreen and, on CI, never focused: without this, menus that close on blur close at once.
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  await check("app boots and shows the sidebar", async () => {
    await page!.waitFor(`!!document.querySelector('[data-page-link="Settings"]')`, { timeoutMs: 20_000 });
  });

  await check("providers are detected", async () => {
    const providers = await waitForValue(async () => {
      const list = await apiCall<{ id: string; state: string; models: unknown[] }[]>("/api/providers");
      return list.every((p) => p.state !== "checking") ? list : undefined;
    }, 60_000);
    const claude = providers.find((p) => p.id === "claude");
    // CI has no agent logins: there, detecting them (installed or not) is enough.
    if (!process.env.CI && (claude?.state !== "ready" || !claude.models.length))
      throw new Error(`Claude isn't ready: ${JSON.stringify(claude)}`);
    return providers.map((p) => `${p.id} ${p.state} (${p.models.length})`).join(", ");
  });

  let appId = "";
  const appTab = () => `[data-app-tab="${appId}"]`;

  await check("new app screen with the agent picker", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New app");
    await page!.waitFor(`document.body.innerText.includes("What do you want to build?")`);
    appId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "new app in the sidebar" },
    );
    // A new app tab opens with the agent sidebar, ready to describe the app.
    await page!.waitFor(`!!document.querySelector('[data-agent-for="${appId}"] textarea')`, {
      label: "agent sidebar open on a new app",
    });
    await click("[data-agent-picker]");
    await page!.waitFor(`!!document.querySelector("[data-agent-popover]")`, { label: "picker popover" });
    const rail = await page!.eval<number>(`document.querySelectorAll("[data-agent-popover] [data-provider]").length`);
    const countModels = `document.querySelectorAll("[data-agent-popover] [data-model]").length`;
    // Without logins (CI) there are no models to list.
    const models = process.env.CI
      ? await page!.eval<number>(countModels)
      : await page!.waitFor<number>(countModels, { label: "models" });
    await shot("agent-picker.png");
    await page!.eval(
      `document.querySelector("[data-agent-popover] input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`,
    );
    await page!.waitFor(`!document.querySelector("[data-agent-popover]")`, { label: "Escape to close" });
    await shot("new-app.png");
    return `${rail} providers, ${models} Claude models`;
  });

  await check("a template runs in the preview (dev server)", async () => {
    await click('[data-template="vanilla"]');
    await page!.waitFor(`!!document.querySelector('${appTab()}[data-runtime-state="running"]')`, {
      timeoutMs: 120_000,
      label: "app running",
    });
    await page!.waitFor(`!!document.querySelector('${appTab()} webview')`, { label: "preview" });
    const heading = await waitForValue(
      async () =>
        (await inView<string>(appTab(), `document.querySelector("h1")?.textContent || undefined`)) ?? undefined,
      20_000,
    );
    await shot("app-dev.png");
    return `"${heading}"`;
  });

  await check("edits show up live in dev mode", async () => {
    const file = join(profile, "data", "apps", appId, "src", "main.ts");
    const source = await Bun.file(file).text();
    if (!source.includes("A starting point:")) throw new Error("template changed; update this check");
    await Bun.write(file, source.replace("A starting point:", "Edited live:"));
    await waitForValue(
      async () =>
        (await inView<string>(appTab(), `document.body.innerText`)).includes("Edited live:") ? true : undefined,
      20_000,
    );
  });

  await check("element picker in the preview", async () => {
    await startPicking(appId);
    await waitForValue(async () => ((await inView<boolean>(appTab(), `!!window.__runePicker`)) ? true : undefined));
    await inView(appTab(), `document.querySelector("h1").click(), true`);
    await page!.waitFor(`!!document.querySelector('${agentOf(appId)} [data-picked-chip]')`, { label: "picked chip" });
  });

  await check("done: hiding the agent builds the app and serves it with its start command", async () => {
    await click(`${agentOf(appId)} [data-agent-hide]`);
    await page!.waitFor(`!document.querySelector('${agentOf(appId)}')`, { label: "agent hidden" });
    await page!
      .waitFor(`!document.querySelector('${appTab()}[data-runtime-state="running"]')`, {
        label: "restart",
        timeoutMs: 10_000,
      })
      .catch(() => {});
    await page!.waitFor(`!!document.querySelector('${appTab()}[data-runtime-state="running"]')`, {
      timeoutMs: 120_000,
      label: "live app running",
    });
    const status = await apiCall<{ status: { mode: string; state: string } }>(`/api/apps/${appId}/runtime`);
    if (status.status.mode !== "live") throw new Error(`mode is ${status.status.mode}`);
    await waitForValue(
      async () =>
        (await inView<string>(appTab(), `document.body.innerText`)).includes("Edited live:") ? true : undefined,
      20_000,
    );
    await click(`${chromeFor(appTab())} [data-logs]`);
    await page!.waitFor(
      `document.querySelector('${appTab()} [data-logs-panel]')?.innerText.includes("bun run start")`,
      { label: "logs" },
    );
    await shot("app-live.png");
    await click(`${chromeFor(appTab())} [data-logs]`);
    // Showing the agent again goes back to editing: the dev server.
    await click(`${chromeFor(appTab())} [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${agentOf(appId)}')`, { label: "agent shown" });
    await page!.waitFor(`!!document.querySelector('${appTab()}[data-runtime-state="running"][data-mode="dev"]')`, {
      timeoutMs: 120_000,
      label: "dev server running",
    });
    const back = await apiCall<{ status: { mode: string } }>(`/api/apps/${appId}/runtime`);
    if (back.status.mode !== "dev") throw new Error(`mode is ${back.status.mode} after showing the agent`);
  });

  await check("history: a snapshot shows the change, and undoing it reverts the app", async () => {
    await click(`${chromeFor(appTab())} [data-history-button]`);
    const panel = `${appTab()} [data-history-panel]`;
    await page!.waitFor(`!!document.querySelector('${panel} [data-snapshot]')`, { label: "template snapshot" });
    await click(`${panel} [data-save-snapshot]`);
    await page!.waitFor(`document.querySelectorAll('${panel} [data-snapshot]').length >= 2`, { label: "new snapshot" });
    await click(`${panel} [data-snapshot] button`);
    const line = `[...document.querySelectorAll('${panel} [data-history-file="src/main.ts"] div')].some((d) => d.textContent.includes("Edited live:"))`;
    await page!.waitFor(line, { label: "diff of src/main.ts" });
    await shot("history.png");
    await click(`${panel} [data-undo]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    const file = join(profile, "data", "apps", appId, "src", "main.ts");
    await waitForValue(
      async () => ((await Bun.file(file).text()).includes("A starting point:") ? true : undefined),
      15_000,
    );
    await waitForAppRunning(appTab(), appId, "app running again");
    await waitForValue(
      async () =>
        (await inView<string>(appTab(), `document.body.innerText`)).includes("A starting point:") ? true : undefined,
      30_000,
    );
    await page!.waitFor(
      `[...document.querySelectorAll('${panel} [data-snapshot]')].some((e) => e.innerText.includes("Undid:"))`,
      { label: "undo in the timeline" },
    );
    await click(`${chromeFor(appTab())} [data-history-button]`);

    // The History page has everything in the workspace.
    await openSettingsAt("history");
    await page!.waitFor(`document.querySelectorAll("[data-history-page] [data-snapshot]").length >= 3`, {
      label: "history page",
    });
    // An entry opened on the page offers putting everything back to that moment.
    await click("[data-history-page] [data-snapshot] button");
    await page!.waitFor(`!!document.querySelector("[data-history-page] [data-restore-all]")`, {
      label: "restore everything",
    });
    await shot("history-page.png");
    const entries = await page!.eval<number>(`document.querySelectorAll("[data-history-page] [data-snapshot]").length`);
    await click(`nav li[data-app-id="${appId}"]`);
    return `${entries} snapshots on the page`;
  });

  await check("app data: tables and rows in the data panel", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(profile, "data", "appdata", appId, "data.sqlite"));
    db.run("CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY, label TEXT, amount REAL)");
    for (const [label, amount] of [
      ["Lunch", 12.5],
      ["Train", 4.2],
      ["Books", 31],
    ] as const)
      db.run("INSERT INTO expenses (label, amount) VALUES (?, ?)", [label, amount]);
    db.close();
    await click(`${chromeFor(appTab())} [data-data-button]`);
    const panel = `${appTab()} [data-data-panel]`;
    await page!.waitFor(`!!document.querySelector('${panel} [data-data-table="expenses"]')`, {
      label: "expenses table",
    });
    await click(`${panel} [data-data-table="expenses"]`);
    await page!.waitFor(`document.querySelectorAll('${panel} [data-data-rows] tbody tr').length === 3`, {
      label: "rows",
    });
    await type(`${panel} [data-data-search]`, "train");
    await page!.waitFor(`document.querySelectorAll('${panel} [data-data-rows] tbody tr').length === 1`, {
      label: "search",
    });
    await shot("app-data.png");
    await click(`${chromeFor(appTab())} [data-data-button]`);
  });

  await check("tool registry: the app's tools from its data, run from the tools panel", async () => {
    await click(`${chromeFor(appTab())} [data-tools-button]`);
    const panel = `${appTab()} [data-tools-panel]`;
    await page!.waitFor(`!!document.querySelector('${panel} [data-tool="add-expenses"]')`, { label: "derived tools" });
    await click(`${panel} [data-tool="add-expenses"] button`);
    await type(`${panel} [data-tool="add-expenses"] [data-tool-param="label"]`, "Coffee");
    await type(`${panel} [data-tool="add-expenses"] [data-tool-param="amount"]`, "3.5");
    await click(`${panel} [data-tool="add-expenses"] [data-run-tool]`);
    await page!.waitFor(
      `document.querySelector('${panel} [data-tool="add-expenses"] [data-tool-result]')?.textContent.includes("Added a row")`,
      { label: "tool result" },
    );
    await shot("app-tools.png");
    await click(`${chromeFor(appTab())} [data-tools-button]`);
    const tools = await apiCall<{ id: string }[]>(`/api/apps/${appId}/tools`);
    return `${tools.length} tools`;
  });

  await check("schedules: created on the page, run now, paused, deleted; a prompt for an agent", async () => {
    const choose = (selector: string, value: string) =>
      page!.eval(`(() => {
        const select = document.querySelector(${JSON.stringify(selector)});
        select.value = ${JSON.stringify(value)};
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
    await openSettingsAt("schedules");
    await page!.waitFor(`!!document.querySelector("[data-schedules]")`, { label: "schedules page" });
    await click("[data-new-schedule]");
    await page!.waitFor(`!!document.querySelector("[data-schedule-editor]")`, { label: "editor" });
    await type("[data-schedule-name]", "Say hello");
    await choose("[data-schedule-app]", appId);
    await choose("[data-schedule-task]", "command");
    await page!.waitFor(`!!document.querySelector("[data-schedule-command]")`, { label: "command field" });
    await type("[data-schedule-command]", "echo scheduled in $RUNE_MODE");
    await click("[data-save-schedule]");
    const row = "[data-schedules] [data-schedule]";
    await page!.waitFor(`!!document.querySelector('${row}') && !document.querySelector("[data-schedule-editor]")`, {
      label: "schedule listed",
    });
    await click(`${row} [data-run-schedule]`);
    await page!.waitFor(`!!document.querySelector('[data-past-runs] [data-run-status="ok"]')`, {
      label: "run finished",
      timeoutMs: 20_000,
    });
    await click(`[data-past-runs] [data-run-status="ok"] button`);
    await page!.waitFor(`document.querySelector("[data-past-runs]").innerText.includes("scheduled in")`, {
      label: "output",
    });
    await click(`${row} [data-pause-schedule]`);
    await page!.waitFor(`document.querySelector('${row}')?.dataset.paused === "yes"`, { label: "paused" });
    await shot("schedules.png");
    await click(`${row} [data-delete-schedule]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    await page!.waitFor(`!document.querySelector('${row}')`, { label: "deleted" });

    // A prompt for an agent, in a new web tab (not run: that needs a model).
    await click("[data-new-schedule]");
    await page!.waitFor(`!!document.querySelector("[data-schedule-editor]")`, { label: "editor again" });
    await choose("[data-schedule-task]", "prompt");
    await page!.waitFor(
      `!!document.querySelector("[data-schedule-prompt]") && !!document.querySelector("[data-schedule-target]")`,
      { label: "prompt fields" },
    );
    await type("[data-schedule-prompt]", "Summarize what's new on the front page");
    await choose("[data-schedule-target]", "new:web");
    await page!.waitFor(`!!document.querySelector("[data-schedule-url]")`, { label: "url field" });
    await type("[data-schedule-url]", "https://example.com");
    await shot("schedule-prompt.png");
    await click("[data-save-schedule]");
    await page!.waitFor(
      `!document.querySelector("[data-schedule-editor]") && (document.querySelector('${row}')?.innerText ?? "").includes("a new tab (https://example.com)")`,
      { label: "prompt schedule listed" },
    );
    await click(`${row} [data-delete-schedule]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    await page!.waitFor(`!document.querySelector('${row}')`, { label: "prompt schedule deleted" });
    await click(`nav li[data-app-id="${appId}"]`);
  });

  await check("secrets: added in the app tab, never shown again", async () => {
    const value = "e2e-secret-value-4711";
    await waitForAppRunning(appTab(), appId, "app running");
    await click(`${chromeFor(appTab())} [data-secrets]`);
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-secrets-panel] [data-secret-form]')`, {
      label: "secrets panel",
    });
    await type(`${appTab()} [data-secrets-panel] [data-secret-name]`, "e2e_key");
    await type(`${appTab()} [data-secrets-panel] [data-secret-value]`, value);
    await page!.eval(
      `document.querySelector('${appTab()} [data-secrets-panel] [data-secret-form]').requestSubmit(), true`,
    );
    await page!.waitFor(`!!document.querySelector('${appTab()} [data-secret="E2E_KEY"]')`, { label: "saved secret" });
    const html = await page!.eval<string>(
      `document.documentElement.outerHTML + [...document.querySelectorAll("input")].map((i) => i.value).join(" ")`,
    );
    if (html.includes(value)) throw new Error("the secret value is still in the page");
    await shot("secrets.png");
    await click(`${chromeFor(appTab())} [data-secrets]`);
  });

  await check("permissions: an app asking for AI waits for the user", async () => {
    const file = join(profile, "data", "apps", appId, "src", "server.ts");
    const source = await Bun.file(file).text();
    await Bun.write(
      file,
      source
        .replace(
          'import { realtime } from "./realtime";',
          'import { realtime } from "./realtime";\nimport { ai } from "./ai";',
        )
        .replace(
          "  routes: {",
          `  routes: {
    "/api/ask-ai": async () => {
      try {
        return Response.json(await ai.chat("Say hi"));
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 403 });
      }
    },`,
        ),
    );
    await click(`${chromeFor(appTab())} [data-restart]`);
    await page!
      .waitFor(`!document.querySelector('${appTab()}[data-runtime-state="running"]')`, { timeoutMs: 10_000 })
      .catch(() => {});
    await page!.waitFor(`!!document.querySelector('${appTab()}[data-runtime-state="running"]')`, {
      timeoutMs: 60_000,
      label: "app restarted",
    });
    const { status } = await apiCall<{ status: { url: string } }>(`/api/apps/${appId}/runtime`);
    const answer = fetch(`${status.url}/api/ask-ai`).then(async (r) => ({ status: r.status, body: await r.text() }));
    await page!.waitFor(`!!document.querySelector('[data-permission-request="app.ai"]')`, {
      timeoutMs: 20_000,
      label: "permission prompt",
    });
    await shot("permission.png");
    await click("[data-permission-request] [data-deny]");
    const result = await answer;
    if (result.status !== 403 || !result.body.includes("didn't allow"))
      throw new Error(`unexpected answer: ${result.status} ${result.body}`);
    await page!.waitFor(`!document.querySelector("[data-permission-request]")`, { label: "prompt gone" });
  });

  await check("activity: the audit log shows what happened", async () => {
    await openSettingsAt("activity");
    await page!.waitFor(
      `!!document.querySelector('[data-activity] [data-audit-action="secret.create"]') && !!document.querySelector('[data-activity] [data-audit-action="permission.deny"]')`,
      {
        label: "secret and permission entries",
      },
    );
    const count = await page!.eval<number>(`document.querySelectorAll("[data-activity] [data-audit-action]").length`);
    await shot("activity.png");
    await click(`nav li[data-app-id="${appId}"]`);
    return `${count} entries`;
  });

  await check("agent panel collapses and comes back", async () => {
    await click(`${agentOf(appId)} [data-agent-hide]`);
    await page!.waitFor(
      `!document.querySelector('${agentOf(appId)}') && !!document.querySelector('${chromeFor(appTab())} [data-agent-show]')`,
      {
        label: "agent panel hidden",
      },
    );
    await click(`${chromeFor(appTab())} [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${agentOf(appId)}')`, { label: "agent panel shown" });
  });

  if (agentPrompt) {
    await check("agent builds an app", async () => {
      const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
      await newTab("New app");
      const id = await page!.waitFor<string>(
        `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      );
      const root = `[data-app-tab="${id}"]`;
      // Fastest model keeps this cheap; any model exercises the same path.
      await chooseAgent(agentOf(id), "claude", "haiku", "Low");
      await sendPrompt(agentOf(id), agentPrompt);
      const chat = await agentDone(agentOf(id));
      await page!.waitFor(`!!document.querySelector('${root}[data-runtime-state="running"]')`, {
        timeoutMs: 60_000,
        label: `app running:\n${chat.slice(-600)}`,
      });
      const text = await waitForValue(
        async () => (await inView<string>(root, `document.body.innerText`)) || undefined,
        20_000,
      );
      await shot("agent-app.png");
      const name = await page!.eval<string>(
        `document.querySelector('nav li[data-app-id="${id}"]').innerText.split("\\n")[0].trim()`,
      );
      return `built "${name}": ${text.slice(0, 80).replace(/\s+/g, " ")}`;
    });
  }

  await check("import: a folder of your own becomes an app tab, run like any other", async () => {
    const folder = join(mkdtempSync(join(tempDir, "rune-e2e-import-")), "hello-import");
    mkdirSync(folder);
    writeFileSync(
      join(folder, "package.json"),
      JSON.stringify({ name: "hello-import", scripts: { dev: "bun server.ts", start: "bun server.ts" } }),
    );
    writeFileSync(
      join(folder, "server.ts"),
      `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("<h1>Imported and running</h1>", { headers: { "Content-Type": "text/html" } }) });`,
    );
    const tab = await apiCall<{ id: string }>("/api/apps", { method: "POST", body: { kind: "app" } });
    await click(`nav li[data-app-id="${tab.id}"]`);
    await page!.waitFor(`!!document.querySelector('[data-app-tab="${tab.id}"] [data-import-folder]')`, {
      label: "import buttons",
    });
    await apiCall(`/api/apps/${tab.id}/import`, { method: "POST", body: { folder } });
    const root = `[data-app-tab="${tab.id}"]`;
    await page!.waitFor(
      `document.querySelector('nav li[data-app-id="${tab.id}"]')?.innerText.includes("hello-import")`,
      { label: "named after the folder" },
    );
    await page!.waitFor(`!!document.querySelector('${root}[data-runtime-state="running"]')`, {
      timeoutMs: 60_000,
      label: "running",
    });
    await waitForValue(
      async () =>
        (await inView<string>(root, `document.body.innerText`)).includes("Imported and running") ? true : undefined,
      20_000,
    );
    await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
    rmSync(dirname(folder), { recursive: true, force: true });
    return "named, manifest from package.json, running in the preview";
  });

  await check("sidebar context menu: rename, duplicate, delete", async () => {
    const appNames = () =>
      page!.eval<string[]>(`[...document.querySelectorAll("nav li")].map((li) => li.innerText.split("\\n")[0].trim())`);
    const openMenu = (index: number) =>
      page!.eval(`(() => {
        const li = document.querySelectorAll("nav li")[${index}];
        const r = li.getBoundingClientRect();
        li.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
        return true;
      })()`);
    const choose = async (label: string) => {
      await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "menu to open" });
      await click("[data-context-menu] button", label);
      await page!.waitFor(`!document.querySelector("[data-context-menu]")`, { label: "menu to close" });
    };

    const before = await appNames();
    if (!before.length) throw new Error("no apps in the sidebar");

    await openMenu(0);
    await choose("Rename");
    await page!.eval(`(() => {
      const input = document.querySelector("nav li input");
      input.value = "E2E renamed";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    })()`);
    await page!.waitFor(`[...document.querySelectorAll("nav li")].some((li) => li.innerText.includes("E2E renamed"))`, {
      label: "rename",
    });

    await openMenu(0);
    await choose("Duplicate");
    await page!.waitFor(
      `[...document.querySelectorAll("nav li")].some((li) => li.innerText.includes("E2E renamed copy"))`,
      {
        label: "duplicate",
      },
    );

    const copyIndex = (await appNames()).indexOf("E2E renamed copy");
    await openMenu(copyIndex);
    await choose("Delete");
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    await page!.waitFor(
      `![...document.querySelectorAll("nav li")].some((li) => li.innerText.includes("E2E renamed copy"))`,
      {
        label: "delete",
      },
    );

    // Escape closes without doing anything.
    await openMenu(0);
    await page!.waitFor(`!!document.querySelector("[data-context-menu]")`);
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-context-menu]")`, { label: "Escape to close the menu" });

    const after = await appNames();
    if (after.length !== before.length) throw new Error(`expected ${before.length} apps, got ${after.join(", ")}`);
  });

  await check("no title bar: window buttons in the sidebar's top row, which drags the window", async () => {
    const r = await page!.eval<{
      controls: { left: number; top: number; width: number } | null;
      inRow: boolean;
      overlapping: number;
      navRight: number;
    }>(`(() => {
      const el = document.querySelector("[data-window-controls]");
      const c = el?.getBoundingClientRect();
      const nav = document.querySelector("nav").getBoundingClientRect();
      // Another drag region over the buttons would make them unclickable (Windows works out drag areas in document order).
      const overlapping = [...document.querySelectorAll("[data-titlebar]")].filter((b) => !b.contains(el) && (() => {
        const r = b.getBoundingClientRect();
        return c && r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top;
      })()).length;
      return { controls: c ? { left: Math.round(c.left), top: Math.round(c.top), width: Math.round(c.width) } : null, inRow: !!el?.closest("[data-nav-row]"), overlapping, navRight: Math.round(nav.right) };
    })()`);
    // macOS keeps its own traffic lights (top left), so Rune Browser draws none there.
    const mac = process.platform === "darwin";
    if (
      mac
        ? r.controls
        : !r.controls || !r.inRow || r.controls.top > 12 || r.controls.left + r.controls.width > r.navRight
    )
      throw new Error(`controls: ${JSON.stringify(r)}`);
    if (r.overlapping) throw new Error(`${r.overlapping} drag regions cover the window buttons`);
    const drag = await page!.eval<string>(
      `getComputedStyle(document.querySelector("[data-nav-row]")).webkitAppRegion || getComputedStyle(document.querySelector("[data-nav-row]")).getPropertyValue("-webkit-app-region")`,
    );
    if (drag !== "drag") throw new Error(`the sidebar's top row isn't a drag region: ${drag}`);
    return mac ? "macOS's own traffic lights" : `${r.controls!.width}px of buttons in the sidebar's top row`;
  });

  await check("sidebar: collapses to icons, resizes, remembers both", async () => {
    const navWidth = () => page!.eval<number>(`document.querySelector("nav").getBoundingClientRect().width`);
    await click("[data-sidebar-toggle]");
    await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "collapsed"`, { label: "collapsed" });
    const collapsed = await navWidth();
    if (collapsed > 60) throw new Error(`collapsed sidebar is ${collapsed}px wide`);
    await shot("sidebar-collapsed.png");
    // Ctrl+Shift+B brings it back.
    await page!.eval(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "B", ${mod}: true, shiftKey: true, bubbles: true })), true`,
    );
    await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "expanded"`, {
      label: "expanded by the shortcut",
    });
    const before = await navWidth();
    // Drag the edge 100px to the right.
    await page!.eval(`(() => {
      const handle = document.querySelector("[data-sidebar-resizer]");
      const r = handle.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + 200;
      handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x + 100, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x + 100, clientY: y }));
      return true;
    })()`);
    const after = await navWidth();
    if (Math.abs(after - before - 100) > 2) throw new Error(`width ${before} → ${after}`);
    const saved = await page!.eval<{ width: number; collapsed: boolean }>(
      `JSON.parse(localStorage.getItem("rune.sidebar"))`,
    );
    if (saved.width !== Math.round(after) || saved.collapsed) throw new Error(`saved ${JSON.stringify(saved)}`);
    await shot("sidebar-wide.png");
    // Back to the default width.
    await page!.eval(
      `document.querySelector("[data-sidebar-resizer]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`,
    );
    return `${Math.round(collapsed)}px collapsed, ${Math.round(before)} → ${Math.round(after)}px`;
  });

  await check("agent sidebar: resized by its edge, remembered, reset by double-click", async () => {
    const panel = "[data-agent-sidebar]";
    if (!(await page!.eval<boolean>(`!!document.querySelector('${panel}')`))) {
      await click(`[data-tab-chrome="${appId}"] [data-agent-show]`);
      await page!.waitFor(`!!document.querySelector('${panel}')`, { label: "agent sidebar" });
    }
    const width = () =>
      page!.eval<number>(`Math.round(document.querySelector('${panel}').getBoundingClientRect().width)`);
    const before = await width();
    const drag = (dx: number) =>
      page!.eval(`(() => {
        const h = document.querySelector("[data-agent-resizer]");
        const r = h.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + 100;
        h.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }));
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + ${dx}, clientY: y }));
        window.dispatchEvent(new PointerEvent("pointerup", { clientX: x + ${dx}, clientY: y }));
        return true;
      })()`);
    await drag(-120);
    const wider = await width();
    if (wider !== before + 120) throw new Error(`${before} → ${wider}, expected +120`);
    const saved = await page!.eval<string>(`localStorage.getItem("rune.agentSidebar")`);
    if (!saved.includes(String(wider))) throw new Error(`not remembered: ${saved}`);
    // Dragged far to the right: it closes (and comes back at its width).
    await drag(5000);
    await page!.waitFor(`!document.querySelector('${panel}')`, { label: "closed by dragging" });
    await click(`[data-tab-chrome="${appId}"] [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${panel}')`, { label: "shown again" });
    if ((await width()) !== wider) throw new Error(`came back at ${await width()}px`);
    await page!.eval(
      `document.querySelector("[data-agent-resizer]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`,
    );
    const reset = await width();
    if (reset !== 380) throw new Error(`double-click: ${reset}px`);
    return `${before} → ${wider} → reset ${reset}px`;
  });

  await check("chats: new chat button and the earlier chats list in the agent sidebar", async () => {
    const panel = `[data-agent-for="${appId}"]`;
    if (!(await page!.eval<boolean>(`!!document.querySelector('${panel}')`)))
      await click(`[data-tab-chrome="${appId}"] [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${panel} [data-chat-history-button]')`, { label: "chat buttons" });
    const disabled = await page!.eval<boolean>(`document.querySelector('${panel} [data-new-chat]').disabled`);
    if (!disabled) throw new Error("New chat is offered for an empty chat");
    await click(`${panel} [data-chat-history-button]`);
    await page!.waitFor(`document.querySelector("[data-chat-history]")?.innerText.includes("No earlier chats")`, {
      label: "history popover",
    });
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-chat-history]")`, { label: "closed" });
    const chats = await apiCall<unknown[]>(`/api/apps/${appId}/chats`);
    if (chats.length) throw new Error("unexpected chats");
  });

  await check(
    "sidebar: no header; collapse, workspaces and Settings in one row at the bottom, also at the minimum width",
    async () => {
      if (await page!.eval<boolean>(`!!document.querySelector("[data-workspace-switcher]")`))
        throw new Error("the workspace header is still there");
      const layout = () =>
        page!.eval<{ tops: number[]; order: string[]; inside: boolean; centered: boolean; bottom: boolean }>(`(() => {
        const nav = document.querySelector("nav").getBoundingClientRect();
        const footer = document.querySelector("[data-sidebar-footer]");
        const parts = [footer.querySelector("[data-sidebar-toggle]"), footer.querySelector("[data-workspace-bar]"), footer.querySelector('[data-page-link="Settings"]')];
        const rects = parts.map((p) => p.getBoundingClientRect());
        const bar = rects[1];
        const icons = [...footer.querySelectorAll("[data-workspace-bar] button")].map((b) => b.getBoundingClientRect());
        const left = icons[0].left - bar.left, right = bar.right - icons.at(-1).right;
        return {
          tops: [...new Set(parts.filter((p, i) => i !== 1).map((p) => Math.round(p.getBoundingClientRect().bottom)))],
          order: rects.map((r) => Math.round(r.left)).map(String),
          inside: rects.every((r) => r.right <= nav.right + 0.5),
          centered: Math.abs(left - right) <= 2,
          bottom: nav.bottom - footer.getBoundingClientRect().bottom < 20,
        };
      })()`);
      const wide = await layout();
      const ordered = (o: string[]) => Number(o[0]) < Number(o[1]) && Number(o[1]) < Number(o[2]);
      if (wide.tops.length !== 1 || !ordered(wide.order) || !wide.centered || !wide.bottom)
        throw new Error(`footer: ${JSON.stringify(wide)}`);
      await page!.eval(`(() => {
      const h = document.querySelector("[data-sidebar-resizer]");
      const r = h.getBoundingClientRect();
      h.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: r.left, clientY: 300 }));
      // Past the minimum width (180 px), not so far that it collapses.
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: r.left - 80, clientY: 300 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: r.left - 80, clientY: 300 }));
      return true;
    })()`);
      const narrow = await layout();
      const width = await page!.eval<number>(`Math.round(document.querySelector("nav").getBoundingClientRect().width)`);
      if (width !== 180) throw new Error(`expected the minimum width, got ${width}px`);
      await shot("sidebar-footer-narrow.png");
      await page!.eval(
        `document.querySelector("[data-sidebar-resizer]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`,
      );
      if (narrow.tops.length !== 1 || !narrow.inside || !ordered(narrow.order))
        throw new Error(`at the minimum width: ${JSON.stringify(narrow)}`);
      await shot("sidebar.png");
      // The pages that were there are in Settings now.
      await openSettingsAt("history");
      return "collapse · workspaces · Settings; History in Settings";
    },
  );

  await check("sidebar: tabs are reordered by dragging", async () => {
    const ids = () =>
      page!.eval<string[]>(`[...document.querySelectorAll("nav li[data-app-id]")].map((li) => li.dataset.appId)`);
    const first = await apiCall<{ id: string }>("/api/apps", {
      method: "POST",
      body: { kind: "web", url: `${site.url.origin}/second` },
    });
    const extra = await apiCall<{ id: string }>("/api/apps", {
      method: "POST",
      body: { kind: "web", url: `${site.url.origin}/second` },
    });
    await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${extra.id}"]')`, {
      label: "new tab in the sidebar",
    });
    const before = await ids();
    if (before.length < 2 || before.at(-1) !== extra.id) throw new Error(`unexpected order ${before.join(", ")}`);
    // Drag the last tab onto the top half of the first one.
    await page!.eval(`(() => {
      const from = document.querySelector('nav li[data-app-id="${extra.id}"]');
      const to = document.querySelector("nav li[data-app-id]");
      const r = to.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      const at = { bubbles: true, cancelable: true, dataTransfer, clientX: r.left + 20, clientY: r.top + 4 };
      from.dispatchEvent(new DragEvent("dragstart", at));
      to.dispatchEvent(new DragEvent("dragover", at));
      to.dispatchEvent(new DragEvent("drop", at));
      from.dispatchEvent(new DragEvent("dragend", at));
      return true;
    })()`);
    const expected = [extra.id, ...before.slice(0, -1)];
    await page!.waitFor(
      `JSON.stringify([...document.querySelectorAll("nav li[data-app-id]")].map((li) => li.dataset.appId)) === ${JSON.stringify(JSON.stringify(expected))}`,
      {
        label: "new order in the sidebar",
      },
    );
    // Saved: the server lists them in that order.
    const saved = await waitForValue(async () => {
      const list = await apiCall<{ id: string; workspaceId: string }[]>("/api/apps");
      const order = list.filter((t) => expected.includes(t.id)).map((t) => t.id);
      return JSON.stringify(order) === JSON.stringify(expected) ? order : undefined;
    });
    for (const tab of [first, extra]) await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
    await page!.waitFor(`!document.querySelector('nav li[data-app-id="${extra.id}"]')`, { label: "tabs removed" });
    return `${saved.length} tabs, last one moved to the top`;
  });

  await check("tab icons: picked from Lucide, uploaded, reset", async () => {
    const tab = await apiCall<{ id: string }>("/api/apps", {
      method: "POST",
      body: { kind: "web", url: `${site.url.origin}/second` },
    });
    const li = `nav li[data-app-id="${tab.id}"]`;
    await page!.waitFor(`!!document.querySelector('${li}')`, { label: "tab in the sidebar" });
    const iconOf = async () =>
      (await apiCall<{ id: string; icon: string | null }[]>("/api/apps")).find((t) => t.id === tab.id)?.icon;
    const openPicker = async () => {
      await page!.eval(`(() => {
        const li = document.querySelector('${li}');
        const r = li.getBoundingClientRect();
        li.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
        return true;
      })()`);
      await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "menu" });
      await click("[data-context-menu] button", "Change icon");
      await page!.waitFor(`!!document.querySelector("[data-icon-picker]")`, { label: "icon picker" });
    };

    await openPicker();
    await page!.eval(`(() => {
      const input = document.querySelector("[data-icon-picker] input");
      input.value = "rocket";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })()`);
    await page!.waitFor(`!!document.querySelector('[data-icon-picker] [data-icon="rocket"]')`, {
      label: "search result",
    });
    await shot("icon-picker.png");
    await click('[data-icon-picker] [data-icon="rocket"]');
    await page!.waitFor(`!document.querySelector("[data-icon-picker]")`, { label: "picker closes" });
    if ((await waitForValue(async () => ((await iconOf()) === "rocket" ? "rocket" : undefined))) !== "rocket")
      throw new Error("not saved");
    await page!.waitFor(`!!document.querySelector('${li} svg.lucide-rocket, ${li} svg[class*="rocket"]')`, {
      label: "rocket in the sidebar",
    });

    // An uploaded image is scaled to a 64px PNG.
    await openPicker();
    await page!.eval(`(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 200; canvas.height = 100;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#e11d48"; ctx.fillRect(0, 0, 200, 100);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg"));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], "logo.jpg", { type: "image/jpeg" }));
      const input = document.querySelector("[data-icon-file]");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    const image = await waitForValue(async () => {
      const icon = await iconOf();
      return icon?.startsWith("data:image/png;base64,") ? icon : undefined;
    });
    const size = await page!.eval<string>(
      `new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img.naturalWidth + "x" + img.naturalHeight); img.src = ${JSON.stringify(image)}; })`,
    );
    if (size !== "64x64") throw new Error(`uploaded icon is ${size}`);
    await page!.waitFor(`!!document.querySelector('${li} img[data-tab-icon-image]')`, {
      label: "image in the sidebar",
    });
    await shot("tab-icon-image.png");

    await openPicker();
    await click("[data-icon-picker] [data-icon-reset]");
    if ((await waitForValue(async () => ((await iconOf()) === null ? "reset" : undefined))) !== "reset")
      throw new Error("not reset");
    await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
    return `rocket, uploaded image (${size}), reset; ${Math.round(image.length / 1024)} kB`;
  });

  await check("split view: drag a tab beside another, focus, resize, rotate, remove", async () => {
    type Workspace = { id: string; splits: { id: string; direction: string; tabs: string[]; sizes: number[] }[] };
    const make = (path: string) =>
      apiCall<{ id: string; workspaceId: string }>("/api/apps", {
        method: "POST",
        body: { kind: "web", url: `${site.url.origin}${path}` },
      });
    // The sidebar has loaded its workspace (right after booting, it may not have yet).
    await page!.waitFor(`!!${currentWorkspaceName}`, { label: "workspace loaded" });
    const a = await make("/");
    const b = await make("/second");
    const liOf = (id: string) => `nav li[data-app-id="${id}"]`;
    await page!.waitFor(`!!document.querySelector('${liOf(b.id)}')`, { label: "tabs in the sidebar" });
    await click(liOf(a.id));
    await page!.waitFor(`!!document.querySelector('[data-tab-layer="${a.id}"] webview')`, { label: "first tab open" });
    const splitsNow = async () =>
      (await apiCall<Workspace[]>("/api/workspaces")).find((w) => w.id === a.workspaceId)!.splits;

    // Drag the second tab from the sidebar onto the right half of the page.
    await page!.eval(`(() => {
      window.__splitDrag = new DataTransfer();
      document.querySelector('${liOf(b.id)}').dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: window.__splitDrag }));
      return true;
    })()`);
    await page!.waitFor(`!!document.querySelector("[data-split-drop]")`, { label: "drop zones" });
    await page!.eval(`(() => {
      const zone = document.querySelector("[data-split-drop]");
      const r = zone.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: window.__splitDrag, clientX: r.right - 40, clientY: r.top + r.height / 2 };
      zone.dispatchEvent(new DragEvent("dragover", at));
      return true;
    })()`);
    await page!.waitFor(`!!document.querySelector('[data-split-preview="right"]')`, { label: "preview on the right" });
    await shot("split-drop.png");
    await page!.eval(`(() => {
      const zone = document.querySelector("[data-split-drop]");
      const r = zone.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, dataTransfer: window.__splitDrag, clientX: r.right - 40, clientY: r.top + r.height / 2 };
      zone.dispatchEvent(new DragEvent("drop", at));
      document.querySelector('${liOf(b.id)}').dispatchEvent(new DragEvent("dragend", at));
      return true;
    })()`);
    const saved = await waitForValue(async () => {
      const splits = await splitsNow();
      return splits.length === 1 && splits[0]!.tabs.join() === [a.id, b.id].join() ? splits[0] : undefined;
    });
    if (saved.direction !== "row") throw new Error(`direction ${saved.direction}`);

    // Both pages on screen, half each; the dropped tab has the focus; the sidebar groups them.
    const rects = () =>
      page!.eval<{ a: DOMRect; b: DOMRect; area: DOMRect }>(`(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect().toJSON();
        return { a: r('[data-tab-layer="${a.id}"]'), b: r('[data-tab-layer="${b.id}"]'), area: r('[data-split-drop], [data-tab-layer="${a.id}"]') };
      })()`);
    await page!.waitFor(
      `!!document.querySelector('[data-tab-layer="${b.id}"] webview') && getComputedStyle(document.querySelector('[data-tab-layer="${a.id}"]')).visibility === "visible"`,
      { label: "both panes shown" },
    );
    const half = await rects();
    if (Math.abs(half.a.width - half.b.width) > 2 || Math.abs(half.b.left - half.a.right - 8) > 1)
      throw new Error(`panes (an 8px gap between them) ${JSON.stringify(half)}`);
    await page!.waitFor(`document.querySelector('${liOf(b.id)}').getAttribute("aria-current") === "page"`, {
      label: "dropped tab focused",
    });
    await page!.waitFor(`document.querySelectorAll('[data-split-group="${saved.id}"] li[data-app-id]').length === 2`, {
      label: "split group in the sidebar",
    });

    // Clicking into the other page (a real click, inside its webview) focuses its tab.
    const point = { x: Math.round(half.a.left + half.a.width / 2), y: Math.round(half.a.top + half.a.height / 2) };
    await page!.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await page!.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    await page!.waitFor(`document.querySelector('${liOf(a.id)}').getAttribute("aria-current") === "page"`, {
      label: "clicked pane focused",
    });
    await shot("split-view.png");

    // Drag the gutter to 30%.
    await page!.eval(`(() => {
      const gutter = document.querySelector("[data-split-gutter]");
      const area = gutter.parentElement.getBoundingClientRect();
      const g = gutter.getBoundingClientRect();
      const y = g.top + 100;
      gutter.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: g.left + 3, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: area.left + area.width * 0.3, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: area.left + area.width * 0.3, clientY: y }));
      return true;
    })()`);
    const resized = await waitForValue(async () => {
      const sizes = (await splitsNow())[0]?.sizes;
      return sizes && Math.abs(sizes[0]! - 0.3) < 0.02 ? sizes : undefined;
    });

    // Another tab on its own hides the split; coming back shows it again.
    const other = await make("/");
    await page!.waitFor(`!!document.querySelector('${liOf(other.id)}')`, { label: "third tab" });
    await click(liOf(other.id));
    await page!.waitFor(
      `getComputedStyle(document.querySelector('[data-tab-layer="${a.id}"]')).visibility === "hidden"`,
      { label: "split hidden" },
    );
    await click(liOf(a.id));
    await page!.waitFor(
      `getComputedStyle(document.querySelector('[data-tab-layer="${b.id}"]')).visibility === "visible"`,
      { label: "split shown again" },
    );

    // Stacked from the group's menu.
    await click(`[data-split-group="${saved.id}"] [data-split-menu]`);
    await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "split menu" });
    await click("[data-context-menu] button", "Stack them");
    await waitForValue(async () => ((await splitsNow())[0]?.direction === "column" ? true : undefined));
    const stacked = await rects();
    if (Math.abs(stacked.b.top - stacked.a.bottom - 8) > 1 || Math.abs(stacked.a.width - stacked.b.width) > 1)
      throw new Error(`stacked panes ${JSON.stringify(stacked)}`);

    // Removing a tab from a split of two ends it.
    await page!.eval(`(() => {
      const li = document.querySelector('${liOf(b.id)}');
      const r = li.getBoundingClientRect();
      li.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
      return true;
    })()`);
    await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "tab menu" });
    await click("[data-context-menu] button", "Remove from split view");
    await waitForValue(async () => ((await splitsNow()).length === 0 ? true : undefined));
    await page!.waitFor(`!document.querySelector("[data-split-group]")`, { label: "group gone" });
    for (const tab of [a, b, other]) await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
    return `side by side, resized to ${Math.round(resized[0]! * 100)}/${Math.round(resized[1]! * 100)}, stacked, removed`;
  });

  await check("web tab: browse, pick an element, site customization applies", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "web tab in the sidebar" },
    );
    webTabId = tabId;
    const tab = `[data-web-tab="${tabId}"]`;
    // Like a browser's new tab: blank, with the address bar focused and empty.
    await page!.waitFor(
      `document.activeElement === document.querySelector('${chromeFor(tab)} [data-address]') && document.activeElement.value === "" && !document.querySelector('${tab} webview')`,
      { label: "a blank new tab with the address bar focused" },
    );
    // In the page: runs code inside the tab's webview.
    const inPage = <T>(code: string, gesture = false) =>
      page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)}, ${gesture})`);

    await page!.waitFor(`!!document.querySelector('${chromeFor(tab)} [data-address]')`, { label: "address bar" });
    await page!.eval(`(() => {
      const input = document.querySelector('${chromeFor(tab)} [data-address]');
      input.value = "${site.url.origin}/";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.form.requestSubmit();
      return true;
    })()`);
    await page!.waitFor(`document.querySelector('nav li[data-app-id="${tabId}"]')?.innerText.includes("Test site")`, {
      timeoutMs: 20_000,
      label: "page title as the tab name",
    });
    await waitForValue(async () =>
      (await inPage<string>(`document.querySelector("h1")?.textContent`)) ? true : undefined,
    );

    // Pick the button: the picker resolves on a click inside the page.
    await startPicking(tabId);
    await waitForValue(async () => ((await inPage<boolean>(`!!window.__runePicker`)) ? true : undefined));
    await inPage(`document.querySelector(".cta").click(), true`);
    await page!.waitFor(
      `document.querySelector('${agentOf(tabId)} [data-picked-chip]')?.innerText.includes("Buy now")`,
      {
        label: "picked element chip",
      },
    );
    const outlined = await inPage<boolean>(`document.querySelector(".cta").hasAttribute("data-rune-picked")`);
    if (!outlined) throw new Error("picked element isn't marked");

    // A customization (as the agent would save it) applies live: CSS now, JS after a reload.
    await apiCall("/api/sites/127.0.0.1", {
      method: "PUT",
      body: {
        css: "h1 { color: rgb(220, 20, 60) !important }",
        js: "onElement('.lead', (el) => { el.textContent = 'Changed by override'; });",
      },
    });
    await waitForValue(
      async () =>
        (await inPage<string>(
          `getComputedStyle(document.querySelector("h1")).color + "|" + document.querySelector(".lead").textContent`,
        )) === "rgb(220, 20, 60)|Changed by override"
          ? true
          : undefined,
      15_000,
    );
    await page!.waitFor(`!!document.querySelector('${chromeFor(tab)} [data-customized="on"]')`, {
      label: "customized indicator",
    });
    await shot("web-tab.png");

    // Links that open a new window become web tabs.
    await inPage(`document.querySelector("#popup").click(), true`, true);
    await page!.waitFor(`[...document.querySelectorAll("nav li")].some((li) => li.innerText.includes("Second page"))`, {
      timeoutMs: 15_000,
      label: "popup opened as a new tab",
    });

    // Turning the customization off in the tab's list of changes removes it.
    await click(`nav li[data-app-id="${webTabId}"]`);
    await click(`${chromeFor(tab)} [data-customized]`);
    await page!.waitFor(`!!document.querySelector("[data-page-changes] [data-site-override]")`, {
      label: "changes popover",
    });
    await click(`[data-page-changes] [data-site-override] [role="switch"]`);
    await waitForValue(
      async () =>
        (await inPage<string>(`getComputedStyle(document.querySelector("h1")).color`)) !== "rgb(220, 20, 60)"
          ? true
          : undefined,
      15_000,
    );
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    return "picked, customized, popup";
  });

  await check("inset page: rounded and apart from the window; fullscreen fills it edge to edge", async () => {
    const tab = `[data-web-tab="${webTabId}"]`;
    const shape = () =>
      page!.eval<{ radius: string; top: number; right: number; bottom: number; win: number[] }>(`(() => {
        const c = document.querySelector("[data-content]");
        const r = c.getBoundingClientRect();
        return {
          radius: getComputedStyle(c).borderTopLeftRadius,
          top: Math.round(r.top), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom),
          win: [innerWidth, innerHeight],
        };
      })()`);
    const before = await shape();
    if (before.radius === "0px" || before.top < 4 || before.right < 4 || before.bottom < 4)
      throw new Error(`inset: ${JSON.stringify(before)}`);
    await shot("inset-page.png");
    // Loading shows as a spinner in the address bar (no bar across the page).
    await inView(tab, `location.href = "/slow"`);
    await page!.waitFor(`!!document.querySelector('${chromeFor(tab)} [data-address-loading]')`, {
      label: "spinner while loading",
    });
    await shot("address-loading.png");
    await page!.waitFor(`!document.querySelector('${chromeFor(tab)} [data-address-loading]')`, {
      label: "spinner gone once loaded",
      timeoutMs: 15_000,
    });
    await inView(tab, `history.back()`);
    await page!.waitFor(`!document.querySelector('${chromeFor(tab)} [data-address-loading]')`, {
      label: "back",
      timeoutMs: 15_000,
    });
    // A page going fullscreen (a video) takes the whole window, outside the inset and its corners.
    const asked = await inView<string>(
      tab,
      `document.documentElement.requestFullscreen().then(() => "ok", (e) => String(e))`,
      true,
    );
    if (asked !== "ok") throw new Error(`fullscreen: ${asked}`);
    // Chromium draws the fullscreen page over the window (the webview element keeps its box), so it's the page's own viewport that tells.
    const viewport = await waitForValue(async () => {
      const size = await inView<number[]>(tab, `[innerWidth, innerHeight]`);
      return size[0] === before.win[0] && size[1] === before.win[1] ? size : undefined;
    }, 10_000);
    if ((await page!.eval<string | null>(`document.fullscreenElement?.tagName ?? null`)) !== "WEBVIEW")
      throw new Error("the webview isn't fullscreen");
    await shot("fullscreen-page.png");
    await inView(tab, `document.exitFullscreen().then(() => "ok", (e) => String(e))`, true);
    // macOS animates the window out of its native fullscreen first.
    await page!.waitFor(`!document.fullscreenElement`, { label: "out of fullscreen", timeoutMs: 20_000 });
    const after = await shape();
    if (after.top !== before.top || after.right !== before.right)
      throw new Error(`after fullscreen: ${JSON.stringify(after)}`);
    return `inset ${before.top}px, corners ${before.radius}; fullscreen fills ${viewport.join("×")}`;
  });

  await check("keyboard shortcuts: pages keep their own keys, the browser's work everywhere", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "web tab" },
    );
    const tab = `[data-web-tab="${tabId}"]`;
    await page!.eval(`(() => {
      const input = document.querySelector('${chromeFor(tab)} [data-address]');
      input.value = "${site.url.origin}/keys";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.form.requestSubmit();
      return true;
    })()`);
    await page!.waitFor(`document.querySelector('nav li[data-app-id="${tabId}"]')?.innerText.includes("Keys page")`, {
      timeoutMs: 20_000,
      label: "keys page",
    });
    const inPage = <T>(code: string) =>
      page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
    /** A key pressed in the page, as the user would (through the main process's before-input-event). */
    const press = (keyCode: string, modifiers: string[] = []) =>
      page!.eval(`(() => {
        const view = document.querySelector('${tab} webview');
        view.focus();
        for (const type of ["keyDown", "keyUp"]) view.sendInputEvent({ type, keyCode: ${JSON.stringify(keyCode)}, modifiers: ${JSON.stringify(modifiers)} });
        return true;
      })()`);
    await waitForValue(async () => ((await inPage<boolean>(`Array.isArray(window.got)`)) ? true : undefined));

    // The page uses Ctrl+K itself: it gets it (with its keyCode), and the command bar stays closed.
    await press("K", [modKey]);
    await waitForValue(async () => ((await inPage<string[]>(`window.got`)).includes("k:75") ? true : undefined), 5_000);
    await Bun.sleep(300);
    if (await page!.eval<boolean>(`!!document.querySelector("[data-command-bar]")`))
      throw new Error("the command bar opened although the page used Ctrl+K");

    // Ctrl+F isn't the page's: find in page.
    await press("F", [modKey]);
    await page!.waitFor(`document.activeElement === document.querySelector('${tab} [data-find-input]')`, {
      label: "find bar, focused",
    });
    await type(`${tab} [data-find-input]`, "needle");
    await page!.waitFor(`document.querySelector('${tab} [data-find-count]')?.textContent === "1/3"`, {
      label: "3 matches",
    });
    await page!.eval(
      `document.querySelector('${tab} [data-find-input]').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })), true`,
    );
    await page!.waitFor(`document.querySelector('${tab} [data-find-count]')?.textContent === "2/3"`, {
      label: "next match",
    });
    await shot("find-in-page.png");
    await page!.eval(
      `document.querySelector('${tab} [data-find-input]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`,
    );
    await page!.waitFor(`!document.querySelector('${tab} [data-find-bar]')`, { label: "find bar closed" });

    // Zoom: in, shown in the address bar, and back.
    await press("Plus", [modKey]);
    await page!.waitFor(`document.querySelector('${chromeFor(tab)} [data-zoom]')?.dataset.zoom === "110"`, {
      label: "zoomed to 110%",
    });
    await press("0", [modKey]);
    await page!.waitFor(`!document.querySelector('${chromeFor(tab)} [data-zoom]')`, { label: "actual size" });

    // The mouse's back and forward buttons in the page (webviews don't act on them themselves).
    // With a user gesture: Chromium's back skips pages that navigated away without one.
    await page!.eval(
      `document.querySelector('${tab} webview').executeJavaScript('location.href = "/second?mouse"; true', true)`,
    );
    const guest = await Page.connect(port, 10_000, (t) => t.type === "webview" && t.url.endsWith("/second?mouse"));
    const mouse = async (button: "back" | "forward") => {
      for (const type of ["mousePressed", "mouseReleased"])
        await guest.send("Input.dispatchMouseEvent", { type, x: 40, y: 40, button, clickCount: 1 });
    };
    try {
      await mouse("back");
      await waitForValue(async () => ((await inPage<string>(`location.pathname`)) === "/keys" ? true : undefined));
      await mouse("forward");
      await waitForValue(async () => ((await inPage<string>(`location.pathname`)) === "/second" ? true : undefined));
    } finally {
      guest.close();
    }

    // Ctrl+T is the browser's even in a page; Ctrl+W closes that tab and leaves the window.
    await press("T", [modKey]);
    const blank = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 2} && document.querySelector('nav li[aria-current="page"]')?.dataset.appId`,
      { label: "new tab from the page" },
    );
    if (blank === tabId) throw new Error("the new tab isn't the one shown");
    await page!.eval(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", ${mod}: true, bubbles: true })), true`,
    );
    await page!.waitFor(`document.querySelectorAll("nav li").length === ${count + 1}`, { label: "Ctrl+W closed it" });

    // Ctrl+W in Settings goes back to the tabs instead of closing anything.
    await click('[data-page-link="Settings"]');
    await page!.waitFor(`!!document.querySelector("[data-settings-shell]")`, { label: "settings" });
    await page!.eval(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", ${mod}: true, bubbles: true })), true`,
    );
    await page!.waitFor(`!document.querySelector("[data-settings-shell]")`, { label: "back from Settings" });
    if ((await page!.eval<number>(`document.querySelectorAll("nav li").length`)) !== count + 1)
      throw new Error("Ctrl+W in Settings closed a tab");

    // Ctrl+1 / Ctrl+9 from inside the page: the first and the last tab.
    await click(`nav li[data-app-id="${tabId}"]`);
    await page!.waitFor(`document.querySelector('nav li[aria-current="page"]')?.dataset.appId === "${tabId}"`);
    await press("1", [modKey]);
    await Bun.sleep(700);
    const first = await page!.eval<string>(`document.querySelector('nav li[aria-current="page"]')?.dataset.appId`);
    if (first === tabId && count > 0) throw new Error("Ctrl+1 didn't switch to the first tab");

    // Settings → Keyboard shortcuts: a new key for Find in page, recorded by pressing it, then reset.
    await openSettingsAt("shortcuts");
    await page!.waitFor(`!!document.querySelector('[data-shortcut="find.open"]')`, { label: "shortcut list" });
    await shot("settings-shortcuts.png");
    await click('[data-shortcut="find.open"] [data-shortcut-add]');
    await page!.waitFor(`document.activeElement === document.querySelector("[data-shortcut-recording]")`, {
      label: "recording",
    });
    await page!.eval(
      `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "u", code: "KeyU", ctrlKey: true, altKey: true, bubbles: true, cancelable: true })), true`,
    );
    await page!.waitFor(`!!document.querySelector('[data-shortcut="find.open"] [data-shortcut-key="Ctrl+Alt+U"]')`, {
      label: "the new key",
    });
    const saved = await waitForValue(async () => {
      const s = await apiCall<{ shortcuts: Record<string, string[]> }>("/api/settings");
      return s.shortcuts["find.open"]?.includes("Ctrl+Alt+U") ? s.shortcuts["find.open"] : undefined;
    });
    await click('[data-shortcut="find.open"] [data-shortcut-reset]');
    await page!.waitFor(`!document.querySelector('[data-shortcut="find.open"] [data-shortcut-key="Ctrl+Alt+U"]')`, {
      label: "reset",
    });
    await apiCall(`/api/apps/${tabId}`, { method: "DELETE" });
    return `page kept Ctrl+K, find 3 matches, zoom, mouse back/forward, Ctrl+T/W, Ctrl+1, recorded ${saved.join(", ")}`;
  });

  await check("agent sidebar: closed on web tabs until opened (Ctrl+J), remembered per tab", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "web tab in the sidebar" },
    );
    await page!.waitFor(`!!document.querySelector('[data-tab-chrome="${tabId}"] [data-address]')`, {
      label: "web tab",
    });
    if (await page!.eval<boolean>(`!!document.querySelector("[data-agent-sidebar]")`))
      throw new Error("the agent sidebar is open on a new web tab");
    const ctrlJ = () =>
      page!.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ${mod}: true, bubbles: true })), true`);
    await ctrlJ();
    await page!.waitFor(`!!document.querySelector('[data-agent-for="${tabId}"]')`, { label: "opened with Ctrl+J" });
    // Another tab and back: still open for this one.
    await click(`nav li[data-app-id="${webTabId}"]`);
    await page!.waitFor(
      `document.querySelector('nav li[data-app-id="${tabId}"]').getAttribute("aria-current") !== "page"`,
      { label: "other tab" },
    );
    await click(`nav li[data-app-id="${tabId}"]`);
    await page!.waitFor(`!!document.querySelector('[data-agent-for="${tabId}"]')`, { label: "still open" });
    await ctrlJ();
    await page!.waitFor(`!document.querySelector("[data-agent-sidebar]")`, { label: "closed with Ctrl+J" });
    await apiCall(`/api/apps/${tabId}`, { method: "DELETE" });
    return "closed by default, opened, remembered, closed";
  });

  await check("page changes: hide, rewrite, insert, buttons; dynamic content, toggles, removal, reloads", async () => {
    if (!webTabId) throw new Error("needs the web tab");
    const tab = `[data-web-tab="${webTabId}"]`;
    const inPage = <T>(code: string) =>
      page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
    const until = (code: string, label: string) =>
      waitForValue(async () => ((await inPage<boolean>(code).catch(() => false)) ? true : undefined), 15_000).catch(
        () => {
          throw new Error(`timed out: ${label}`);
        },
      );
    await click(`nav li[data-app-id="${webTabId}"]`);
    const site = { type: "site", value: "127.0.0.1" };
    const add = (change: Record<string, unknown>) =>
      apiCall<{ id: string }>("/api/page-changes", { method: "POST", body: change });
    const hide = await add({ title: "Hide the buy button", scope: site, action: "hide", selector: ".cta" });
    const text = await add({
      title: "New headline",
      scope: { type: "page", value: "127.0.0.1/" },
      action: "text",
      selector: "#headline",
      value: "Changed headline",
    });
    const insert = await add({
      title: "Add a note",
      scope: { type: "pattern", value: "127.0.0.1/*" },
      action: "insert",
      selector: "#headline",
      value: '<p class="added">Inserted note</p>',
    });
    await add({
      title: "Count button",
      scope: site,
      action: "button",
      selector: "main",
      position: "append",
      value: "Count",
      onClick: 'button.textContent = "Clicked";',
    });
    await add({ title: "Tooltip", scope: site, action: "attribute", selector: ".lead", name: "title", value: "tip" });
    await add({ title: "Elsewhere", scope: { type: "site", value: "example.com" }, action: "hide", selector: "h1" });

    await until(`getComputedStyle(document.querySelector(".cta")).display === "none"`, "hidden");
    await until(`document.querySelector("#headline").textContent === "Changed headline"`, "text");
    await until(`document.querySelector("#headline + .added")?.textContent === "Inserted note"`, "inserted");
    await until(`document.querySelector(".lead").title === "tip"`, "attribute");
    // Content the page adds later gets the changes too.
    await inPage(`document.querySelector("main").insertAdjacentHTML("beforeend", '<p class="lead">Later</p>'), true`);
    await until(`[...document.querySelectorAll(".lead")].every((el) => el.title === "tip")`, "dynamic content");
    await until(`!!document.querySelector("button.rune-button")`, "button");
    await inPage(`document.querySelector("button.rune-button").click(), true`);
    await until(`document.querySelector("button.rune-button").textContent === "Clicked"`, "button behavior");

    // Every change on the page, each with its switch; the other site's isn't listed.
    await click(`${chromeFor(tab)} [data-customized]`);
    await page!.waitFor(`document.querySelectorAll("[data-page-changes] [data-page-change]").length === 5`, {
      label: "five changes listed",
    });
    await shot("page-changes.png");
    await click(`[data-page-changes] [data-page-change="${text.id}"] [role="switch"]`);
    await until(`document.querySelector("#headline").textContent === "Hello from the test site"`, "turned off");
    await click(`[data-page-changes] [data-page-change="${insert.id}"] [data-remove-page-change]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    await until(`!document.querySelector(".added")`, "removed");
    await page!.waitFor(`document.querySelectorAll("[data-page-changes] [data-page-change]").length === 4`, {
      label: "removed from the list",
    });
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);

    // After a reload: still hidden, still off, still gone.
    await inPage(`location.reload(), true`);
    await until(
      `document.readyState === "complete" && !!document.querySelector("button.rune-button")`,
      "reloaded with the button",
    );
    await until(`getComputedStyle(document.querySelector(".cta")).display === "none"`, "hidden after reload");
    const after = await inPage<string>(
      `document.querySelector("#headline").textContent + "|" + !!document.querySelector(".added")`,
    );
    if (after !== "Hello from the test site|false") throw new Error(`after reload: ${after}`);
    await apiCall(`/api/page-changes/${hide.id}`, { method: "DELETE" });
    await until(`getComputedStyle(document.querySelector(".cta")).display !== "none"`, "removed through the API");
    // The checks after this one get the page as it is.
    for (const change of await apiCall<{ id: string }[]>("/api/page-changes"))
      await apiCall(`/api/page-changes/${change.id}`, { method: "DELETE" });
    await until(`!document.querySelector("button.rune-button")`, "all removed");
    return "5 changes applied, one turned off, one removed";
  });

  await check("tab unloading: idle tabs unload unless pinned, come back as they were, wake for agents", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "web tab in the sidebar" },
    );
    const tab = `[data-web-tab="${tabId}"]`;
    const other = `nav li:not([data-app-id="${tabId}"])`;
    const li = `nav li[data-app-id="${tabId}"]`;
    const inPage = <T>(code: string) =>
      page!
        .eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`)
        .catch((err) => {
          throw new Error(`${String(err).slice(0, 80)} in: ${code.slice(0, 120)}`);
        });
    await page!.waitFor(`!!document.querySelector('${chromeFor(tab)} [data-address]')`, { label: "address bar" });
    await page!.eval(`(() => {
      const input = document.querySelector('${chromeFor(tab)} [data-address]');
      input.value = "${site.url.origin}/form";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.form.requestSubmit();
      return true;
    })()`);
    await page!.waitFor(`document.querySelector('${li}')?.innerText.includes("Form page")`, {
      timeoutMs: 20_000,
      label: "form page",
    });
    await waitForValue(async () => ((await inPage<boolean>(`!!document.querySelector("#note")`)) ? true : undefined));
    await inPage(`(() => {
      const set = (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      set(document.querySelector("#note"), "typed before unloading");
      set(document.querySelector("#long"), "line one\\nline two");
      set(document.querySelector("#pw"), "hunter2");
      window.scrollTo(0, 1500);
      return true;
    })()`);
    const openMenu = async () => {
      await page!.eval(`(() => {
        const el = document.querySelector('${li}');
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
        return true;
      })()`);
      await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "tab menu" });
    };
    const choose = async (label: string) => {
      await openMenu();
      await click("[data-context-menu] button", label);
      await page!.waitFor(`!document.querySelector("[data-context-menu]")`, { label: "menu to close" });
    };
    // On screen: never unloaded, and "Unload" is off.
    await page!.eval(`window.__runeTabs.sweep(4 * 3600_000)`);
    if (!(await page!.eval<boolean>(`!!document.querySelector('${tab} webview')`)))
      throw new Error("the tab on screen was unloaded");
    await openMenu();
    const unloadDisabled = await page!.eval<boolean>(
      `[...document.querySelectorAll("[data-context-menu] button")].find((b) => b.textContent.includes("Unload")).disabled`,
    );
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    if (!unloadDisabled) throw new Error("Unload is offered for the tab on screen");

    // Pinned and in the background: still not unloaded.
    await choose("Pin");
    await page!.waitFor(`document.querySelector('${li}').hasAttribute("data-pinned")`, { label: "pinned" });
    await click(other);
    await page!.waitFor(`document.querySelector('${li}').getAttribute("aria-current") !== "page"`, {
      label: "other tab selected",
    });
    const swept = await page!.eval<string[]>(`window.__runeTabs.sweep(4 * 3600_000)`);
    if (swept.includes(tabId) || !(await page!.eval<boolean>(`!!document.querySelector('${tab} webview')`)))
      throw new Error("a pinned tab was unloaded");

    // Not pinned: idle long enough, it's unloaded.
    await choose("Unpin");
    await page!.waitFor(`!document.querySelector('${li}').hasAttribute("data-pinned")`, { label: "unpinned" });
    const idleNow = await page!.eval<string[]>(`window.__runeTabs.sweep(60_000)`);
    if (idleNow.includes(tabId)) throw new Error("unloaded after a minute");
    await page!.eval(`window.__runeTabs.sweep(4 * 3600_000)`);
    await page!.waitFor(
      `!document.querySelector('${tab}') && !document.querySelector('${li}').hasAttribute("data-loaded")`,
      { label: "unloaded" },
    );
    await shot("tab-unloaded.png");

    // Opened again: same page, scroll position and input; never the password.
    await click(li);
    await page!.waitFor(`!!document.querySelector('${tab} webview')`, { label: "page back" });
    const restored = await waitForValue(async () => {
      const r = await inPage<{ note: string; long: string; pw: string; y: number }>(
        `({ note: document.querySelector("#note")?.value, long: document.querySelector("#long")?.value, pw: document.querySelector("#pw")?.value, y: Math.round(window.scrollY) })`,
      );
      return r?.note === "typed before unloading" && r.y > 1000 ? r : undefined;
    }, 15_000);
    if (restored.long !== "line one\nline two")
      throw new Error(`textarea not restored: ${JSON.stringify(restored.long)}`);
    if (restored.pw) throw new Error("the password field was restored");

    // Unloaded by hand, then woken up in the background like an agent's page tool would.
    await click(other);
    await page!.waitFor(`document.querySelector('${li}').getAttribute("aria-current") !== "page"`, {
      label: "other tab selected",
    });
    await choose("Unload");
    await page!.waitFor(`!document.querySelector('${tab}')`, { label: "unloaded by hand" });
    const woken = await page!.eval<string>(`window.__runeTabs.wake(${JSON.stringify(tabId)})`);
    if (!woken.endsWith("/form")) throw new Error(`woke up on ${woken}`);
    const background = await page!.eval<boolean>(
      `!!document.querySelector('${tab} webview') && document.querySelector('${li}').getAttribute("aria-current") !== "page"`,
    );
    if (!background) throw new Error("waking it should load it without showing it");
    await apiCall(`/api/apps/${tabId}`, { method: "DELETE" });
    await page!.waitFor(`!document.querySelector('${li}')`, { label: "tab deleted" });
    return `restored scroll ${restored.y}px and 2 fields; pinned kept; woke on ${new URL(woken).pathname}`;
  });

  await check("shared tab context: @ mentions another tab, web pages stay away from app builders", async () => {
    if (!webTabId) throw new Error("needs the web tab from the web tab check");
    const tabs = await page!.eval<{ id: string; name: string; web: boolean }[]>(
      `[...document.querySelectorAll("nav li[data-app-id]")].map((li) => ({ id: li.dataset.appId, name: li.innerText.split("\\n")[0].trim(), web: !!document.querySelector('[data-web-tab="' + li.dataset.appId + '"]') }))`,
    );
    const second = tabs.find((t) => t.name === "Second page");
    const app = tabs.find((t) => t.name === "E2E renamed");
    if (!second || !app) throw new Error(`tabs: ${tabs.map((t) => t.name).join(", ")}`);
    const type = (panel: string, text: string) =>
      page!.eval(`(() => {
        const t = document.querySelector(${JSON.stringify(`${panel} textarea`)});
        t.focus();
        t.value = ${JSON.stringify(text)};
        t.setSelectionRange(t.value.length, t.value.length);
        t.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return true;
      })()`);

    // In the web tab: "@Sec" offers the other page; Enter shares it.
    await click(`nav li[data-app-id="${webTabId}"]`);
    const web = `[data-web-tab="${webTabId}"]`;
    const webAgent = agentOf(webTabId);
    if (!(await page!.eval<boolean>(`!!document.querySelector('${webAgent}')`)))
      await click(`${chromeFor(web)} [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${webAgent} textarea')`, { label: "website agent's composer" });
    await type(webAgent, "Compare with @Sec");
    await page!.waitFor(`!!document.querySelector('${webAgent} [data-mentions] [data-mention="${second.id}"]')`, {
      label: "mention list",
    });
    await shot("share-mention.png");
    await page!.eval(
      `document.querySelector('${webAgent} textarea').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })), true`,
    );
    await page!.waitFor(`!!document.querySelector('${webAgent} [data-share-chip="${second.id}"]')`, {
      label: "share chip",
    });
    const left = await page!.eval<string>(`document.querySelector('${webAgent} textarea').value`);
    if (left.trim() !== "Compare with") throw new Error(`the mention stayed in the text: ${JSON.stringify(left)}`);
    // Removing the chip unshares it.
    await click(`${webAgent} [data-share-chip="${second.id}"] button`);
    await page!.waitFor(`!document.querySelector('${webAgent} [data-share-chip]')`, { label: "chip removed" });
    await type(webAgent, "");

    // In an app tab, web pages are offered but can't be picked: the app builder has tools.
    await click(`nav li[data-app-id="${app.id}"]`);
    const appTab = `[data-app-tab="${app.id}"]`;
    const appAgent = agentOf(app.id);
    const wasHidden = !(await page!.eval<boolean>(`!!document.querySelector('${appAgent}')`));
    if (wasHidden) await click(`${chromeFor(appTab)} [data-agent-show]`);
    await page!.waitFor(`!!document.querySelector('${appAgent} textarea')`, { label: "app builder's composer" });
    await type(appAgent, "@");
    await page!.waitFor(`!!document.querySelector('${appAgent} [data-mentions] [data-mention="${webTabId}"]')`, {
      label: "mention list in the app",
    });
    const disabled = await page!.eval<string | null>(
      `document.querySelector('${appAgent} [data-mention="${webTabId}"]').getAttribute("aria-disabled")`,
    );
    if (disabled !== "true") throw new Error("a web page could be shared with the app builder");
    await click(`${appAgent} [data-mention="${webTabId}"]`);
    await Bun.sleep(200);
    if (await page!.eval<boolean>(`!!document.querySelector('${appAgent} [data-share-chip]')`))
      throw new Error("the web page was shared anyway");
    await type(appAgent, "");
    if (wasHidden) await click(`${appAgent} [data-agent-hide]`);
    return "mentioned, shared, unshared; web page refused for the app builder";
  });

  await check("browse: the website agent's clicks, typing and keys are real input in the tab", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "web tab in the sidebar" },
    );
    const tab = `[data-web-tab="${tabId}"]`;
    const rpc = <T>(method: string, params: object = {}) =>
      page!.eval<T>(`window.__runeRpc(${JSON.stringify(method)}, ${JSON.stringify({ tabId, ...params })})`);
    const inPage = <T>(code: string) =>
      page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
    await page!.waitFor(`!!document.querySelector('${chromeFor(tab)} [data-address]')`, { label: "address bar" });
    await rpc("page.navigate", { url: `${site.url.origin}/act` });
    await page!.waitFor(`document.querySelector('nav li[data-app-id="${tabId}"]')?.innerText.includes("Act page")`, {
      timeoutMs: 20_000,
      label: "act page",
    });

    // Found by its text, clicked with a real (trusted) click, shown where it happened.
    const next = await rpc<{ x: number; y: number; label: string }>("page.target", { text: "Next" });
    if (next.label !== "Next") throw new Error(`found ${JSON.stringify(next)}`);
    await rpc("page.act", { kind: "click", x: next.x, y: next.y });
    await page!.waitFor(`!!document.querySelector('${tab} [data-agent-marker]')`, { label: "click marker" });
    await shot("browse-click.png");
    await waitForValue(async () =>
      (await inPage<string>(`document.querySelector("#out").textContent`)) === "clicked next true" ? true : undefined,
    );

    // Typed into a field, then Enter submits its form.
    const field = await rpc<{ x: number; y: number; form: { action: string } | null }>("page.target", {
      selector: "#q",
    });
    if (!field.form?.action.endsWith("/act-done")) throw new Error(`form: ${JSON.stringify(field.form)}`);
    await rpc("page.act", { kind: "type", x: field.x, y: field.y, value: "socks", clear: true });
    const typed = await inPage<string>(`document.querySelector("#q").value`);
    if (typed !== "socks") throw new Error(`typed ${JSON.stringify(typed)}`);
    await rpc("page.act", { kind: "key", key: "Enter" });
    const settled = await rpc<{ url: string; title: string }>("page.settle");
    if (!settled.url.includes("/act-done?q=socks")) throw new Error(`after Enter: ${settled.url}`);

    // A select and a checkbox filled in.
    await rpc("page.navigate", { url: `${site.url.origin}/act` });
    await rpc("page.act", { kind: "fill", selector: "#size", x: 0, y: 0, value: "M" });
    await rpc("page.act", { kind: "fill", selector: "#gift", x: 0, y: 0, value: "true" });
    const filled = await inPage<string>(
      `document.querySelector("#size").value + "|" + document.querySelector("#gift").checked`,
    );
    if (filled !== "M|true") throw new Error(`filled ${filled}`);
    if (!(await rpc<boolean>("page.waitFor", { text: "act", timeoutMs: 1000 })))
      throw new Error("wait_for didn't see the page");
    await apiCall(`/api/apps/${tabId}`, { method: "DELETE" });
    return "clicked (trusted), typed and submitted with Enter, filled a select and a checkbox";
  });

  await check("mods: gallery, make one from a page change, share code, review, install, turn off, remove", async () => {
    type Change = { id: string; title: string; enabled: boolean; modId?: string | null };
    const mine = await apiCall<Change>("/api/page-changes", {
      method: "POST",
      body: {
        title: "E2E mod change",
        scope: { type: "site", value: "127.0.0.1" },
        action: "css",
        value: "body { outline: 1px solid red }",
      },
    });
    await openSettingsAt("mods");
    await page!.waitFor(`!!document.querySelector("[data-mods]")`, { label: "mods page" });

    await click(`[data-mods-tab="gallery"]`);
    await page!.waitFor(`document.querySelectorAll("[data-gallery-mod]").length >= 3`, { label: "gallery" });
    await shot("mods-gallery.png");

    // Made from the page change: a share code comes out.
    await click(`[data-mods-tab="create"]`);
    await page!.waitFor(`!!document.querySelector('[data-mod-change="${mine.id}"]')`, {
      label: "own page changes listed",
    });
    await page!.eval(`(() => {
      const name = document.querySelector("[data-mod-name]");
      name.value = "E2E mod";
      name.dispatchEvent(new InputEvent("input", { bubbles: true }));
      document.querySelector('[data-mod-change="${mine.id}"]').click();
      return true;
    })()`);
    await click("[data-mod-make]");
    const code = await page!.waitFor<string>(`document.querySelector("[data-mod-code]")?.value`, {
      label: "share code",
    });
    if (!code.startsWith("RUNE-MOD:")) throw new Error(`code: ${code.slice(0, 40)}`);
    await shot("mods-made.png");

    // Installed from the code (as someone else would), after the review.
    await apiCall(`/api/page-changes/${mine.id}`, { method: "DELETE" });
    await page!.eval(`(() => {
      const input = document.querySelector("[data-mod-input]");
      input.value = ${JSON.stringify(code)};
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })()`);
    await click("[data-mod-review]");
    await page!.waitFor(`!!document.querySelector("[data-mod-review-dialog]")`, { label: "review dialog" });
    const permissions = await page!.eval<string[]>(
      `[...document.querySelectorAll("[data-mod-permission]")].map((p) => p.dataset.modPermission + ": " + p.innerText)`,
    );
    if (!permissions.some((p) => p.startsWith("info:") && p.includes("127.0.0.1")))
      throw new Error(`review: ${permissions.join(" | ")}`);
    await shot("mods-review.png");
    await click("[data-mod-install]");
    await page!.waitFor(
      `!document.querySelector("[data-mod-review-dialog]") && !!document.querySelector("[data-mod]")`,
      { label: "installed" },
    );
    const modId = await page!.eval<string>(`document.querySelector("[data-mod]").dataset.mod`);
    const installed = (await apiCall<Change[]>("/api/page-changes")).filter((c) => c.modId === modId);
    if (installed.length !== 1 || installed[0]!.title !== "E2E mod change")
      throw new Error(`installed changes: ${JSON.stringify(installed)}`);

    // Off: its change is off; removed: it's gone.
    await click(`[data-mod="${modId}"] [data-mod-toggle]`);
    await waitForValue(async () =>
      (await apiCall<Change[]>("/api/page-changes")).find((c) => c.modId === modId)?.enabled === false
        ? true
        : undefined,
    );
    await click(`[data-mod="${modId}"] [data-mod-remove]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm remove" });
    await click("[data-confirm-dialog] [data-confirm]");
    await page!.waitFor(`!document.querySelector('[data-mod="${modId}"]')`, { label: "removed" });
    if ((await apiCall<Change[]>("/api/page-changes")).some((c) => c.modId === modId))
      throw new Error("the mod's change is still there");

    // A mod with a script is flagged before anything is installed.
    const scripty = {
      format: "rune-mod",
      version: 1,
      id: "e2e-scripty",
      name: "Scripty",
      author: "Someone",
      pageChanges: [
        {
          title: "Watch",
          scope: { type: "pattern", value: "*" },
          action: "script",
          value: "console.log(location.href)",
        },
      ],
    };
    await page!.eval(`(() => {
      const input = document.querySelector("[data-mod-input]");
      input.value = ${JSON.stringify(JSON.stringify(scripty))};
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })()`);
    await click("[data-mod-review]");
    await page!.waitFor(`document.querySelector('[data-mod-permission="danger"]')?.innerText.includes("every site")`, {
      label: "script warning",
    });
    await shot("mods-review-script.png");
    await click("[data-mod-cancel]");
    await page!.waitFor(`!document.querySelector("[data-mod-review-dialog]")`, { label: "review closed" });
    if ((await apiCall<unknown[]>("/api/mods")).length) throw new Error("cancelling installed it anyway");
    return "made, shared as a code, reviewed, installed, turned off, removed; a script mod flagged";
  });

  await check("network: requests with their data, credentials hidden, sent again, saved, blocked", async () => {
    if (!webTabId) throw new Error("needs the web tab");
    const tab = `[data-web-tab="${webTabId}"]`;
    const panel = `${tab} [data-network-panel]`;
    const inPage = <T>(code: string) =>
      page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
    const panelText = () => page!.eval<string>(`document.querySelector('${panel}')?.innerText ?? ""`);
    const secrets = ["cookie-secret-1", "key-secret-2", "bearer-secret-3", "resp-secret-4"];
    const leaked = (text: string) => secrets.filter((s) => text.includes(s));
    const status = () => inPage<string>(`document.getElementById("status")?.textContent ?? ""`);
    const goTo = async (url: string) => {
      await inPage(`location.href = ${JSON.stringify(url)}, true`);
      await waitForValue(async () => ((await inPage<string>("location.href")) === url ? true : undefined), 15_000);
    };

    await click(`nav li[data-app-id="${webTabId}"]`);
    await runCommand("network requests", "tab.network");
    await page!.waitFor(`!!document.querySelector('${panel}')`, { label: "network panel" });
    await goTo(`${site.url.origin}/feed`);
    await waitForValue(async () => ((await status()) === "Loaded 2 items" ? true : undefined), 15_000);
    const feedRow = `[...document.querySelectorAll('${panel} [data-network-entry]')].find((r) => r.title.includes("/api/feed"))`;
    await page!.waitFor(`!!${feedRow}`, { label: "the feed request", timeoutMs: 10_000 });
    await page!.eval(`${feedRow}.click(), true`);
    await page!.waitFor(
      `document.querySelector('${panel} [data-network-response]')?.innerText.includes("Second post")`,
      { label: "the response data" },
    );
    const hidden = await panelText();
    if (leaked(hidden).length) throw new Error(`credentials shown without asking: ${leaked(hidden).join(", ")}`);
    if (!hidden.includes("[redacted]")) throw new Error("nothing redacted");
    await shot("network.png");

    // Shown when asked.
    await click(`${panel} [data-network-reveal]`);
    await page!.waitFor(
      `document.querySelector('${panel} [data-network-detail]')?.innerText.includes("bearer-secret-3")`,
      { label: "revealed credentials" },
    );
    await click(`${panel} [data-network-reveal]`);
    await page!.waitFor(
      `!document.querySelector('${panel} [data-network-detail]')?.innerText.includes("bearer-secret-3")`,
      { label: "hidden again" },
    );

    // Sent again: the session's cookie and the original token go along.
    const before = siteSeen.length;
    await click(`${panel} [data-network-replay]`);
    await page!.waitFor(`document.querySelector('${panel} [data-network-result]')?.innerText.includes("HTTP 200")`, {
      label: "replay result",
    });
    const replayed = siteSeen[before];
    if (
      replayed?.authorization !== "Bearer bearer-secret-3" ||
      !replayed.cookie?.includes("sid=cookie-secret-1") ||
      !replayed.url.includes("api_key=key-secret-2")
    ) {
      throw new Error(`the replay didn't carry the session: ${JSON.stringify(replayed)}`);
    }

    // Saved: its credentials are sealed, and it's sent later without the page.
    await click(`${panel} [data-network-save]`);
    await page!.waitFor(`!!document.querySelector('${panel} [data-network-save-name]')`, { label: "name field" });
    await page!.eval(`(() => {
      const input = document.querySelector('${panel} [data-network-save-name]');
      input.value = "Feed page 1";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    })()`);
    const saved = await waitForValue(async () =>
      (await apiCall<{ id: string; name: string; hasCredentials: boolean }[]>("/api/network/requests")).find(
        (r) => r.name === "Feed page 1",
      ),
    );
    const stored = JSON.stringify(await apiCall("/api/network/requests"));
    if (leaked(stored).length || !saved.hasCredentials) throw new Error(`saved request: ${stored}`);
    await goTo(`${site.url.origin}/second`);
    await click(`${panel} [data-network-saved-tab]`);
    await page!.waitFor(`!!document.querySelector('${panel} [data-saved-request="Feed page 1"] [data-send-saved]')`, {
      label: "saved list",
    });
    const beforeSaved = siteSeen.length;
    await click(`${panel} [data-saved-request="Feed page 1"] [data-send-saved]`);
    await page!.waitFor(
      `document.querySelector('${panel} [data-saved-request="Feed page 1"] [data-network-result]')?.innerText.includes("HTTP 200")`,
      {
        label: "saved request result",
      },
    );
    const sent = siteSeen[beforeSaved];
    if (
      sent?.authorization !== "Bearer bearer-secret-3" ||
      !sent.cookie?.includes("sid=cookie-secret-1") ||
      !sent.url.includes("api_key=key-secret-2")
    ) {
      throw new Error(`the saved request didn't carry the session: ${JSON.stringify(sent)}`);
    }
    const sentText = await panelText();
    if (leaked(sentText).length)
      throw new Error(`the saved request's result shows credentials: ${leaked(sentText).join(", ")}`);

    // Blocked by a rule.
    await click(`${panel} [role="tab"]`, "Requests");
    await goTo(`${site.url.origin}/feed`);
    await waitForValue(async () => ((await status()) === "Loaded 2 items" ? true : undefined), 15_000);
    await page!.waitFor(`!!${feedRow}`, { label: "the feed request again" });
    await page!.eval(`${feedRow}.click(), true`);
    await page!.waitFor(`!!document.querySelector('${panel} [data-network-block]')`);
    await click(`${panel} [data-network-block]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
    await click("[data-confirm-dialog] [data-confirm]");
    const rule = await waitForValue(async () =>
      (await apiCall<{ id: string; pattern: string }[]>("/api/network/rules")).find((r) =>
        r.pattern.includes("/api/feed"),
      ),
    );
    await Bun.sleep(300); // the rules reach the main process over the hub
    const beforeBlock = siteSeen.length;
    await inPage("location.reload(), true");
    await waitForValue(async () => ((await status()) === "Failed to load" ? true : undefined), 15_000);
    if (siteSeen.length !== beforeBlock) throw new Error("the blocked request reached the site");
    await apiCall(`/api/network/rules/${rule.id}`, { method: "DELETE" });

    await runCommand("hide network requests", "tab.network");
    await goTo(`${site.url.origin}/`);
    return `${secrets.length} kinds of credentials hidden, replayed and saved with the session, blocked by ${rule.pattern}`;
  });

  await check(
    "response overrides: other data, a changed answer, failures, slow and hanging requests, removed",
    async () => {
      if (!webTabId) throw new Error("needs the web tab");
      const tab = `[data-web-tab="${webTabId}"]`;
      const inPage = <T>(code: string) =>
        page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
      const status = () => inPage<string>(`document.getElementById("status")?.textContent ?? ""`);
      const shows = (text: string, timeoutMs = 15_000) =>
        waitForValue(async () => ((await status()) === text ? true : undefined), timeoutMs);
      const reload = async () => {
        await inPage("location.reload(), true");
        await Bun.sleep(200);
      };
      type Override = { id: string; title: string };
      // As the website agent's override_response stores one, then hands the list to the tabs (there's no API to make one).
      const workspaceId = (await apiCall<{ id: string; workspaceId: string }[]>("/api/apps")).find(
        (a) => a.id === webTabId,
      )!.workspaceId;
      const add = async (spec: Record<string, unknown>): Promise<Override> => {
        const { Database } = await import("bun:sqlite");
        const id = crypto.randomUUID().slice(0, 8);
        const full = {
          scope: { type: "tab", tabId: webTabId },
          pattern: "/api/feed",
          method: null,
          kind: "respond",
          status: null,
          headers: {},
          body: null,
          failure: "Failed",
          delayMs: 0,
          expiresAt: null,
          ...spec,
        };
        const db = new Database(join(profile, "data", "rune.sqlite"));
        db.run("INSERT INTO response_overrides (id, workspace_id, spec) VALUES (?, ?, ?)", [
          id,
          workspaceId,
          JSON.stringify(full),
        ]);
        db.close();
        await page!.eval(`window.__runeRpc("network.syncOverrides", {})`);
        return { id, title: String(spec.title) };
      };
      const remove = async (o: Override) => {
        await apiCall(`/api/response-overrides/${o.id}`, { method: "DELETE" });
        await Bun.sleep(300); // the hub tells the window, which tells the main process
      };

      await click(`nav li[data-app-id="${webTabId}"]`);
      await inPage(`location.href = ${JSON.stringify(`${site.url.origin}/feed`)}, true`);
      await shows("Loaded 2 items");
      if (await page!.eval<boolean>(`!!document.querySelector("[data-overrides]")`))
        throw new Error("the flask shows without overrides");

      // Answered without the site.
      const empty = await add({ title: "Empty feed", status: 200, body: JSON.stringify({ items: [] }) });
      let before = siteSeen.length;
      await reload();
      await shows("Loaded 0 items");
      if (siteSeen.length !== before) throw new Error("a made-up answer still reached the site");
      await page!.waitFor(`document.querySelector('[data-overrides]')?.innerText.trim() === "1"`, {
        label: "the address bar's flask",
      });
      const logged = await page!.eval<{ url: string; override: string | null }[]>(
        `window.__runeRpc("network.list", { tabId: ${JSON.stringify(webTabId)}, filter: { query: "/api/feed" } })`,
      );
      if (!logged.some((e) => e.override === "Empty feed"))
        throw new Error(`the Network log doesn't say it was overridden: ${JSON.stringify(logged.slice(-2))}`);
      await click("[data-overrides]");
      await page!.waitFor(
        `!!document.querySelector('[data-response-overrides] [data-response-override="${empty.id}"]')`,
        {
          label: "the overrides popover",
        },
      );
      await shot("response-overrides.png");
      await click(`[data-response-overrides] [data-response-override="${empty.id}"] [data-remove-response-override]`);
      await page!.waitFor(`!document.querySelector("[data-overrides]")`, { label: "the flask gone" });
      await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })), true`);

      // The site's answer, changed: it's asked, and its body replaced.
      const changed = await add({ title: "One item", body: JSON.stringify({ items: [1] }) });
      before = siteSeen.length;
      await reload();
      await shows("Loaded 1 items");
      if (siteSeen.length === before) throw new Error("the site wasn't asked for the answer to change");
      await remove(changed);

      // Slow: the site's answer, later.
      const slow = await add({ title: "Slow", delayMs: 1500 });
      const started = Date.now();
      await reload();
      await shows("Loaded 2 items");
      const took = Date.now() - started;
      if (took < 1400) throw new Error(`the slow answer came after ${took} ms`);
      await remove(slow);

      // Failing.
      const offline = await add({ title: "Offline", kind: "fail", failure: "InternetDisconnected" });
      await reload();
      await shows("Failed to load");
      await remove(offline);

      // Never answering, until the override goes: then the request goes on to the site.
      const hang = await add({ title: "Loading forever", kind: "hang" });
      await reload();
      await shows("Loading…");
      await Bun.sleep(1500);
      if ((await status()) !== "Loading…") throw new Error(`the hanging request was answered: ${await status()}`);
      await remove(hang);
      await shows("Loaded 2 items");

      await inPage(`location.href = ${JSON.stringify(`${site.url.origin}/`)}, true`);
      return "made-up and changed answers, slow, failing and hanging requests; the flask, the log, removal";
    },
  );

  await check("API map: the site's API learned while browsing, shapes only, browsable, deletable", async () => {
    if (!webTabId) throw new Error("needs the web tab");
    const tab = `[data-web-tab="${webTabId}"]`;
    const inPage = <T>(code: string) =>
      page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
    const workspaceId = (await apiCall<{ id: string; workspaceId: string }[]>("/api/apps")).find(
      (a) => a.id === webTabId,
    )?.workspaceId;
    await click(`nav li[data-app-id="${webTabId}"]`);
    await inPage(`location.href = ${JSON.stringify(`${site.url.origin}/feed`)}, true`);
    await waitForValue(
      async () =>
        (await inPage<string>(`document.getElementById("status")?.textContent ?? ""`)) === "Loaded 2 items"
          ? true
          : undefined,
      15_000,
    );
    const host = site.url.host;
    const endpoint = await waitForValue(async () => {
      const list = await apiCall<{ path: string; method: string; query: Record<string, unknown> }[]>(
        `/api/endpoints/hosts/${encodeURIComponent(host)}?workspace=${workspaceId}`,
      );
      return list.find((e) => e.method === "GET" && e.path === "/api/feed");
    }, 15_000);
    const stored = JSON.stringify(endpoint);
    const secrets = ["cookie-secret-1", "key-secret-2", "bearer-secret-3", "resp-secret-4", "First post"];
    const leaked = secrets.filter((s) => stored.includes(s));
    if (leaked.length) throw new Error(`values in the map: ${leaked.join(", ")}`);

    await openSettingsAt("api-map");
    await page!.waitFor(`!!document.querySelector('[data-api-host="${host}"]')`, { label: "host in the list" });
    await click(`[data-api-host="${host}"] button`);
    await page!.waitFor(`!!document.querySelector('[data-api-host="${host}"] [data-endpoint="GET /api/feed"]')`, {
      label: "endpoint",
    });
    await click(`[data-api-host="${host}"] [data-endpoint="GET /api/feed"] button`);
    const detail = await page!.waitFor<string>(
      `document.querySelector('[data-api-host="${host}"] [data-endpoint-detail]')?.innerText`,
      { label: "endpoint detail" },
    );
    for (const expected of ["page", "integer", "api_key", "credential", "title", "Response 200"])
      if (!detail.includes(expected)) throw new Error(`"${expected}" missing from: ${detail}`);
    const shown = secrets.filter((s) => detail.includes(s));
    if (shown.length) throw new Error(`values shown: ${shown.join(", ")}`);
    await shot("api-map.png");

    await click(`[data-api-host="${host}"] [data-api-host-delete]`);
    await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm" });
    await click("[data-confirm-dialog] button", "Delete");
    await page!.waitFor(`!document.querySelector('[data-api-host="${host}"]')`, { label: "deleted" });
    return `GET /api/feed with ${Object.keys(endpoint.query).join(", ")}`;
  });

  if (agentPrompt && webTabId) {
    await check("website agent customizes a picked element", async () => {
      const tab = `[data-web-tab="${webTabId}"]`;
      const inPage = <T>(code: string) =>
        page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
      await click(`nav li[data-app-id="${webTabId}"]`);
      await startPicking(webTabId!);
      await waitForValue(async () => ((await inPage<boolean>(`!!window.__runePicker`)) ? true : undefined));
      await inPage(`document.querySelector("#headline").click(), true`);
      await page!.waitFor(`!!document.querySelector('${agentOf(webTabId!)} [data-picked-chip]')`, {
        label: "picked heading",
      });
      await chooseAgent(agentOf(webTabId!), "claude", "haiku", "Low");
      await sendPrompt(agentOf(webTabId!), "Make this heading green (#16a34a) and give it a dashed border underneath.");
      const chat = await agentDone(agentOf(webTabId!));
      const color = await waitForValue(async () => {
        const c = await inPage<string>(`getComputedStyle(document.querySelector("#headline")).color`);
        return c === "rgb(22, 163, 74)" ? c : undefined;
      }, 15_000).catch(() => undefined);
      await shot("web-agent.png");
      if (!color) throw new Error(`heading isn't green:\n${chat.slice(-800)}`);
      const saved = await apiCall<{ css: string; js: string } | null>("/api/sites/127.0.0.1");
      if (!saved?.css.includes("16a34a")) throw new Error("customization wasn't saved");
      const reply = await page!.eval<string>(
        `[...document.querySelectorAll('${agentOf(webTabId!)} .rune-markdown')].at(-1)?.innerText ?? ""`,
      );
      return reply.slice(0, 140);
    });
  }

  if (agentPrompt && webTabId) {
    await check("website agent saves a screenshot in the chat's folder; its card opens it in a tab", async () => {
      await click(`nav li[data-app-id="${webTabId}"]`);
      const panel = agentOf(webTabId!);
      await page!.waitFor(`!!document.querySelector('${panel} textarea')`, { label: "composer" });
      await chooseAgent(panel, "claude", "haiku", "Low");
      await sendPrompt(
        panel,
        "Take a screenshot of the page with save_as set to screenshots/page.jpg (don't look at it), then call show_files with that path. Reply with one short sentence.",
      );
      const chat = await agentDone(panel);
      const card = `${panel} [data-shown-files] [data-file-card], ${panel} [data-file-card]`;
      await page!.waitFor(`!!document.querySelector(${JSON.stringify(card)})`, {
        label: `a file card in the chat:\n${chat.slice(-600)}`,
        timeoutMs: 15_000,
      });
      await page!.waitFor(
        `[...document.querySelectorAll(${JSON.stringify(`${card.split(", ")[1]} img`)})].some((i) => i.naturalWidth > 0)`,
        { label: "its thumbnail" },
      );
      await shot("chat-files.png");
      type Tab = { id: string; url: string | null };
      const before = new Set((await apiCall<Tab[]>("/api/apps")).map((t) => t.id));
      await click(card.split(", ")[1]!);
      const tab = await waitForValue(async () => {
        const fresh = (await apiCall<Tab[]>("/api/apps")).find((t) => !before.has(t.id));
        return fresh?.url?.endsWith(".jpg") ? fresh : undefined;
      }, 15_000);
      await page!.waitFor(`document.querySelector('[data-web-tab="${tab.id}"] webview')?.getURL?.().endsWith(".jpg")`, {
        label: "the screenshot open in a tab",
        timeoutMs: 15_000,
      });
      await shot("chat-file-tab.png");
      await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
      return tab.url!.split("/").slice(-2).join("/");
    });
  }

  await check("extensions: imported from Chrome with their settings, toolbar, popup, shortcut, blocking", async () => {
    const id = fixture.extensionId;
    // Import from the (fake) browser profile, settings included.
    await openSettingsAt("extensions");
    await page!.waitFor(`!!document.querySelector('[data-section="extensions"] [data-extensions-import]')`, {
      label: "extensions settings",
    });
    await click('[data-section="extensions"] [data-extensions-import]');
    await page!.waitFor(`!!document.querySelector('[data-extension-import] [data-import-candidate="${id}"]')`, {
      label: "the extension offered",
      timeoutMs: 15_000,
    });
    const offered = await page!.eval<number>(
      `document.querySelectorAll("[data-extension-import] [data-import-candidate]").length`,
    );
    if (offered !== 1)
      throw new Error(`expected only the fixture to be offered (no browser components), got ${offered}`);
    const checked = await page!.eval<boolean>(
      `document.querySelector('[data-import-candidate="${id}"] input').checked && document.querySelector("[data-import-settings]").checked`,
    );
    if (!checked) throw new Error("the extension (with its settings) should be picked by default");
    await shot("extensions-import.png");
    await click("[data-import-run]");
    await page!.waitFor(`document.querySelector("[data-import-result]")?.innerText.includes("Imported")`, {
      label: "import result",
      timeoutMs: 20_000,
    });
    await click("[data-extension-import] button", "Done");
    await page!.waitFor(`!!document.querySelector('[data-extension="${id}"]')`, { label: "extension listed" });
    const row = await page!.eval<string>(`document.querySelector('[data-extension="${id}"]').innerText`);
    if (!row.includes(fixture.name) || !row.includes("Chromium (Work)")) throw new Error(`settings row: ${row}`);
    await page!.eval(`document.querySelector('[data-section="extensions"]').scrollIntoView({ block: "start" }), true`);
    await shot("extensions-settings.png");
    // Its details: what it asks for, like Chrome's, and the shortcut changed in the browser.
    await click(`[data-extension="${id}"] [data-extension-details]`);
    await page!.waitFor(`!!document.querySelector('[data-extension-details-page="${id}"]')`, { label: "details" });
    const details = await page!.eval<string>(
      `document.querySelector('[data-extension-details-page="${id}"]').innerText`,
    );
    if (
      !details.includes("Permissions") ||
      !details.includes("Site access") ||
      !details.includes(id) ||
      !/Bump\s*Alt\+Shift\+U/.test(details)
    )
      throw new Error(`details: ${details.slice(0, 400)}`);
    await shot("extension-details.png");
    // Every permission can be blocked; a limited one says what's different.
    const permission = (name: string) => `[data-extension-details-page="${id}"] [data-extension-permission="${name}"]`;
    const note = await page!.eval<string>(
      `document.querySelector('${permission("history")} [data-permission-limited]')?.textContent ?? ""`,
    );
    if (!note.includes("history")) throw new Error(`history permission note: ${note}`);
    const allowed = (name: string) =>
      `window.rune.extensions.list().then((r) => r.extensions.find((e) => e.id === "${id}").permissions.find((p) => p.name === "${name}").allowed)`;
    await click(`${permission("history")} [role="switch"]`);
    await page!.waitFor(`${allowed("history")}.then((a) => a === false)`, { label: "history blocked" });
    await page!.waitFor(
      `document.querySelector('${permission("history")} [role="switch"]').getAttribute("aria-checked") === "false"`,
      { label: "switch off" },
    );
    await click(`${permission("history")} [role="switch"]`);
    await page!.waitFor(`${allowed("history")}.then((a) => a === true)`, { label: "history allowed again" });
    await click(`[data-extension-details-page="${id}"] button`, "All extensions");
    await page!.waitFor(`!!document.querySelector('[data-extension="${id}"]')`, { label: "back to the list" });

    // A web tab: the content script ran with the data from Chrome, and its menu (pinned first) shows the badge.
    const tabsBefore = await page!.eval<string[]>(
      `[...document.querySelectorAll("nav li")].map((li) => li.dataset.appId)`,
    );
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `(() => { const id = document.querySelector('nav li[aria-current="page"]')?.dataset.appId; return id && !${JSON.stringify(tabsBefore)}.includes(id) ? id : null; })()`,
      { label: "new web tab" },
    );
    const tab = `[data-web-tab="${tabId}"]`;
    await page!.waitFor(`!!document.querySelector('${chromeFor(tab)} [data-address]')`, { label: "address bar" });
    await page!.eval(`(() => {
      const input = document.querySelector('${chromeFor(tab)} [data-address]');
      input.value = "${site.url.origin}/";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.form.requestSubmit();
      return true;
    })()`);
    const inPage = <T>(code: string) => inView<T>(tab, code);
    const marks = await waitForValue(async () => {
      const m = await inPage<string>(
        `document.documentElement.dataset.crx + "|" + document.documentElement.dataset.greeting`,
      );
      return m?.startsWith("ok|") && !m.endsWith("undefined") ? m : undefined;
    }, 20_000);
    if (marks !== "ok|hello from chrome") throw new Error(`content script: ${marks}`);
    // One puzzle button in the top row, no separate pinned buttons.
    const topRow = await page!.eval<{ order: string[]; separate: number }>(`(() => {
      const nav = document.querySelector('${chromeFor(tab)} [data-nav-row]');
      const pick = (el) => el.matches("[data-window-controls]") ? "close" : el.matches("[data-agent-show], [title*='agent']") ? "agent" : el.matches("[data-extensions-menu]") ? "extensions" : el.matches("[data-back]") ? "back" : el.matches("[data-forward]") ? "forward" : el.matches("[data-reload]") ? "reload" : null;
      return { order: [...nav.querySelectorAll("button")].map(pick).filter(Boolean), separate: nav.querySelectorAll("[data-extension-action]").length };
    })()`);
    // macOS has its own traffic lights instead of the close button.
    const expectedRow = `${process.platform === "darwin" ? "" : "close,"}agent,extensions,back,forward,reload`;
    if (topRow.order.join() !== expectedRow || topRow.separate) throw new Error(`top row: ${JSON.stringify(topRow)}`);
    await click(`${chromeFor(tab)} [data-extensions-menu]`);
    const badge = await page!.waitFor<string>(
      `document.querySelector('[data-extensions-list] [data-extension-item="${id}"] [data-extension-badge]')?.textContent`,
      { label: "badge", timeoutMs: 15_000 },
    );
    if (badge !== "7") throw new Error(`badge: ${badge}`);
    const first = await page!.eval<string>(
      `document.querySelector("[data-extensions-list] [data-extension-item]")?.dataset.extensionItem`,
    );
    if (first !== id) throw new Error(`the pinned extension isn't first in the menu: ${first}`);
    await shot("extensions-menu.png");
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-extensions-list]")`, { label: "menu closed" });

    // Its declarativeNetRequest rules block (and Rune Browser's own rules, checked above, still work alongside).
    const before = siteSeen.length;
    const blocked = await inPage<string>(`fetch("/blocked-by-extension").then(() => "loaded", () => "blocked")`);
    if (blocked !== "blocked") throw new Error("the extension's rule didn't block the request");

    // The popup sees the tab it was opened on.
    await click(`${chromeFor(tab)} [data-extensions-menu]`);
    await page!.waitFor(`!!document.querySelector('[data-extension-item="${id}"]')`, { label: "menu" });
    await click(`[data-extension-item="${id}"]`);
    await page!.waitFor(`!!document.querySelector('[data-extension-popup="${id}"] webview')`, { label: "popup" });
    const popupUrl = await waitForValue(async () => {
      const text = await page!.eval<string>(
        `document.querySelector('[data-extension-popup="${id}"] webview').executeJavaScript('document.getElementById("url")?.textContent')`,
      );
      return text && text !== "…" ? text : undefined;
    }, 15_000);
    if (popupUrl !== `${site.url.origin}/`) throw new Error(`popup's active tab: ${popupUrl}`);
    await Bun.sleep(300);
    await shot("extensions-popup.png");
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-extension-popup]")`, { label: "popup closed" });

    // The shortcut changed in Chrome (Alt+Shift+U) reaches the extension, with the tab.
    for (const type of ["rawKeyDown", "keyUp"]) {
      await page!.send("Input.dispatchKeyEvent", {
        type,
        modifiers: 1 | 8,
        key: "U",
        code: "KeyU",
        windowsVirtualKeyCode: 85,
        nativeVirtualKeyCode: 85,
      });
    }

    // Its options page opens as a web tab; there, its storage tells what it got.
    await openSettingsAt("extensions");
    await page!.waitFor(`!!document.querySelector('[data-extension="${id}"] [data-extension-options]')`, {
      label: "options button",
    });
    await click(`[data-extension="${id}"] [data-extension-options]`);
    const optionsTab = await page!.waitFor<string>(
      `[...document.querySelectorAll("nav li")].find((li) => li.innerText.includes("Fixture options") && li.getAttribute("aria-current") === "page")?.dataset.appId`,
      { label: "options tab", timeoutMs: 15_000 },
    );
    const stored = await waitForValue(async () => {
      const value = await inView<{
        installed?: { reason: string };
        command?: string;
        tabUrl?: string;
        fromWorker?: number;
      }>(
        `[data-web-tab="${optionsTab}"]`,
        `Promise.all([chrome.storage.local.get(null), chrome.storage.sync.get(null)]).then(([l, s]) => ({ ...l, ...s }))`,
      );
      return value?.command ? value : undefined;
    }, 15_000);
    // Imported with its data, it was updated rather than installed (no first-run pages).
    if (stored.installed?.reason !== "update")
      throw new Error(`runtime.onInstalled: ${JSON.stringify(stored.installed)}`);
    if (stored.command !== "bump" || stored.tabUrl !== `${site.url.origin}/`)
      throw new Error(`command: ${JSON.stringify(stored)}`);
    if (stored.fromWorker !== 1) throw new Error("storage.sync didn't keep the value");
    if (siteSeen.length !== before) throw new Error("a blocked request reached the site");

    // A site's sign-in: the extension fills it in (webRequest.onAuthRequired), else Rune Browser's dialog asks.
    const titleOf = () => inPage<string>("document.title");
    await page!.eval(
      `document.querySelector('${tab} webview').loadURL("${site.url.origin}/auth/extension").catch(() => {}), true`,
    );
    const byExtension = await waitForValue(
      async () => ((await titleOf())?.startsWith("Signed in") ? titleOf() : undefined),
      15_000,
    );
    if (byExtension !== "Signed in as fixture") throw new Error(`sign-in by the extension: ${byExtension}`);
    await page!.eval(
      `document.querySelector('${tab} webview').loadURL("${site.url.origin}/auth/you").catch(() => {}), true`,
    );
    await page!.waitFor(`!!document.querySelector("[data-auth-dialog]")`, {
      label: "sign-in dialog",
      timeoutMs: 15_000,
    });
    await shot("auth-dialog.png");
    await type("[data-auth-username]", "you");
    await type("[data-auth-password]", "typed");
    await click("[data-auth-submit]");
    const byYou = await waitForValue(
      async () => ((await titleOf())?.startsWith("Signed in") ? titleOf() : undefined),
      15_000,
    );
    if (byYou !== "Signed in as you") throw new Error(`sign-in in the dialog: ${byYou}`);
    return `content script with Chrome's data, badge ${badge}, popup on ${popupUrl}, shortcut → ${stored.command}, onInstalled: ${stored.installed.reason}, sign-ins by the extension and the dialog`;
  });

  await check(
    "workspaces: icons at the bottom, own tabs and web logins, switching keeps state, reorder, move tabs, shortcuts",
    async () => {
      const tabIds = () =>
        page!.eval<string[]>(`[...document.querySelectorAll("nav li")].map((li) => li.dataset.appId)`);
      const selected = () =>
        page!.eval<string | undefined>(`document.querySelector('nav li[aria-current="page"]')?.dataset.appId`);
      const header = () => page!.eval<string>(currentWorkspaceName);
      const order = () =>
        page!.eval<string[]>(
          `[...document.querySelectorAll("[data-workspace-bar] [data-workspace]")].map((b) => b.dataset.workspace)`,
        );
      const menuOn = async (id: string, label: string) => {
        await page!.eval(`(() => {
        const b = document.querySelector('[data-workspace="${id}"]');
        const r = b.getBoundingClientRect();
        b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 10, clientY: r.top }));
        return true;
      })()`);
        await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "workspace menu" });
        await click("[data-context-menu] button", label);
      };
      const personal = (await apiCall<{ id: string }[]>("/api/workspaces"))[0]!.id;
      const personalTabs = await tabIds();
      const personalSelected = await selected();

      // "+" at the bottom makes one, and its name is typed in the header.
      await click("[data-new-workspace]");
      await page!.waitFor(`!!document.querySelector("[data-workspace-name]")`, { label: "workspace name field" });
      await page!.eval(`(() => {
      const input = document.querySelector("[data-workspace-name]");
      input.value = "Client";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    })()`);
      await page!.waitFor(`${currentWorkspaceName} === "Client"`, { label: "renamed workspace" });
      if ((await tabIds()).length) throw new Error("a new workspace should have no tabs");
      const client = (await apiCall<{ id: string; name: string }[]>("/api/workspaces")).find(
        (w) => w.name === "Client",
      )!;
      if ((await order()).join() !== [personal, client.id].join()) throw new Error(`bar: ${(await order()).join()}`);

      // A web tab here gets its own session: cookies set in Personal's web tab aren't there.
      const tab = await apiCall<{ id: string }>("/api/apps", {
        method: "POST",
        body: { kind: "web", url: `${site.url.origin}/`, workspaceId: client.id },
      });
      await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${tab.id}"]')`, {
        label: "tab in the sidebar",
      });
      await click(`nav li[data-app-id="${tab.id}"]`);
      const view = `[data-web-tab="${tab.id}"] webview`;
      await page!.waitFor(
        `document.querySelector('${view}')?.getAttribute("partition") === "persist:web-${client.id}"`,
        { label: "workspace session" },
      );
      await waitForValue(
        async () =>
          (await inView<string>(`[data-web-tab="${tab.id}"]`, `document.querySelector("h1")?.textContent`))
            ? true
            : undefined,
        20_000,
      );
      if (webTabId) await inView(`[data-web-tab="${webTabId}"]`, `document.cookie = "space=personal; path=/"`);
      const clientCookies = await inView<string>(`[data-web-tab="${tab.id}"]`, `document.cookie`);
      if (clientCookies.includes("space=personal")) throw new Error("the Client workspace sees Personal's cookies");

      // An icon in the bar, and Ctrl+Alt+1 / 2.
      await menuOn(client.id, "Change icon…");
      await page!.waitFor(`!!document.querySelector('[data-icon-picker] [data-icon="briefcase"]')`, {
        label: "icon picker",
      });
      await click('[data-icon-picker] [data-icon="briefcase"]');
      await waitForValue(async () =>
        (await apiCall<{ id: string; icon: string | null }[]>("/api/workspaces")).find((w) => w.id === client.id)
          ?.icon === "briefcase"
          ? true
          : undefined,
      );
      await shot("workspaces.png");
      await page!.eval(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", code: "Digit1", ${mod}: true, altKey: true, bubbles: true })), true`,
      );
      await page!.waitFor(`${currentWorkspaceName} === "Personal"`, { label: "Ctrl+Alt+1" });
      const back = await tabIds();
      if (back.join() !== personalTabs.join())
        throw new Error(`Personal's tabs changed: ${back.join()} vs ${personalTabs.join()}`);
      await waitForValue(async () => ((await selected()) === personalSelected ? true : undefined), 5_000).catch(
        () => {},
      );
      if ((await selected()) !== personalSelected) throw new Error("the tab selected in Personal wasn't restored");
      await page!.eval(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", code: "Digit2", ${mod}: true, altKey: true, bubbles: true })), true`,
      );
      await page!.waitFor(`${currentWorkspaceName} === "Client"`, { label: "Ctrl+Alt+2" });
      await click(`[data-workspace="${personal}"]`);
      await page!.waitFor(`${currentWorkspaceName} === "Personal"`, { label: "clicked Personal" });

      // Reordered from its menu (saved); a tab dropped on a workspace moves there.
      await menuOn(client.id, "Move left");
      await page!.waitFor(
        `[...document.querySelectorAll("[data-workspace-bar] [data-workspace]")][0]?.dataset.workspace === "${client.id}"`,
        { label: "reordered" },
      );
      // The bar reorders right away; the server has it a moment later.
      await waitForValue(async () =>
        (await apiCall<{ id: string }[]>("/api/workspaces"))[0]!.id === client.id ? true : undefined,
      ).catch(() => {
        throw new Error("the order wasn't saved");
      });
      const moving = personalTabs.at(-1)!;
      await page!.eval(`(() => {
      const from = document.querySelector('nav li[data-app-id="${moving}"]');
      const to = document.querySelector('[data-workspace="${client.id}"]');
      const dataTransfer = new DataTransfer();
      const at = { bubbles: true, cancelable: true, dataTransfer };
      from.dispatchEvent(new DragEvent("dragstart", at));
      to.dispatchEvent(new DragEvent("dragover", at));
      to.dispatchEvent(new DragEvent("drop", at));
      from.dispatchEvent(new DragEvent("dragend", at));
      return true;
    })()`);
      await waitForValue(async () =>
        (await apiCall<{ id: string; workspaceId: string }[]>("/api/apps")).find((t) => t.id === moving)
          ?.workspaceId === client.id
          ? true
          : undefined,
      );
      await apiCall(`/api/apps/${moving}/move`, { method: "POST", body: { workspaceId: personal } });
      await menuOn(client.id, "Move right");
      await page!.waitFor(
        `[...document.querySelectorAll("[data-workspace-bar] [data-workspace]")][0]?.dataset.workspace === "${personal}"`,
        { label: "order back" },
      );

      // Deleted from its menu, with its tabs.
      await menuOn(client.id, "Delete workspace");
      await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
      await click("[data-confirm-dialog] [data-confirm]");
      await page!.waitFor(`!document.querySelector('[data-workspace="${client.id}"]')`, { label: "deleted" });
      if ((await apiCall<unknown[]>("/api/workspaces")).length !== 1) throw new Error("the workspace wasn't deleted");
      return `separate cookies; icon, shortcuts, reorder, moved a tab by dropping it; ${await header()} restored`;
    },
  );

  await check("command bar: finds tabs and commands, runs app actions, routes free text", async () => {
    const bar = "[data-command-bar]";
    const openBar = async () => {
      await page!.eval(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ${mod}: true, bubbles: true })), true`,
      );
      await page!.waitFor(`!!document.querySelector("${bar} input")`, { label: "command bar" });
    };
    const key = (k: string) =>
      page!.eval(
        `document.querySelector("${bar} input").dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true })), true`,
      );
    /** Types into the bar; resolves with the first result's id. */
    const search = async (text: string, expected: string) => {
      await type(`${bar} input`, text);
      await page!.waitFor(
        `document.querySelector("${bar} [data-index='0']")?.dataset.command === ${JSON.stringify(expected)}`,
        {
          label: `"${text}" → ${expected}`,
          timeoutMs: 5_000,
        },
      );
    };
    const selected = () =>
      page!.eval<string | undefined>(`document.querySelector('nav li[aria-current="page"]')?.dataset.appId`);

    // An app declares an action that opens one of its pages.
    const manifestFile = join(profile, "data", "apps", appId, "rune.json");
    const manifest = JSON.parse(await Bun.file(manifestFile).text());
    await Bun.write(
      manifestFile,
      JSON.stringify({
        ...manifest,
        actions: [{ id: "second", title: "Open the second page", path: "/?from=command-bar" }],
      }),
    );

    await openBar();
    await search("open settings", "open.settings");
    await key("Enter");
    await page!.waitFor(`!!document.querySelector("[data-settings]")`, { label: "settings page" });

    const name = (await apiCall<{ id: string; name: string }[]>("/api/apps")).find((a) => a.id === appId)!.name;
    await openBar();
    await search(name, `tab:${appId}`);
    await key("Enter");
    await page!.waitFor(`document.querySelector('nav li[aria-current="page"]')?.dataset.appId === "${appId}"`, {
      label: "the app selected",
    });

    await openBar();
    await search("open the second", `action:${appId}:second`);
    await key("Enter");
    await waitForValue(
      async () => ((await inView<string>(appTab(), "location.search")) === "?from=command-bar" ? true : undefined),
      30_000,
    );

    await openBar();
    await search("save a snap", "app.snapshot");
    await key("Enter");
    await page!.waitFor(`!!document.querySelector("[data-toast]")?.innerText.match(/snapshot/i)`, { label: "toast" });

    // Commands that ask for text first.
    await openBar();
    await search("rename tab", "tab.rename");
    await key("Enter");
    await page!.waitFor(`!!document.querySelector("${bar} [data-command-asking]")`, { label: "asks for the name" });
    await type(`${bar} input`, "Renamed from the bar");
    await key("Enter");
    await page!.waitFor(
      `document.querySelector('nav li[data-app-id="${appId}"]')?.innerText.includes("Renamed from the bar")`,
      { label: "renamed" },
    );
    await apiCall(`/api/apps/${appId}`, { method: "PATCH", body: { name } });

    // Free text: a URL opens, a sentence goes to the agent.
    await openBar();
    await search("example.com/docs", "route.open");
    await search("add a dark mode toggle to the header", "route.ask");
    await Bun.sleep(200); // the fade-in
    await shot("command-bar.png");
    await key("Escape");
    await page!.waitFor(`!document.querySelector("${bar}")`, { label: "closed" });
    if ((await selected()) !== appId) throw new Error("the selected tab changed");
    return `opened ${name} and its page, saved a snapshot, renamed it`;
  });

  await check(
    "full access: switched on in Settings after a warning, shown in the agent sidebar, switched off there",
    async () => {
      await openSettingsAt("agent");
      await page!.waitFor(`!!document.querySelector("[data-permission-mode]")`, { label: "permissions setting" });
      await click("[data-permission-mode] button", "Full access");
      await page!.waitFor(`document.querySelector("[data-confirm-dialog]")?.innerText.includes("A web page can try")`, {
        label: "warning",
      });
      await shot("full-access-warning.png");
      await click("[data-confirm-dialog] [data-confirm]");
      await waitForValue(async () =>
        (await apiCall<{ agent: { permissions: string } }>("/api/settings")).agent.permissions === "full"
          ? true
          : undefined,
      );
      await click(`nav li[data-app-id="${appId}"]`);
      const panel = `[data-agent-for="${appId}"]`;
      if (!(await page!.eval<boolean>(`!!document.querySelector('${panel}')`)))
        await click(`[data-tab-chrome="${appId}"] [data-agent-show]`);
      await page!.waitFor(`!!document.querySelector('${panel} [data-full-access]')`, { label: "full access badge" });
      await click(`${panel} [data-full-access]`);
      await page!.waitFor(`!document.querySelector("[data-full-access]")`, { label: "badge gone" });
      await waitForValue(async () =>
        (await apiCall<{ agent: { permissions: string } }>("/api/settings")).agent.permissions === "ask"
          ? true
          : undefined,
      );
      return "on with a warning, badge shown, back to asking";
    },
  );

  await check("settings: categories in a sidebar, theme presets apply and prompt additions are saved", async () => {
    await openSettingsAt("appearance");
    await page!.waitFor(`!!document.querySelector("[data-settings] [data-preset]")`, { label: "settings page" });
    // Its sidebar lists the categories and Rune Browser's pages; only the chosen one is shown.
    const nav = await page!.eval<string[]>(
      `[...document.querySelectorAll("[data-settings-nav]")].map((b) => b.dataset.settingsNav)`,
    );
    for (const id of [
      "appearance",
      "workspace",
      "agent",
      "providers",
      "apps",
      "secrets",
      "permissions",
      "history",
      "schedules",
      "mods",
      "activity",
    ]) {
      if (!nav.includes(id)) throw new Error(`settings sidebar: ${nav.join(", ")}`);
    }
    if (await page!.eval<boolean>(`!!document.querySelector("[data-provider-row]")`))
      throw new Error("another category is shown too");
    const pageBg = () =>
      page!.eval<string>(`getComputedStyle(document.querySelector("[data-content]")).backgroundColor`);
    await click("[data-preset]", "Midnight");
    await page!.waitFor(
      `getComputedStyle(document.querySelector("[data-content]")).backgroundColor === "rgb(11, 16, 32)"`,
      {
        label: "Midnight background",
      },
    );
    await Bun.sleep(300); // let color transitions finish
    await shot("settings.png");
    await openSettingsAt("agent");
    await page!.eval(`(() => {
      const t = document.querySelector('textarea[name="instructions"]');
      t.value = "Amounts are in EUR.";
      t.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })()`);
    await waitForValue(async () => {
      const s = await apiCall<{ agent: { instructions: string }; theme: { background?: string } }>("/api/settings");
      return s.agent.instructions === "Amounts are in EUR." && s.theme.background === "#0b1020" ? true : undefined;
    });
    await openSettingsAt("providers");
    const rows = await page!.eval<string[]>(
      `[...document.querySelectorAll("[data-provider-row]")].map((r) => r.dataset.providerRow + ":" + r.querySelector("[data-provider-state]")?.dataset.providerState)`,
    );
    if (rows.length !== 3) throw new Error(`provider rows: ${rows.join(", ")}`);
    await shot("settings-providers.png");
    await openSettingsAt("apps");
    await page!.waitFor(
      `!!document.querySelector("[data-app-ai-agent] [data-agent-picker]") && !!document.querySelector("[data-ai-limit]")`,
      { label: "AI in apps settings" },
    );
    // The shell commands run in, from the ones found here.
    const shells = await page!.waitFor<string[]>(
      `(() => { const o = [...document.querySelectorAll("[data-shell] option")].map((o) => o.value); return o.length > 2 ? o : null; })()`,
      { label: "shells" },
    );
    if (!shells.includes("auto") || !shells.includes("bun")) throw new Error(`shells: ${shells.join(", ")}`);
    await shot("settings-apps.png");
    await page!.eval(`document.querySelector("[data-app-ai-agent]").scrollIntoView({ block: "center" }), true`);
    await shot("settings-ai.png");
    await openSettingsAt("secrets");
    await click("[data-add-global-secret]");
    await page!.waitFor(`!!document.querySelector("[data-global-secret-warning]")`, { label: "global secret warning" });
    await shot("settings-secrets.png");
    await openSettingsAt("appearance");
    await click("[data-preset]", "Default");
    await page!.waitFor(
      `getComputedStyle(document.querySelector("#root > div")).backgroundColor !== "rgb(11, 16, 32)"`,
    );
    return `${nav.length} categories; ${rows.join(", ")}; shells ${shells.join(", ")}; background ${await pageBg()} after reset`;
  });

  await check(
    "updates: About shows the version, that runs from source don't update, and the channel is remembered",
    async () => {
      await openSettingsAt("about");
      const version = (await Bun.file("package.json").json()).version as string;
      await page!.waitFor(
        `document.querySelector('[data-section="updates"]')?.innerText.includes("Rune Browser ${version}")`,
        { label: "version" },
      );
      await page!.waitFor(
        `!!document.querySelector('[data-update-state="unsupported"]') && document.querySelector('[data-section="updates"]').innerText.includes("installed builds")`,
        {
          label: "not updating from source",
        },
      );
      await click('[data-section="updates"] [role="radio"]', "Daily");
      await page!.waitFor(
        `document.querySelector('[data-section="updates"] [role="radio"][aria-checked="true"]')?.innerText === "Daily"`,
        { label: "daily selected" },
      );
      const stored = await page!.eval<{ channel: string }>(`window.rune.updates.get()`);
      if (stored.channel !== "daily") throw new Error(`channel: ${stored.channel}`);
      await shot("settings-about.png");
      await click('[data-section="updates"] [role="radio"]', "Stable");
      await page!.waitFor(
        `document.querySelector('[data-section="updates"] [role="radio"][aria-checked="true"]')?.innerText === "Stable"`,
        { label: "stable again" },
      );
      return `${version}, daily remembered`;
    },
  );

  await check(
    "devtools: console, metrics, traces, accessibility, styles, storage, coverage and emulation for agents",
    async () => {
      await page!.waitFor(`!!${currentWorkspaceName}`, { label: "workspace loaded" });
      const tab = await apiCall<{ id: string }>("/api/apps", {
        method: "POST",
        body: { kind: "web", url: `${site.url.origin}/devtools` },
      });
      await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${tab.id}"]')`, {
        label: "web tab in the sidebar",
      });
      await click(`nav li[data-app-id="${tab.id}"]`);
      const rpcOn = <T>(tabId: string, method: string, params: object = {}) =>
        page!.eval<T>(`window.__runeRpc(${JSON.stringify(method)}, ${JSON.stringify({ tabId, ...params })})`);
      const dt = <T>(command: string, params: object = {}) => rpcOn<T>(tab.id, "devtools", { command, params });
      await page!.waitFor(
        `document.querySelector('nav li[data-app-id="${tab.id}"]')?.innerText.includes("DevTools page")`,
        { timeoutMs: 20_000, label: "devtools page" },
      );

      // A website's console is captured once an agent asks; a reload shows what the page does.
      type Console = { startedNow: boolean; entries: { level: string; text: string }[] };
      const first = await dt<Console>("console");
      if (!first.startedNow) throw new Error("the web tab's console was captured before an agent asked");
      await rpcOn(tab.id, "page.reload");
      const logged = await waitForValue(async () => {
        const c = await dt<Console>("console");
        return c.entries.some((e) => e.level === "exception") ? c : undefined;
      }, 15_000);
      const text = logged.entries.map((e) => `${e.level}: ${e.text}`).join("\n");
      for (const expected of [
        "log: hello from devtools {answer: 42}",
        "warn: careful with",
        "exception: Error: boom from the page",
      ]) {
        if (!text.includes(expected)) throw new Error(`console: ${text}`);
      }
      if (text.includes("c2lnbmF0dXJlLXNlY3JldA")) throw new Error("a token reached the console log");

      // (Offscreen rendering reports no first paint, but the largest one; on macOS neither.)
      const metrics = await dt<{ lcp: number | null; load: number | null; runtime: Record<string, unknown> }>(
        "metrics",
      );
      if (
        (typeof metrics.lcp !== "number" && process.platform !== "darwin") ||
        typeof metrics.load !== "number" ||
        !metrics.runtime.Nodes
      )
        throw new Error(`metrics: ${JSON.stringify(metrics)}`);

      // A trace of an interaction finds the slow function behind it, and is saved for Chrome DevTools.
      type Trace = {
        analysis: {
          hotFunctions: { name: string; selfMs: number }[];
          longTasks: unknown[];
          vitals: Record<string, number | null>;
        };
        file: string;
        events: number;
      };
      const traced = await dt<Trace>("trace", { interaction: `document.getElementById("target").click()`, seconds: 1 });
      const hot = traced.analysis.hotFunctions.find((f) => f.name === "slowWork");
      if (!hot || hot.selfMs < 40)
        throw new Error(`hot functions: ${JSON.stringify(traced.analysis.hotFunctions.slice(0, 5))}`);
      if (!existsSync(traced.file) || !JSON.parse(readFileSync(traced.file, "utf8")).traceEvents.length)
        throw new Error(`no trace file at ${traced.file}`);
      const loaded = await dt<Trace>("trace", { reload: true, seconds: 1 });
      if (typeof loaded.analysis.vitals.loadMs !== "number" || typeof loaded.analysis.vitals.lcpMs !== "number")
        throw new Error(`load trace vitals: ${JSON.stringify(loaded.analysis.vitals)}`);

      // Screenshots of one element and of the whole page, for the agent to look at.
      type Shot = { data: string; width: number; height: number };
      const element = await dt<Shot>("screenshot", { selector: "#target" });
      const whole = await dt<Shot>("screenshot", { fullPage: true });
      if (!element.data || element.width > 200 || element.height > 100 || whole.height < element.height)
        throw new Error(`screenshots: element ${element.width}×${element.height}, page ${whole.width}×${whole.height}`);
      await Bun.write(join(outDir, "devtools-element.jpg"), Buffer.from(element.data, "base64"));
      const ax = await dt<{ lines: string[] }>("accessibility");
      if (!ax.lines.some((l) => l.includes('button "Save the draft"')))
        throw new Error(`accessibility: ${ax.lines.slice(0, 10).join(" | ")}`);
      const styles = await dt<{ rules: { selector: string; props: string[] }[]; computed: Record<string, string> }>(
        "styles",
        { selector: "#target" },
      );
      if (styles.rules[0]?.selector !== "#target.box" || styles.computed.color !== "rgb(1, 2, 3)")
        throw new Error(`styles: ${JSON.stringify(styles).slice(0, 400)}`);

      // Storage: cookie values and credential-like values stay hidden on websites.
      const storage = await dt<{
        cookies: { name: string; value: string }[];
        localStorage: { key: string; value: string }[];
      }>("storage");
      const cookie = storage.cookies.find((c) => c.name === "session");
      const token = storage.localStorage.find((e) => e.key === "authToken");
      const theme = storage.localStorage.find((e) => e.key === "theme");
      if (cookie?.value !== "[redacted]" || token?.value !== "[redacted]" || theme?.value !== "dark")
        throw new Error(`storage: ${JSON.stringify(storage).slice(0, 400)}`);

      const coverage = await dt<{ files: { url: string; type: string }[] }>("coverage", { seconds: 0 });
      if (!coverage.files.some((f) => f.type === "css") || !coverage.files.some((f) => f.type === "js"))
        throw new Error(`coverage: ${JSON.stringify(coverage)}`);

      // Emulating a phone changes the page's viewport, until it's reset.
      // (The page has no viewport meta tag, so like on a real phone its layout is 980px wide: the screen is the device's.)
      const device = () =>
        page!.eval<string>(
          `document.querySelector('[data-web-tab="${tab.id}"] webview').executeJavaScript("screen.width + ' ' + matchMedia('(prefers-color-scheme: dark)').matches + ' ' + navigator.maxTouchPoints")`,
        );
      const normal = await device();
      await dt("emulate", { device: "iphone-15", colorScheme: "dark" });
      if ((await device()) !== "393 true 5") throw new Error(`emulated: ${await device()}`);
      await shot("devtools-emulate.png");
      await dt("emulate", { reset: true });
      if ((await device()) !== normal) throw new Error(`emulation wasn't reset: ${await device()} (was ${normal})`);

      // App previews: their console from the start, and their traffic.
      const app = await apiCall<{ id: string }>("/api/apps", { method: "POST", body: { kind: "app" } });
      await apiCall(`/api/apps/${app.id}/project`, { method: "POST", body: { preset: "vanilla" } });
      await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${app.id}"]')`, {
        label: "app in the sidebar",
      });
      await click(`nav li[data-app-id="${app.id}"]`);
      await page!.waitFor(`!!document.querySelector('[data-app-tab="${app.id}"][data-runtime-state="running"]')`, {
        timeoutMs: 60_000,
        label: "app running",
      });
      const appId = app.id;
      await waitForValue(
        () => rpcOn<boolean>(appId, "page.eval", { code: `(console.error("from the preview"), true)` }),
        20_000,
      );
      const preview = await rpcOn<Console>(appId, "devtools", { command: "console", params: {} });
      if (preview.startedNow || !preview.entries.some((e) => e.text.includes("from the preview")))
        throw new Error(`preview console: ${JSON.stringify(preview)}`);
      await rpcOn(appId, "page.reload");
      const traffic = await waitForValue(async () => {
        const list = await rpcOn<{ url: string }[]>(appId, "network.list", { filter: { kind: "all" } });
        return list.length ? list : undefined;
      }, 15_000);
      await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
      await apiCall(`/api/apps/${app.id}`, { method: "DELETE" });
      return `console (${logged.entries.length}), element screenshot ${element.width}×${element.height}, slowWork ${hot.selfMs} ms in a ${traced.events}-event trace, a11y, styles, storage hidden, ${coverage.files.length} coverage files, emulation; preview: console, ${traffic.length} requests`;
    },
  );

  await check("sources: code attached to a tab for its agent, shown above the composer, removed again", async () => {
    await page!.waitFor(`!!${currentWorkspaceName}`, { label: "workspace loaded" });
    const folder = join(mkdtempSync(join(tempDir, "rune-e2e-source-")), "shop-frontend");
    mkdirSync(join(folder, "src"), { recursive: true });
    writeFileSync(join(folder, "src", "cart.ts"), "export const cart = [];\n");
    const tab = await apiCall<{ id: string }>("/api/apps", {
      method: "POST",
      body: { kind: "web", url: `${site.url.origin}/` },
    });
    await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${tab.id}"]')`, { label: "tab in the sidebar" });
    await click(`nav li[data-app-id="${tab.id}"]`);
    // The agent sidebar is closed on web tabs until it's opened (Ctrl+J).
    await page!.eval(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ${mod}: true, bubbles: true })), true`,
    );
    const panel = `[data-agent-for="${tab.id}"]`;
    await page!.waitFor(`!!document.querySelector('${panel} [data-add-source]')`, { label: "add source button" });
    const source = await apiCall<{ id: string }>(`/api/apps/${tab.id}/sources`, { method: "POST", body: { folder } });
    await page!.waitFor(
      `document.querySelector('${panel} [data-source-chip="${source.id}"]')?.innerText.includes("shop-frontend")`,
      { label: "folder chip" },
    );
    // A repository is added from the button's menu; a link that isn't one says so.
    await click(`${panel} [data-add-source]`);
    await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "menu" });
    await click("[data-context-menu] button", "Add a Git repository");
    await page!.waitFor(`!!document.querySelector('${panel} [data-source-url]')`, { label: "repository form" });
    await type(`${panel} [data-source-url]`, "not a repository");
    await shot("sources.png");
    await page!.eval(`document.querySelector('${panel} [data-source-form]').requestSubmit(), true`);
    await page!.waitFor(`!!document.querySelector("[data-toast]")?.innerText.includes("isn't a link")`, {
      label: "error toast",
    });
    await click(`${panel} [data-source-chip="${source.id}"] [data-source-remove]`);
    await page!.waitFor(`!document.querySelector('${panel} [data-source-chip]')`, { label: "chip removed" });
    if ((await apiCall<unknown[]>(`/api/apps/${tab.id}/sources`)).length) throw new Error("the source wasn't removed");
    if (!existsSync(join(folder, "src", "cart.ts"))) throw new Error("removing it touched the folder");
    await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
    rmSync(dirname(folder), { recursive: true, force: true });
    return "folder chip, repository form with its error, removed (folder untouched)";
  });

  await check(
    "attachments: an image dropped on the agent's composer shows as a thumbnail, and can be removed",
    async () => {
      await page!.waitFor(`!!${currentWorkspaceName}`, { label: "workspace loaded" });
      const tab = await apiCall<{ id: string }>("/api/apps", {
        method: "POST",
        body: { kind: "web", url: `${site.url.origin}/` },
      });
      await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${tab.id}"]')`, {
        label: "tab in the sidebar",
      });
      await click(`nav li[data-app-id="${tab.id}"]`);
      await page!.eval(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ${mod}: true, bubbles: true })), true`,
      );
      const panel = `[data-agent-for="${tab.id}"]`;
      await page!.waitFor(`!!document.querySelector('${panel} [data-composer]')`, { label: "composer" });
      // A 1×1 PNG and a text file, dropped like from a file manager.
      await page!.eval(`(() => {
      const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([png], "shot.png", { type: "image/png" }));
      data.items.add(new File(["# notes"], "notes.md", { type: "text/markdown" }));
      document.querySelector('${panel} [data-composer]').dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
      return true;
    })()`);
      await page!.waitFor(`document.querySelectorAll('${panel} [data-attachment]').length === 2`, {
        label: "two attachments",
        timeoutMs: 15_000,
      });
      await page!.waitFor(`document.querySelector('${panel} [data-attachment] img')?.naturalWidth === 1`, {
        label: "thumbnail loaded",
      });
      await shot("attachments.png");
      await click(`${panel} [data-attachment] button`);
      await page!.waitFor(`document.querySelectorAll('${panel} [data-attachment]').length === 1`, {
        label: "one removed",
      });
      await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
      return "image thumbnail and a file chip; removed one";
    },
  );

  await check(
    "files: dropped on the tab list they open in tabs, on a tab in that tab; pages can't open files",
    async () => {
      await page!.waitFor(`!!${currentWorkspaceName}`, { label: "workspace loaded" });
      const dir = mkdtempSync(join(tempDir, "rune-e2e-files-"));
      const note = join(dir, "note.txt");
      const pic = join(dir, "pic.svg");
      writeFileSync(note, "Hello from a dropped file");
      writeFileSync(
        pic,
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="#6d4aff"/></svg>`,
      );
      type Tab = { id: string; url: string | null; name: string };
      const before = new Set((await apiCall<Tab[]>("/api/apps")).map((t) => t.id));
      // Files on disk (they have paths, like ones from a file manager), dragged in with DOM drag events:
      // offscreen rendering doesn't deliver native drops.
      const filesFor = async (paths: string[]) => {
        await page!.eval(`(() => {
          document.getElementById("e2e-files")?.remove();
          const input = Object.assign(document.createElement("input"), { type: "file", multiple: true, id: "e2e-files", hidden: true });
          document.body.append(input);
          return true;
        })()`);
        const { root } = await page!.send("DOM.getDocument", { depth: 0 });
        const { nodeId } = await page!.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#e2e-files" });
        await page!.send("DOM.setFileInputFiles", { nodeId, files: paths });
      };
      const drag = (type: "dragover" | "drop", selector: string) =>
        page!.eval(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          const r = el.getBoundingClientRect();
          const data = new DataTransfer();
          for (const file of document.getElementById("e2e-files").files) data.items.add(file);
          el.dispatchEvent(new DragEvent(${JSON.stringify(type)}, {
            bubbles: true, cancelable: true, dataTransfer: data,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
          }));
          return true;
        })()`);

      await filesFor([note, pic]);
      await drag("dragover", "[data-new-tab]");
      await page!.waitFor(`!!document.querySelector("[data-drop-slot]")`, { label: "a slot for the new tab" });
      await shot("drop-files.png");
      await drag("drop", "[data-new-tab]");
      const opened = await waitForValue(async () => {
        const fresh = (await apiCall<Tab[]>("/api/apps")).filter((t) => !before.has(t.id));
        return fresh.length === 2 && fresh.every((t) => t.url?.startsWith("file:///")) ? fresh : undefined;
      }, 15_000);
      const noteTab = opened.find((t) => t.url!.endsWith("note.txt"));
      if (!noteTab || !opened.some((t) => t.url!.endsWith("pic.svg"))) throw new Error("the files didn't open");
      await page!.waitFor(`!document.querySelector("[data-drop-slot]")`, { label: "slot gone" });
      const inTab = <T>(id: string, code: string) =>
        page!.eval<T>(
          `document.querySelector('[data-web-tab="${id}"] webview').executeJavaScript(${JSON.stringify(code)})`,
        );
      await click(`nav li[data-app-id="${noteTab.id}"]`);
      const text = await waitForValue(async () => {
        const t = await inTab<string>(noteTab.id, "document.body.innerText");
        return t.includes("Hello from a dropped file") ? t : undefined;
      }, 15_000);
      await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${noteTab.id}"] svg.lucide-file')`, {
        label: "file icon for the tab",
      });
      await page!.waitFor(
        `document.querySelector('nav li[data-app-id="${noteTab.id}"]')?.innerText.trim() === "note.txt"`,
        {
          label: "the tab named after the file",
        },
      );
      await shot("file-tab.png");

      // A page can't take itself (or an agent's script) to another local file.
      await inTab(noteTab.id, `location.href = ${JSON.stringify(fileUrl(pic))}; true`);
      await Bun.sleep(800);
      const still = await inTab<string>(noteTab.id, "location.href");
      if (!still.endsWith("note.txt")) throw new Error(`the page navigated itself to ${still}`);

      // Dropped on a web tab, it opens in that tab.
      await filesFor([pic]);
      await drag("dragover", `nav li[data-app-id="${noteTab.id}"]`);
      await page!.waitFor(
        `getComputedStyle(document.querySelector('nav li[data-app-id="${noteTab.id}"]')).boxShadow.includes("inset")`,
        { label: "the tab is highlighted" },
      );
      await shot("drop-on-tab.png");
      await drag("drop", `nav li[data-app-id="${noteTab.id}"]`);
      await waitForValue(
        async () => ((await inTab<string>(noteTab.id, "location.href")).endsWith("pic.svg") ? true : undefined),
        15_000,
      );
      await page!.eval(`document.getElementById("e2e-files")?.remove(), true`);

      // A PDF opens in Chromium's viewer (an extension frame Rune Browser's extension shim must leave alone).
      const pdf = join(dir, "doc.pdf");
      writeFileSync(pdf, minimalPdf("Hello PDF"));
      const pdfTab = await apiCall<{ id: string }>("/api/apps", {
        method: "POST",
        body: { kind: "web", url: fileUrl(pdf) },
      });
      await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${pdfTab.id}"]')`, { label: "PDF tab" });
      await click(`nav li[data-app-id="${pdfTab.id}"]`);
      type Target = { targetId: string; type: string; url: string };
      let targets: Target[] = [];
      const viewer = await waitForValue(async () => {
        targets = (await page!.send("Target.getTargets")).targetInfos;
        return targets.find((t) => t.url.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/"));
      }, 20_000).catch(() => {
        throw new Error(`no PDF viewer; targets: ${targets.map((t) => `${t.type} ${t.url.slice(0, 80)}`).join(", ")}`);
      });
      const { sessionId } = await page!.send("Target.attachToTarget", { targetId: viewer.targetId, flatten: true });
      // Its toolbar (in shadow roots) names the document once the viewer is up.
      const shown = await waitForValue(async () => {
        const res = await page!.send(
          "Runtime.evaluate",
          {
            expression: `(() => {
              const text = (root) => [...root.querySelectorAll("*")].map((el) => (el.shadowRoot ? text(el.shadowRoot) : "") + (el.children.length ? "" : el.textContent)).join(" ");
              return text(document).includes("doc.pdf");
            })()`,
            returnByValue: true,
          },
          sessionId,
        );
        return res.result?.value === true ? true : undefined;
      }, 15_000).catch(() => false);
      await shot("pdf-tab.png");
      if (!shown) throw new Error("the PDF viewer didn't show the document");
      opened.push(pdfTab as Tab);
      for (const t of opened) await apiCall(`/api/apps/${t.id}`, { method: "DELETE" });
      rmSync(dir, { recursive: true, force: true });
      return `${opened.length} tabs (${text.trim().slice(0, 30)}…), the SVG into the text file's tab, a PDF in the viewer`;
    },
  );

  await check(
    "tabs: address suggestions, pinned tiles, close buttons, reopening closed tabs and saved apps",
    async () => {
      await page!.waitFor(`!!${currentWorkspaceName}`, { label: "workspace loaded" });
      const make = (path: string) =>
        apiCall<{ id: string }>("/api/apps", {
          method: "POST",
          body: { kind: "web", url: `${site.url.origin}${path}` },
        });
      const a = await make("/");
      const b = await make("/act");
      for (const t of [a, b])
        await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${t.id}"]')`, {
          label: "tab in the sidebar",
        });
      await click(`nav li[data-app-id="${a.id}"]`);

      // Typing in the address bar suggests open tabs (by name or address); Enter takes the first suggestion.
      await page!.eval(`(() => {
      const input = document.querySelector("[data-address]");
      input.focus();
      input.value = "/act";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return true;
    })()`);
      await page!.waitFor(`!!document.querySelector('[data-suggestions] [data-suggestion="tab:${b.id}"]')`, {
        label: "tab suggested",
      });
      await shot("address-suggestions.png");
      await page!.eval(`document.querySelector("[data-address]").form.requestSubmit(), true`);
      await page!.waitFor(`document.querySelector('nav li[aria-current="page"]')?.dataset.appId === "${b.id}"`, {
        label: "switched by the suggestion",
      });

      // Pinned: a tile above the list.
      await apiCall(`/api/apps/${a.id}/pinned`, { method: "PUT", body: { pinned: true } });
      await page!.waitFor(`!!document.querySelector('[data-pinned-tiles] li[data-app-id="${a.id}"]')`, {
        label: "pinned tile",
      });
      await shot("sidebar-zen.png");
      await apiCall(`/api/apps/${a.id}/pinned`, { method: "PUT", body: { pinned: false } });

      // × closes a web tab; Ctrl+Shift+T brings it back.
      await click(`nav li[data-app-id="${b.id}"] [data-close-tab]`);
      await page!.waitFor(`!document.querySelector('nav li[data-app-id="${b.id}"]')`, { label: "closed" });
      await page!.eval(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "T", ${mod}: true, shiftKey: true, bubbles: true })), true`,
      );
      await page!.waitFor(`[...document.querySelectorAll("nav li")].some((li) => li.innerText.includes("Act page"))`, {
        timeoutMs: 20_000,
        label: "reopened",
      });

      // Closing an app keeps it: it's in the library and opens again with its project.
      const app = await apiCall<{ id: string }>("/api/apps", { method: "POST", body: { kind: "app" } });
      await apiCall(`/api/apps/${app.id}/project`, { method: "POST", body: { preset: "vanilla", name: "Saved one" } });
      await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${app.id}"]')`, {
        label: "app in the sidebar",
      });
      await click(`nav li[data-app-id="${app.id}"] [data-close-tab]`);
      await page!.waitFor(`!document.querySelector('nav li[data-app-id="${app.id}"]')`, { label: "app closed" });
      const library = await apiCall<{ id: string }[]>("/api/library");
      if (!library.some((x) => x.id === app.id)) throw new Error("the closed app isn't in the library");
      await click("[data-new-tab]");
      await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "new tab menu" });
      await page!.waitFor(
        `[...document.querySelectorAll("[data-context-menu] button")].some((b) => b.textContent.includes("Open Saved one"))`,
        { label: "saved app in the menu" },
      );
      await shot("saved-apps.png");
      await click("[data-context-menu] button", "Open Saved one");
      await page!.waitFor(`document.querySelector('nav li[aria-current="page"]')?.dataset.appId === "${app.id}"`, {
        label: "app reopened",
      });
      if ((await apiCall<{ id: string }[]>("/api/library")).some((x) => x.id === app.id))
        throw new Error("still in the library");
      for (const id of [a.id, app.id]) await apiCall(`/api/apps/${id}`, { method: "DELETE" });
      for (const t of await apiCall<{ id: string; name: string }[]>("/api/apps"))
        if (t.name === "Act page") await apiCall(`/api/apps/${t.id}`, { method: "DELETE" });
      return "suggested and switched, tile, closed and reopened a web tab, closed and reopened an app";
    },
  );

  await check("no uncaught errors in the renderer", async () => {
    // Expected noise from Electron itself isn't an app bug.
    const real = pageErrors.filter((e) => !/Electron Security Warning/.test(e));
    if (real.length) throw new Error(real.slice(0, 5).join("\n"));
  });
} finally {
  page?.close();
  site.stop(true);
  electron.kill();
  await electron.exited;
  // Windows may still hold a file of the profile for a moment after Electron exits (EBUSY).
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    console.warn(`Couldn't remove ${profile}:`, err);
  }
  rmSync(browserDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${outDir}/`);
if (skippedShots.length) console.log(`(window wasn't painting, skipped screenshots: ${skippedShots.join(", ")})`);
process.exit(failed.length ? 1 : 0);
