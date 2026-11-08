// End-to-end check of the built app: launches Electron against a throwaway
// profile and drives the real UI over the DevTools protocol.
//
//   bun run e2e                 UI checks (providers, app previews, dev/live, web tabs, settings)
//   bun run e2e --agent         also has the agents build an app and customize a site (uses your Claude plan)
//   bun run e2e --agent "..."   ...with a custom prompt
//   bun run e2e --visible       show the window while testing (default: offscreen)
//   bun run e2e --only <text>   only the checks whose name contains it ("a|b": either; and the boot check)
//   bun run e2e --retries <n>   if any check fails, run everything again (up to n times, on a fresh profile);
//                               checks that pass then are reported as flaky (CI uses 1)
//
// E2E_TIMEOUT_SCALE=2 doubles every wait, for slow machines (CI's Windows runners).
//
// Screenshots go to test-results/. Run `bun run build` first.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { launchElectron } from "./electron";
import { Page } from "./lib/cdp";
import { writeFixtureBrowser } from "./lib/fixture-browser";
import { reportFlaky } from "./lib/flaky";
import { TIMEOUT_SCALE } from "./lib/cdp";
import { base, type Mode } from "../src/shared/theme";
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
// The checks drive the vertical sidebar; horizontal tabs (what a new profile starts with) have checks of their own.
{
  mkdirSync(join(profile, "data"), { recursive: true });
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(profile, "data", "rune.sqlite"));
  db.run("CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)");
  db.run(`INSERT INTO settings (id, value) VALUES (1, '{"tabs":{"layout":"vertical"}}')`);
  db.close();
}
// A browser to import extensions from (instead of the real ones on this computer).
const browserDir = mkdtempSync(join(tempDir, "rune-e2e-browser-"));
const fixture = writeFixtureBrowser(browserDir);
// Where downloads go (instead of the real Downloads folder).
const downloadsDir = mkdtempSync(join(tempDir, "rune-e2e-downloads-"));
const onlyIndex = args.indexOf("--only");
const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1];

const port = await new Promise<number>((resolve) => {
  const srv = createServer().listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(port));
  });
});

// A site that isn't local, over plain HTTP: Chromium sends insecure.example to a server here (both its
// HTTP and HTTPS ports; the HTTPS attempt fails, since the server doesn't speak TLS).
const insecureSite = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    // From a local page (no warning) to the insecure site: the redirect is held back.
    if (url.pathname === "/hop") return Response.redirect("http://insecure.example/", 302);
    return new Response(
      `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Insecure site</title><h1>Over plain HTTP</h1>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
});
const insecureHost = `127.0.0.1:${insecureSite.port}`;

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
    RUNE_DOWNLOADS_DIR: downloadsDir,
    // The test site's name for headless tabs may resolve to it (127.0.0.1); local-name.example may not.
    RUNE_HEADLESS_TEST_HOSTS: "headless.example,other.example",
  },
  [
    ...(visible ? [] : ["--ozone-platform=headless", "--ozone-override-screen-size=1920,1080"]),
    // No OS keychain (it could ask to be unlocked): the secrets key falls back to a file.
    "--password-store=basic",
    // A fake camera and microphone for the site permission checks (no real device is touched).
    "--use-fake-device-for-media-stream",
    `--remote-debugging-port=${port}`,
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // headless.example: the test site under a name that isn't local, for headless tabs (which don't open local
    // addresses); local-name.example: a name that resolves to a local address, which they refuse.
    `--host-resolver-rules=MAP insecure.example:80 ${insecureHost}, MAP insecure.example:443 ${insecureHost}, MAP headless.example 127.0.0.1, MAP other.example 127.0.0.1, MAP local-name.example 127.0.0.1`,
  ],
);

// A small website for the web tab checks. /feed loads its data from /api/feed
// with credentials of every kind (a cookie, a key in the URL, a bearer token).
const siteSeen: { url: string; authorization: string | null; cookie: string | null; dnt: string | null }[] = [];
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
        dnt: req.headers.get("dnt"),
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
    // A site with its own service worker, whose button does what crashed Rune on Windows: a request,
    // clearing its caches, a new worker version, and a navigation (all while the worker changes state).
    if (path === "/sw.js") {
      return new Response(
        `self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open("v").then((c) => c.put("/x", new Response("x")))); });
         self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
         self.addEventListener("fetch", (e) => { if (new URL(e.request.url).pathname.startsWith("/api/")) e.respondWith(fetch(e.request)); });`,
        { headers: { "Content-Type": "text/javascript" } },
      );
    }
    // Files to download: slow.bin takes a few seconds (progress, pause), missing.bin fails.
    if (path.startsWith("/download/")) {
      const name = path.slice("/download/".length);
      const headers = {
        "Content-Disposition": `attachment; filename="${name}"`,
        "Content-Type": "application/octet-stream",
      };
      if (name === "missing.bin") return new Response("gone", { status: 404, headers });
      if (name === "slow.bin") {
        const chunk = new Uint8Array(64 * 1024).fill(7);
        let sent = 0;
        const stream = new ReadableStream({
          async pull(controller) {
            if (sent >= 40) return controller.close();
            await Bun.sleep(250);
            controller.enqueue(chunk);
            sent++;
          },
        });
        return new Response(stream, { headers: { ...headers, "Content-Length": String(40 * chunk.length) } });
      }
      return new Response(`contents of ${name}`, { headers });
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
                  : path === "/sw"
                    ? `<title>Worker page</title><h1>Worker</h1><button id="clean">Clean up</button><p id="state">registering</p>
           <script>
             navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready)
               .then(() => (document.getElementById("state").textContent = "ready"))
               .catch((e) => (document.getElementById("state").textContent = "failed: " + e.message));
             document.getElementById("clean").onclick = async () => {
               await fetch("/api/feed?page=2").catch(() => {});
               for (const key of await caches.keys()) await caches.delete(key);
               navigator.serviceWorker.register("/sw.js?v=" + Date.now()).catch(() => {});
               location.href = "/second";
             };
           </script>`
                    : path === "/perm"
                      ? `<title>Permissions page</title><h1>Permissions</h1>
           <script>
             window.events = [];
             const ended = (s, name) => s.getTracks().forEach((t) => t.addEventListener("ended", () => events.push("ended:" + (name || t.kind))));
             window.camera = () => { window.r = null; navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((s) => { window.cam = s; ended(s); window.r = "ok"; }, (e) => (window.r = e.name)); return true; };
             window.share = () => { window.r = null; navigator.mediaDevices.getDisplayMedia({ video: true }).then((s) => { window.shared = s; ended(s, "screen"); window.r = "ok"; }, (e) => (window.r = e.name)); return true; };
             window.desktop = () => { window.r = null; navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: "screen:0:0" } } }).then(() => (window.r = "ok"), (e) => (window.r = e.name)); return true; };
             window.notify = () => { window.r = null; Notification.requestPermission().then((p) => (window.r = p)); return true; };
           </script>`
                      : path === "/second"
                        ? `<title>Second page</title><h1>Second</h1>`
                        : path === "/blocked-by-extension"
                          ? `<title>Should be blocked</title>`
                          : path === "/hydrate"
                            ? // A server-rendered page as React leaves it while hydrating: the root is marked
                              // (hydrateRoot), its elements get their fiber once hydration reaches them.
                              `<title>Hydrating page</title><div id="root"><h1 id="hydrated">Server heading</h1><p id="lead">Server text</p></div>
           <script>
             const root = document.getElementById("root");
             root["__reactContainer$e2e"] = {};
             window.hydrate = () => { for (const el of root.querySelectorAll("*")) el["__reactFiber$e2e"] = {}; return true; };
           </script>`
                            : path === "/to-local"
                              ? `<title>Leaving</title><script>location.href = "http://127.0.0.1:${url.port}/second";</script>`
                              : path === "/to-other"
                                ? `<title>Leaving</title><script>setTimeout(() => (location.href = "http://other.example:${url.port}/second"), 200);</script>`
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
  const deadline = Date.now() + timeoutMs * TIMEOUT_SCALE;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(100);
  }
}

/** Opens the sidebar's "New tab" menu, picks an entry, and waits for the new tab in the sidebar. */
async function newTab(label: "New app" | "New web tab") {
  const count = await page!.eval<number>(`document.querySelectorAll("nav li[data-app-id]").length`);
  // Menus close on resize and blur, which CI's offscreen window can still send right after it starts: click again if it closed.
  const menuOpen = `!!document.querySelector("[data-context-menu]")`;
  for (let attempt = 1; ; attempt++) {
    await click("[data-new-tab]");
    try {
      await page!.waitFor(menuOpen, { label: "new tab menu", timeoutMs: attempt < 3 ? 2_000 : 10_000 });
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
    }
  }
  await click("[data-context-menu] button", label);
  // Creating the first tab on a cold CI machine can take a while. If it never shows, say whether the server made it.
  try {
    await page!.waitFor(`document.querySelectorAll("nav li[data-app-id]").length > ${count}`, {
      label: `the ${label === "New app" ? "new app" : "new web tab"} in the sidebar`,
      timeoutMs: 60_000,
    });
  } catch (err) {
    const apps = await apiCall<unknown[]>("/api/apps").catch(() => null);
    throw new Error(
      `${(err as Error).message} (the server has ${apps ? `${apps.length} tabs; the sidebar ${count}` : "no answer"})`,
    );
  }
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
    await page!.waitFor(`!!document.querySelector("[data-effort-menu]")`);
    await click(`[data-effort-menu] [data-menu-item="${effort}"]`);
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
    `!!document.querySelector(${JSON.stringify(`${panel} [data-send]`)}) && !document.querySelector(${JSON.stringify(panel)}).innerText.includes("Working…")`,
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
/** Picks an item of the top row's ⋯ menu (the browser's pages, the tab's tools: an app's logs, data…). */
const fromMenu = async (chrome: string, id: string) => {
  await click(`${chrome} [data-more-menu]`.trim());
  await page!.waitFor(`!!document.querySelector('[data-context-menu] [data-menu-item="${id}"]:not(:disabled)')`, {
    label: `the ⋯ menu's ${id}`,
  });
  await click(`[data-context-menu] [data-menu-item="${id}"]`);
};
/** An address as the sidebar shows it while it isn't being edited: without its scheme or a lone trailing slash. */
const displayHost = (url: string) => url.replace(/^https?:\/\//i, "").replace(/^([^/?#]+)\/$/, "$1");

/**
 * Opens Settings at a category of its sidebar, one of the pages in it (History, Schedules, Mods, Activity), or a
 * part of a category's page (General's Search engine…: its category is opened, and the part is on its page).
 */
const openSettingsAt = async (section: string) => {
  await fromMenu("", "settings");
  const nav = `[data-settings-nav="${section}"], [data-settings-parts~="${section}"]`;
  await page!.waitFor(`!!document.querySelector(${JSON.stringify(nav)})`, { label: "settings sidebar" });
  await click(nav);
  await page!.waitFor(
    `document.querySelector("[data-settings-shell]")?.dataset.settingsShell === "${section}" || !!document.querySelector('[data-settings] [data-settings-part="${section}"]')`,
    { label: `settings: ${section}` },
  );
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
  // Let the new size land (and its resize event, which closes menus) before the first check clicks anything.
  await page.waitFor(`innerWidth === 1400 && innerHeight === 900`, { label: "window size" });
  await page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);

  await check("app boots and shows the sidebar", async () => {
    await page!.waitFor(`!!document.querySelector("[data-sidebar-footer] [data-more-menu]")`, { timeoutMs: 20_000 });
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
      `document.querySelector("[data-agent-popover]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`,
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
    await fromMenu(chromeFor(appTab()), "logs");
    await page!.waitFor(
      `document.querySelector('${appTab()} [data-logs-panel]')?.innerText.includes("bun run start")`,
      { label: "logs" },
    );
    await shot("app-live.png");
    await fromMenu(chromeFor(appTab()), "logs");
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
    await fromMenu(chromeFor(appTab()), "snapshots");
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
    await fromMenu(chromeFor(appTab()), "snapshots");

    // The Snapshots page has everything in the workspace.
    await openSettingsAt("snapshots");
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
    await fromMenu(chromeFor(appTab()), "data");
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
    await fromMenu(chromeFor(appTab()), "data");
  });

  await check("tool registry: the app's tools from its data, run from the tools panel", async () => {
    await fromMenu(chromeFor(appTab()), "tools");
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
    await fromMenu(chromeFor(appTab()), "tools");
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
    await fromMenu(chromeFor(appTab()), "secrets");
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
    await fromMenu(chromeFor(appTab()), "secrets");
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
    await fromMenu(chromeFor(appTab()), "restart");
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

  await check(
    "sidebar: hides completely (shown over the page from the left edge), resizes, remembers both",
    async () => {
      const navWidth = () => page!.eval<number>(`document.querySelector("nav").getBoundingClientRect().width`);
      const navRight = () => page!.eval<number>(`document.querySelector("nav").getBoundingClientRect().right`);
      await click("[data-sidebar-toggle]");
      await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "hidden"`, { label: "hidden" });
      // No icon rail: it's off screen, and the page has the window.
      await page!.waitFor(`document.querySelector("nav").getBoundingClientRect().right <= 0`, { label: "off screen" });
      if (!(await page!.eval<boolean>(`JSON.parse(localStorage.getItem("rune.sidebar")).hidden === true`)))
        throw new Error("hiding it isn't remembered");
      await shot("sidebar-hidden.png");
      // The pointer at the window's left edge brings it in over the page; leaving it sends it away.
      await page!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 300 });
      await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "peek"`, { label: "peeking" });
      await page!.waitFor(`document.querySelector("nav").getBoundingClientRect().left >= 0`, { label: "on screen" });
      await shot("sidebar-peek.png");
      const peekRight = await navRight();
      await page!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(peekRight) + 300, y: 300 });
      await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "hidden"`, { label: "away again" });
      // Ctrl+L still pops the address out over the page, without bringing the sidebar in.
      await page!.eval(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", code: "KeyL", ${mod}: true, bubbles: true })), true`,
      );
      await page!.waitFor(
        `!!document.querySelector("[data-address-open]") && document.activeElement?.matches("[data-address]")`,
        { label: "the address focused while the sidebar is hidden" },
      );
      if ((await page!.eval<string>(`document.querySelector("nav").dataset.sidebar`)) !== "hidden")
        throw new Error("Ctrl+L brought the sidebar in");
      await page!.eval(
        `document.querySelector("[data-address]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`,
      );
      await page!.waitFor(`!document.querySelector("[data-address-open]")`, { label: "address closed" });
      // Ctrl+Shift+B brings it back.
      await page!.eval(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "B", ${mod}: true, shiftKey: true, bubbles: true })), true`,
      );
      await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "shown"`, {
        label: "shown by the shortcut",
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
      const saved = await page!.eval<{ width: number; hidden: boolean }>(
        `JSON.parse(localStorage.getItem("rune.sidebar"))`,
      );
      if (saved.width !== Math.round(after) || saved.hidden) throw new Error(`saved ${JSON.stringify(saved)}`);
      await shot("sidebar-wide.png");
      // Back to the default width.
      await page!.eval(
        `document.querySelector("[data-sidebar-resizer]").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`,
      );
      return `hidden, peeked at ${Math.round(peekRight)}px, ${Math.round(before)} → ${Math.round(after)}px`;
    },
  );

  await check("sidebar floating: its menus open over it, and the left edge always brings it back", async () => {
    const state = () => page!.eval<string>(`document.querySelector("nav").dataset.sidebar`);
    /** What's on top at the middle of the menu: the menu itself, not the sidebar. */
    const menuOnTop = () =>
      page!.eval<boolean>(`(() => {
        const menu = document.querySelector("[data-context-menu]");
        if (!menu) return false;
        const r = menu.getBoundingClientRect();
        return !!document.elementFromPoint(r.left + Math.min(r.width / 2, 60), r.top + r.height / 2)?.closest("[data-context-menu]");
      })()`);
    const escape = async () => {
      await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
      await page!.waitFor(`!document.querySelector("[data-context-menu]")`, { label: "menu closed" });
    };
    await click("[data-sidebar-toggle]");
    await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "hidden"`, { label: "hidden" });
    await page!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 300 });
    await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "peek"`, { label: "peeking" });
    await page!.waitFor(`document.querySelector("nav").getBoundingClientRect().left >= 0`, { label: "on screen" });
    // The ⋯ menu, a tab's menu and the New tab menu, each over the floating sidebar.
    const opened: string[] = [];
    for (const [name, open] of [
      ["⋯", `document.querySelector("nav [data-more-menu]").click()`],
      [
        "tab",
        `(() => { const r = document.querySelector("nav li[data-app-id]").getBoundingClientRect(); document.querySelector("nav li[data-app-id]").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); })()`,
      ],
      ["new tab", `document.querySelector("nav [data-new-tab]").click()`],
    ] as const) {
      await page!.eval(`${open}, true`);
      await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: `${name} menu` });
      if (!(await menuOnTop())) {
        await shot("sidebar-menu-under.png");
        throw new Error(`the ${name} menu opened under the floating sidebar`);
      }
      if ((await state()) !== "peek") throw new Error(`the sidebar went away with its ${name} menu open`);
      if (name === "⋯") await shot("sidebar-floating-menu.png");
      await escape();
      opened.push(name);
    }
    await page!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 300 });
    await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "hidden"`, { label: "away again" });
    // Back at the edge without entering it (it was there while the sidebar went): moving in it brings it in.
    await page!.eval(
      `document.querySelector("[data-sidebar-edge]").dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 4, clientY: 300 })), true`,
    );
    await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "peek"`, {
      label: "peek on moving in the edge",
    });
    await page!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 300 });
    await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "hidden"`, { label: "away once more" });
    // Leaving the page through the window's left edge (into the resize border Linux and Windows keep there).
    await page!.eval(
      `document.querySelector("[data-content]").dispatchEvent(new MouseEvent("mouseout", { bubbles: true, clientX: 2, clientY: 300, relatedTarget: null })), true`,
    );
    await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "peek"`, {
      label: "peek on leaving through the left edge",
    });
    // Coming back into the page lets it go.
    await page!.eval(
      `document.querySelector("[data-content]").dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 900, clientY: 300 })), true`,
    );
    await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "hidden"`, {
      label: "away after coming back",
    });
    // The keyboard always brings it back.
    await page!.eval(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "B", ${mod}: true, shiftKey: true, bubbles: true })), true`,
    );
    await page!.waitFor(`document.querySelector("nav").dataset.sidebar === "shown"`, {
      label: "shown by the shortcut",
    });
    return `menus over it: ${opened.join(", ")}`;
  });

  await check(
    "horizontal tabs: switched to from a tab's menu without a reload, new tab, hover card, back from the bar's menu",
    async () => {
      const count = await page!.eval<number>(`document.querySelectorAll("nav li[data-app-id]").length`);
      // The pages stay where they are in the DOM: a webview that moves reloads.
      await page!.eval(
        `document.querySelectorAll("[data-tab-layer]").forEach((l) => (l.__kept = l.parentElement)), true`,
      );
      await page!.eval(
        `(() => { const li = document.querySelector("nav li[data-app-id]"); const r = li.getBoundingClientRect(); li.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); })(), true`,
      );
      await page!.waitFor(`!!document.querySelector('[data-context-menu] [data-menu-item="tab-layout"]')`, {
        label: "the layout in the tab's menu",
      });
      await click('[data-context-menu] [data-menu-item="tab-layout"]');
      await page!.waitFor(
        `!!document.querySelector("[data-tab-strip]") && !document.querySelector("nav[data-sidebar]")`,
        {
          label: "the tab bar instead of the sidebar",
        },
      );
      const tabs = await page!.eval<number>(`document.querySelectorAll("[data-tab-strip] [data-app-id]").length`);
      if (tabs !== count) throw new Error(`${tabs} tabs in the bar, ${count} in the sidebar`);
      if (
        !(await page!.eval<boolean>(
          `[...document.querySelectorAll("[data-tab-layer]")].every((l) => l.__kept && l.__kept === l.parentElement)`,
        ))
      )
        throw new Error("switching the layout re-created the pages");
      const saved = await waitForValue(async () => {
        const s = await apiCall<{ tabs: { layout: string } }>("/api/settings");
        return s.tabs.layout === "horizontal" ? s : undefined;
      });
      // One bar: the navigation, the address and the tabs right after it, on one line; the page under it.
      const layout = await page!.eval<{ bar: number; content: number; oneLine: boolean; tabsAfter: boolean }>(`(() => {
        const bar = document.querySelector("[data-horizontal-tabs]").getBoundingClientRect();
        const address = document.querySelector("[data-horizontal-tabs] [data-address-bar]").getBoundingClientRect();
        const tab = document.querySelector("[data-tab-strip] [data-app-id]").getBoundingClientRect();
        return {
          bar: bar.bottom,
          content: document.querySelector("[data-content]").getBoundingClientRect().top,
          oneLine: Math.abs((address.top + address.bottom) / 2 - (tab.top + tab.bottom) / 2) < 4 && bar.height < 60,
          tabsAfter: tab.left >= address.right,
        };
      })()`);
      if (!layout.oneLine || !layout.tabsAfter || layout.content < layout.bar)
        throw new Error(`bar and page: ${JSON.stringify(layout)}`);
      await shot("horizontal-tabs.png");
      // New tab: a web tab, at once, on screen.
      await click("[data-tab-strip] [data-new-tab]");
      await page!.waitFor(`document.querySelectorAll("[data-tab-strip] [data-app-id]").length === ${count + 1}`, {
        label: "the new tab in the bar",
      });
      const added = await page!.waitFor<string>(
        `document.querySelector('[data-tab-strip] [data-app-id][aria-current="page"]')?.dataset.appId`,
        { label: "the new tab on screen" },
      );
      await page!.eval(
        `document.querySelector("[data-address]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`,
      );
      // The pointer resting on a tab shows its card.
      const r = await page!.eval<{ x: number; y: number }>(`(() => {
        const r = document.querySelector('[data-tab-strip] [data-app-id]').getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      await page!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
      await page!.waitFor(`!!document.querySelector("[data-tab-card]")`, { label: "hover card" });
      await shot("horizontal-tabs-card.png");
      await page!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: 500 });
      await page!.waitFor(`!document.querySelector("[data-tab-card]")`, { label: "hover card gone" });
      await click(`[data-tab-strip] [data-app-id="${added}"] [data-close-tab]`);
      await page!.waitFor(`document.querySelectorAll("[data-tab-strip] [data-app-id]").length === ${count}`, {
        label: "the new tab closed",
      });
      // Back to vertical tabs from the bar's own menu.
      await page!.eval(`(() => {
        const list = document.querySelector("[data-tab-list]");
        const r = list.getBoundingClientRect();
        list.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.right - 1, clientY: r.top + r.height / 2 }));
      })(), true`);
      await page!.waitFor(`!!document.querySelector('[data-context-menu] [data-menu-item="tab-layout"]')`, {
        label: "the layout in the bar's menu",
      });
      await click('[data-context-menu] [data-menu-item="tab-layout"]');
      await page!.waitFor(
        `!!document.querySelector("nav[data-sidebar]") && !document.querySelector("[data-tab-strip]")`,
        {
          label: "the sidebar back",
        },
      );
      if (
        !(await page!.eval<boolean>(
          `[...document.querySelectorAll("[data-tab-layer]")].every((l) => l.__kept && l.__kept === l.parentElement)`,
        ))
      )
        throw new Error("switching back re-created the pages");
      await waitForValue(async () => {
        const s = await apiCall<{ tabs: { layout: string } }>("/api/settings");
        return s.tabs.layout === "vertical" ? s : undefined;
      });
      return `${count} tabs in the bar (${saved.tabs.layout}), and back`;
    },
  );

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
    if (await page!.eval<boolean>(`!!document.querySelector('${panel} [data-new-chat]')`))
      throw new Error("New chat is offered for an empty chat");
    // A suggestion in the empty chat goes into the composer, ready to edit or send.
    await page!.waitFor(`!!document.querySelector('${panel} [data-chat-empty] [data-suggestion]')`, {
      label: "suggestions",
    });
    const suggestion = await page!.eval<string>(
      `document.querySelector('${panel} [data-suggestion]').textContent.trim()`,
    );
    await click(`${panel} [data-suggestion]`);
    await page!.waitFor(`document.querySelector('${panel} textarea').value === ${JSON.stringify(suggestion)}`, {
      label: "suggestion in the composer",
    });
    await type(`${panel} textarea`, "");
    await click(`${panel} [data-chat-history-button]`);
    await page!.waitFor(`document.querySelector("[data-chat-history]")?.innerText.includes("No earlier chats")`, {
      label: "history popover",
    });
    await shot("chat-history-empty.png");
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-chat-history]")`, { label: "closed" });
    const chats = await apiCall<unknown[]>(`/api/apps/${appId}/chats`);
    if (chats.length) throw new Error("unexpected chats");
  });

  await check(
    "sidebar: no header; the ⋯ menu, workspaces and the agent in one row at the bottom, also at the minimum width",
    async () => {
      if (await page!.eval<boolean>(`!!document.querySelector("[data-workspace-switcher]")`))
        throw new Error("the workspace header is still there");
      const layout = () =>
        page!.eval<{ tops: number[]; order: string[]; inside: boolean; centered: boolean; bottom: boolean }>(`(() => {
        const nav = document.querySelector("nav").getBoundingClientRect();
        const footer = document.querySelector("[data-sidebar-footer]");
        const parts = [footer.querySelector("[data-more-menu]"), footer.querySelector("[data-workspace-bar]"), footer.querySelector("[data-footer-end]")];
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
      return "⋯ · workspaces · agent; History in Settings";
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

  await check("address bar: compact in the sidebar, pops out over the page when focused; the ⋯ menu", async () => {
    const tab = `[data-web-tab="${webTabId}"]`;
    await click(`nav li[data-app-id="${webTabId}"]`);
    const address = `${chromeFor(tab)} [data-address]`;
    await page!.waitFor(`document.querySelector('${address}')?.value === "${displayHost(site.url.origin)}"`, {
      label: "the address without its scheme",
    });
    // The site's settings are behind its icon, at the start; the empty star only shows on hover, and takes no
    // room until then (the address isn't cut short for it).
    const bar = `${chromeFor(tab)} [data-address-bar]`;
    const starState = `(() => {
      const row = document.querySelector('${bar}').firstElementChild;
      const star = row.querySelector("[data-bookmark-star]");
      const field = row.querySelector("[data-address]").parentElement.getBoundingClientRect();
      return { identityFirst: row.firstElementChild.matches("[data-site-info-button]"), starShown: !!star && getComputedStyle(star).opacity !== "0", starWidth: star ? Math.round(star.getBoundingClientRect().width) : -1, field: Math.round(field.width) };
    })()`;
    type StarState = { identityFirst: boolean; starShown: boolean; starWidth: number; field: number };
    const layout = await page!.eval<StarState>(starState);
    if (!layout.identityFirst || layout.starShown || layout.starWidth !== 0)
      throw new Error(`address layout: ${JSON.stringify(layout)}`);
    const barRect = await page!.eval<{ x: number; y: number }>(
      `(() => { const r = document.querySelector('${bar}').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) }; })()`,
    );
    await page!.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...barRect });
    const hovered = await page!.waitFor<StarState>(
      `(() => { const s = ${starState}; return s.starShown && s.starWidth === 24 ? s : undefined; })()`,
      { label: "the star shown on hover" },
    );
    // It comes in over the end of the address (its room and the gap before it).
    if (layout.field - hovered.field !== 31)
      throw new Error(`the address with the star shown: ${JSON.stringify({ layout, hovered })}`);
    await page!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: barRect.x + 600, y: 400 });
    await page!.waitFor(`(() => { const s = ${starState}; return !s.starShown && s.starWidth === 0; })()`, {
      label: "the star hidden again",
    });

    await page!.eval(`document.querySelector('${address}').focus(), true`);
    const floating = await page!.waitFor<{ width: number; left: number; value: string }>(
      `(() => {
        const bar = document.querySelector('${bar}');
        if (!bar.matches("[data-address-open]")) return undefined;
        const r = bar.getBoundingClientRect();
        return { width: Math.round(r.width), left: Math.round(r.left), value: document.querySelector('${address}').value };
      })()`,
      { label: "the address popped out" },
    );
    const sidebar = await page!.eval<number>(`Math.round(document.querySelector("nav").getBoundingClientRect().width)`);
    if (floating.width <= sidebar || floating.left < sidebar / 2 || floating.value !== `${site.url.origin}/`)
      throw new Error(`floating: ${JSON.stringify({ ...floating, sidebar })}`);
    await type(address, "test");
    await page!.waitFor(`!!document.querySelector('${bar} [data-suggestions] [data-suggestion="search"]')`, {
      label: "suggestions under it",
    });
    await shot("address-popover.png");
    // Focus lost and back right away (Ctrl+T or Ctrl+L just after it closed): it stays open.
    await page!.eval(`(() => { const i = document.querySelector('${address}'); i.blur(); i.focus(); return true; })()`);
    await Bun.sleep(400);
    if (!(await page!.eval<boolean>(`!!document.querySelector('${bar}[data-address-open]')`)))
      throw new Error("closed although it got the focus back");
    // A click outside (on the backdrop over the page) closes it.
    await page!.eval(
      `document.querySelector("[data-address-backdrop]").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })), true`,
    );
    await page!.waitFor(
      `!document.querySelector('${bar}[data-address-open]') && !document.querySelector("[data-address-backdrop]") && document.querySelector('${address}').value === "${displayHost(site.url.origin)}"`,
      { label: "closed again, the address back" },
    );

    // Typed into without a focus event first (as scripts and some input methods do): what's typed stays.
    await type(address, "typed first");
    await page!.waitFor(`document.querySelector('${address}').value === "typed first"`, {
      label: "the typed text kept",
      timeoutMs: 2000,
    });
    await page!.eval(
      `document.querySelector('${address}').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`,
    );
    await page!.waitFor(`!document.querySelector('${bar}[data-address-open]')`, { label: "closed with Escape" });

    // One ⋯ menu instead of a row of buttons: the browser's pages, the page's actions, Settings.
    await click(`${chromeFor(tab)} [data-more-menu]`);
    await page!.waitFor(`!!document.querySelector('[data-context-menu] [data-menu-item="find.open"]')`, {
      label: "the ⋯ menu",
    });
    const items = await page!.eval<string[]>(
      `[...document.querySelectorAll("[data-context-menu] [data-menu-item]")].map((b) => b.dataset.menuItem)`,
    );
    for (const id of ["new-tab", "bookmarks", "history", "downloads", "extensions", "settings"])
      if (!items.includes(id)) throw new Error(`the menu has no ${id}: ${items.join(", ")}`);
    await shot("more-menu.png");
    // Pressed again (pointerdown, then click, like a real click), ⋯ closes its menu.
    await page!.eval(`(() => {
      const b = document.querySelector('${chromeFor(tab)} [data-more-menu]');
      b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      b.click();
      return true;
    })()`);
    await Bun.sleep(150);
    if (await page!.eval<boolean>(`!!document.querySelector("[data-context-menu]")`))
      throw new Error("⋯ didn't close its menu");
    await click(`${chromeFor(tab)} [data-more-menu]`);
    await page!.waitFor(`!!document.querySelector('[data-context-menu] [data-menu-item="bookmarks"]')`, {
      label: "the ⋯ menu again",
    });
    await click('[data-context-menu] [data-menu-item="bookmarks"]');
    await page!.waitFor(`!!document.querySelector("[data-bookmarks-menu]")`, { label: "the bookmarks menu" });
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-bookmarks-menu]")`, { label: "bookmarks menu closed" });
    return `${floating.width}px wide over a ${sidebar}px sidebar; menu: ${items.length} items`;
  });

  await check("keyboard shortcuts: pages keep their own keys, the browser's work everywhere", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "web tab" },
    );
    const tab = `[data-web-tab="${tabId}"]`;
    await page!.waitFor(`!!document.querySelector('${chromeFor(tab)} [data-address]')`, { label: "address bar" });
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
    await fromMenu("", "settings");
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

  await check("agent sidebar: closed on web tabs until opened (Ctrl+I), remembered per tab", async () => {
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
    const ctrlI = () =>
      page!.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ${mod}: true, bubbles: true })), true`);
    await ctrlI();
    await page!.waitFor(`!!document.querySelector('[data-agent-for="${tabId}"]')`, { label: "opened with Ctrl+I" });
    // Another tab and back: still open for this one.
    await click(`nav li[data-app-id="${webTabId}"]`);
    await page!.waitFor(
      `document.querySelector('nav li[data-app-id="${tabId}"]').getAttribute("aria-current") !== "page"`,
      { label: "other tab" },
    );
    await click(`nav li[data-app-id="${tabId}"]`);
    await page!.waitFor(`!!document.querySelector('[data-agent-for="${tabId}"]')`, { label: "still open" });
    await ctrlI();
    await page!.waitFor(`!document.querySelector("[data-agent-sidebar]")`, { label: "closed with Ctrl+I" });
    await apiCall(`/api/apps/${tabId}`, { method: "DELETE" });
    return "closed by default, opened, remembered, closed";
  });

  await check(
    "downloads: saved to the folder, progress, pause and cancel, risky files, the page (Ctrl+J)",
    async () => {
      if (!webTabId) throw new Error("needs the web tab");
      const tab = `[data-web-tab="${webTabId}"]`;
      const files = () => readdirSync(downloadsDir).sort();
      const row = (selector: string) => `document.querySelector('${selector}')`;
      const stateOf = (scope: string, name: string) =>
        page!.eval<string | null>(
          `[...document.querySelectorAll('${scope} [data-download]')].find((r) => r.innerText.includes(${JSON.stringify(name)}))?.dataset.downloadState ?? null`,
        );
      const waitState = (scope: string, name: string, state: string, timeoutMs = 15_000) =>
        waitForValue(async () => ((await stateOf(scope, name)) === state ? true : undefined), timeoutMs).catch(
          async () => {
            throw new Error(`${name}: ${await stateOf(scope, name)} instead of ${state}`);
          },
        );
      const actOn = (scope: string, name: string, action: string) =>
        page!.eval(`(() => {
        const row = [...document.querySelectorAll('${scope} [data-download]')].find((r) => r.innerText.includes(${JSON.stringify(name)}));
        row.querySelector('[data-download-action="${action}"]').click();
        return true;
      })()`);
      const download = (path: string) =>
        page!.eval(
          `document.querySelector('${tab} webview').downloadURL(${JSON.stringify(`${site.url.origin}${path}`)}), true`,
        );
      const closePanel = () =>
        page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
      const panel = "[data-downloads-panel]";

      // Ctrl+J (Cmd+Shift+J on macOS) opens the page, also from inside a web page; nothing downloaded yet.
      await click(`nav li[data-app-id="${webTabId}"]`);
      await page!.waitFor(`!!document.querySelector('${tab} webview')`, { label: "web tab" });
      await page!.eval(`(() => {
      const view = document.querySelector('${tab} webview');
      view.focus();
      const modifiers = ${JSON.stringify(process.platform === "darwin" ? ["meta", "shift"] : [modKey])};
      for (const type of ["keyDown", "keyUp"]) view.sendInputEvent({ type, keyCode: "J", modifiers });
      return true;
    })()`);
      await page!.waitFor(`!!document.querySelector("[data-downloads-page] [data-downloads-empty]")`, {
        label: "the downloads page, empty",
      });
      if (await page!.eval<boolean>(`!!document.querySelector("[data-downloads-button]")`))
        throw new Error("the downloads button shows before anything was downloaded");

      // A page's download goes to the downloads folder; a notice says so, the button shows it.
      await click(`nav li[data-app-id="${webTabId}"]`);
      await inView(tab, `location.href = ${JSON.stringify(`${site.url.origin}/download/report.txt`)}, true`);
      await page!.waitFor(
        `[...document.querySelectorAll('[data-toast="success"]')].some((t) => t.innerText.includes("report.txt"))`,
        {
          label: "a notice that it finished",
        },
      );
      await page!.waitFor(`!!document.querySelector("[data-downloads-button] [data-downloads-unseen]")`, {
        label: "the button's dot",
      });
      if (readFileSync(join(downloadsDir, "report.txt"), "utf8") !== "contents of report.txt")
        throw new Error(`not saved: ${files().join(", ")}`);
      // The same name again doesn't overwrite it.
      await download("/download/report.txt");
      await waitForValue(async () => (files().includes("report (1).txt") ? true : undefined));

      // Progress, pause, resume and cancel, in the panel.
      await download("/download/slow.bin");
      await click("[data-downloads-button]");
      await page!.waitFor(`!!${row(panel)}`, { label: "the panel" });
      await waitState(panel, "slow.bin", "progressing");
      await page!.waitFor(`!!document.querySelector("[data-downloads-button] svg")`, { label: "the button's ring" });
      // How much arrived and how fast (the test site streams it without saying its size).
      await waitForValue(async () =>
        /\/s · [\d.]+ (kB|MB)/.test(await page!.eval<string>(`document.querySelector('${panel}').innerText`))
          ? true
          : undefined,
      );
      await shot("downloads-panel.png");
      await actOn(panel, "slow.bin", "pause");
      await waitState(panel, "slow.bin", "paused");
      await actOn(panel, "slow.bin", "resume");
      await waitState(panel, "slow.bin", "progressing");
      await actOn(panel, "slow.bin", "cancel");
      await waitState(panel, "slow.bin", "cancelled");
      if (files().includes("slow.bin")) throw new Error("a cancelled download left its file");
      await closePanel();
      await page!.waitFor(`!${row(panel)}`, { label: "panel closed" });

      // A program waits for an OK in the panel (it opens by itself), under a name that can't run.
      await download("/download/setup.exe");
      await page!.waitFor(`!!${row(`${panel} [data-download-state="warning"]`)}`, {
        label: "the risky file's warning",
      });
      await waitForValue(async () => (files().some((f) => /^Unconfirmed \d+\.download$/.test(f)) ? true : undefined));
      if (files().includes("setup.exe")) throw new Error("the risky file was saved under its name before it was kept");
      await shot("downloads-warning.png");
      await actOn(panel, "setup.exe", "keep");
      await waitForValue(async () => (files().includes("setup.exe") ? true : undefined));
      await waitState(panel, "setup.exe", "completed");
      if (files().some((f) => f.startsWith("Unconfirmed"))) throw new Error("the unconfirmed file stayed");
      // ...or is discarded.
      await closePanel();
      await download("/download/tool.exe");
      await page!.waitFor(`!!${row(`${panel} [data-download-state="warning"]`)}`, { label: "the second warning" });
      await actOn(panel, "tool.exe", "discard");
      await waitState(panel, "tool.exe", "discarded");
      await waitForValue(async () =>
        !files().some((f) => f.startsWith("Unconfirmed")) && !files().includes("tool.exe") ? true : undefined,
      );
      await closePanel();

      // A failed download says so, with Retry.
      await download("/download/missing.bin");
      await page!.waitFor(
        `[...document.querySelectorAll('[data-toast="error"]')].some((t) => t.innerText.includes("missing.bin"))`,
        {
          label: "a notice that it failed",
        },
      );

      // The page: by day, searchable; retry, remove, clear.
      await click("[data-downloads-button]");
      await click(`${panel} [data-downloads-all]`);
      const pageSel = "[data-downloads-page]";
      await page!.waitFor(`!!document.querySelector('${pageSel} [data-downloads-day="Today"]')`, {
        label: "today's downloads",
      });
      await waitState(pageSel, "missing.bin", "interrupted");
      await waitState(pageSel, "report (1).txt", "completed");
      if (
        !(await page!.eval<boolean>(
          `!!document.querySelector('${pageSel} [data-download] [data-download-action="show"]')`,
        ))
      )
        throw new Error("no Show in folder");
      await shot("downloads-page.png");
      await type("[data-downloads-search]", "setup");
      await page!.waitFor(`document.querySelectorAll('${pageSel} [data-download]').length === 1`, {
        label: "searched",
      });
      await type("[data-downloads-search]", "");
      // Retry the cancelled one: it downloads again, in full.
      await actOn(pageSel, "slow.bin", "retry");
      await waitState(pageSel, "slow.bin", "completed", 30_000);
      if (readFileSync(join(downloadsDir, "slow.bin")).length !== 40 * 64 * 1024)
        throw new Error("the retry didn't finish");
      await actOn(pageSel, "report (1).txt", "remove");
      await page!.waitFor(
        `![...document.querySelectorAll('${pageSel} [data-download]')].some((r) => r.innerText.includes("report (1).txt"))`,
        {
          label: "removed",
        },
      );
      if (!files().includes("report (1).txt")) throw new Error("removing it from the list deleted the file");
      await click("[data-downloads-clear]");
      await page!.waitFor(`!!document.querySelector("[data-downloads-page] [data-downloads-empty]")`, {
        label: "cleared",
      });
      return `saved ${files().join(", ")}; paused, cancelled, kept, discarded, failed, retried, searched, cleared`;
    },
  );

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
    // The headline's text node, held like a framework (React) holds the nodes it rendered.
    await inPage(`window.__heldText = document.querySelector("#headline").firstChild, true`);
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
    // The text changed in the page's own node, so a framework updating or removing it keeps working, and
    // the change comes back after it.
    await until(`window.__heldText.parentNode === document.querySelector("#headline")`, "text changed in place");
    await inPage(`window.__heldText.nodeValue = "Framework update", true`);
    await until(`window.__heldText.nodeValue === "Changed headline"`, "text after the framework's update");
    await inPage(`document.querySelector("#headline").removeChild(window.__heldText), true`);
    await until(`document.querySelector("#headline").textContent === "Changed headline"`, "text after removal");
    await inPage(
      `window.__heldText.nodeValue = "Hello from the test site", document.querySelector("#headline").replaceChildren(window.__heldText), true`,
    );
    await until(`window.__heldText.nodeValue === "Changed headline"`, "text after the framework rendered again");
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

  await check("page changes wait for a framework (React) to hydrate the page before changing it", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "web tab in the sidebar" },
    );
    const tab = `[data-web-tab="${tabId}"]`;
    const inPage = <T>(code: string) =>
      page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
    await page!.waitFor(`!!document.querySelector('${chromeFor(tab)} [data-address]')`, { label: "address bar" });
    await page!.eval(
      `window.__runeRpc("page.navigate", ${JSON.stringify({ tabId, url: `${site.url.origin}/hydrate` })})`,
    );
    const change = await apiCall<{ id: string }>("/api/page-changes", {
      method: "POST",
      body: {
        title: "Hydrated heading",
        scope: { type: "page", value: "127.0.0.1/hydrate" },
        action: "text",
        selector: "#hydrated",
        value: "Changed after hydration",
      },
    });
    const inserted = await apiCall<{ id: string }>("/api/page-changes", {
      method: "POST",
      body: {
        title: "Note after the lead",
        scope: { type: "page", value: "127.0.0.1/hydrate" },
        action: "insert",
        selector: "#lead",
        value: '<p class="hydrated-note">Inserted after hydration</p>',
      },
    });
    try {
      // Loaded and idle, but not hydrated: the server's DOM stays as it was.
      await Bun.sleep(3000);
      const before = await inPage<string>(
        `document.querySelector("#hydrated").textContent + "|" + !!document.querySelector(".hydrated-note")`,
      );
      if (before !== "Server heading|false") throw new Error(`changed before hydration: ${before}`);
      await inPage(`window.hydrate()`);
      await waitForValue(
        async () =>
          (await inPage<string>(
            `document.querySelector("#hydrated").textContent + "|" + !!document.querySelector("#lead + .hydrated-note")`,
          )) === "Changed after hydration|true"
            ? true
            : undefined,
        10_000,
      ).catch(() => {
        throw new Error("not changed after hydration");
      });
    } finally {
      await apiCall(`/api/page-changes/${change.id}`, { method: "DELETE" });
      await apiCall(`/api/page-changes/${inserted.id}`, { method: "DELETE" });
      await apiCall(`/api/apps/${tabId}`, { method: "DELETE" });
    }
    return "left alone while hydrating, changed once hydrated";
  });

  await check("headless tabs: a page read in the background, listed in the agent's tab, closed again", async () => {
    const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
    await newTab("New web tab");
    const tabId = await page!.waitFor<string>(
      `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
      { label: "web tab in the sidebar" },
    );
    const workspaceId = (await apiCall<{ id: string; workspaceId: string }[]>("/api/apps")).find(
      (a) => a.id === tabId,
    )!.workspaceId;
    const rpc = <T>(method: string, params: object = {}) =>
      page!.eval<T>(`window.__runeRpc(${JSON.stringify(method)}, ${JSON.stringify({ tabId, ...params })})`);
    const origin = `http://headless.example:${site.port}`;
    type Page = { id: string; url: string; title: string; blocked?: { url: string; reason: string } };
    const opened = await rpc<Page>("headless.open", { workspaceId, url: `${origin}/act`, logins: false, hosts: [] });
    if (opened.title !== "Act page") throw new Error(`opened ${JSON.stringify(opened)}`);
    // Not a tab: the tab list is as it was.
    if ((await page!.eval<number>(`document.querySelectorAll("nav li").length`)) !== count + 1)
      throw new Error("a headless tab showed up in the tab list");
    // Laid out like a window, although it's never shown.
    const width = await rpc<number>("headless.eval", { id: opened.id, code: "innerWidth" });
    if (width !== 1280) throw new Error(`laid out ${width} pixels wide`);
    const heading = await rpc<string>("headless.eval", {
      id: opened.id,
      code: `document.querySelector("h1").textContent`,
    });
    if (heading !== "Act") throw new Error(`read ${heading}`);
    // Listed above the agent's composer, with a way to open it as a tab.
    await page!.eval(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ${mod}: true, bubbles: true })), true`,
    );
    await page!.waitFor(`!!document.querySelector('[data-agent-for="${tabId}"] [data-headless-tab="${opened.id}"]')`, {
      label: "listed in the agent's tab",
    });
    await shot("headless-tab.png");
    // Local addresses are out of reach: opened directly, or reached by the page.
    const local = await rpc("headless.open", {
      workspaceId,
      url: `${site.url.origin}/second`,
      logins: false,
      hosts: [],
    }).then(
      () => "opened",
      (err: unknown) => String(err),
    );
    if (!local.includes("local network")) throw new Error(`a local address: ${local}`);
    // A name that resolves to a local address.
    const named = await rpc<Page>("headless.navigate", {
      id: opened.id,
      url: `http://local-name.example:${site.port}/second`,
    });
    if (named.blocked?.reason !== "not-a-website") throw new Error(`a local name: ${JSON.stringify(named)}`);
    const left = await rpc<Page>("headless.navigate", { id: opened.id, url: `${origin}/to-local` });
    // The page's own navigation there is stopped: it stays on the site.
    await Bun.sleep(1500);
    const where = await rpc<string>("headless.eval", { id: opened.id, code: "location.href" });
    if (!where.startsWith(origin)) throw new Error(`went to ${where} (${JSON.stringify(left)})`);
    // Closed from the chip: gone from the list and from the main process.
    await click(`[data-headless-tab="${opened.id}"] [data-chip-remove]`);
    await page!.waitFor(`!document.querySelector('[data-headless-tab]')`, { label: "closed" });
    const after = await rpc("headless.eval", { id: opened.id, code: "1" }).then(
      () => "still open",
      (err: unknown) => String(err),
    );
    if (!after.includes("closed")) throw new Error(`after closing: ${after}`);
    // With logins: only the hosts the user allowed (a page going elsewhere is stopped), and passwords a
    // password manager fills in are cleared.
    const withLogins = await rpc<Page>("headless.open", {
      workspaceId,
      url: `${origin}/to-other`,
      logins: true,
      hosts: ["headless.example"],
    });
    await Bun.sleep(1500);
    const stayed = await rpc<string>("headless.eval", { id: withLogins.id, code: "location.href" });
    if (!stayed.startsWith(origin)) throw new Error(`with logins, went to ${stayed}`);
    await rpc<Page>("headless.navigate", { id: withLogins.id, url: `${origin}/form` });
    await rpc("headless.eval", { id: withLogins.id, code: `document.querySelector("#pw").value = "hunter2", true` });
    await Bun.sleep(400);
    const password = await rpc<string>("headless.eval", {
      id: withLogins.id,
      code: `document.querySelector("#pw").value`,
    });
    if (password !== "") throw new Error("a password stayed in the field");
    await rpc("headless.close", { id: withLogins.id });
    // The agent's turn ends: every one its tab has goes.
    for (const path of ["/act", "/second"])
      await rpc("headless.open", { workspaceId, url: `${origin}${path}`, logins: false, hosts: [] });
    await page!.waitFor(`document.querySelectorAll('[data-headless-tab]').length === 2`, { label: "two listed" });
    const closed = await rpc<number>("headless.closeTab");
    if (closed !== 2) throw new Error(`closed ${closed} at the turn's end`);
    await page!.waitFor(`!document.querySelector('[data-headless-tab]')`, { label: "none left" });
    await apiCall(`/api/apps/${tabId}`, { method: "DELETE" });
    return "read in the background, local addresses and names refused, logins kept to their hosts, listed, closed, closed at the turn's end";
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
        // The server writes too (browsing history on every page): wait for its lock, like it does.
        db.run("PRAGMA busy_timeout = 5000");
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
      // A request with a body that sends no cookies: Chromium pauses it from inside a call that
      // crashed the browser when it was answered right away (see main/overrides.ts).
      const postJson = `fetch("/api/feed", { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: 1 }) })`;
      for (let i = 0; i < 5; i++) {
        const posted = await inPage<string>(`${postJson}.then((r) => r.text())`);
        if (posted !== JSON.stringify({ items: [] })) throw new Error(`a POST got ${posted}`);
      }
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
      const postFailed = await inPage<string>(`${postJson}.then(() => "answered", () => "failed")`);
      if (postFailed !== "failed") throw new Error(`a failing POST was ${postFailed}`);
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

  await check(
    "browsing history: Ctrl+H, by day, searched, opened, removed, cleared; suggested by the address bar",
    async () => {
      if (!webTabId) throw new Error("needs the web tab");
      const tab = `[data-web-tab="${webTabId}"]`;
      const workspaceId = (await apiCall<{ id: string; workspaceId: string }[]>("/api/apps")).find(
        (a) => a.id === webTabId,
      )?.workspaceId;
      const visits = () =>
        apiCall<{ id: number; url: string; title: string }[]>(`/api/visits?workspace=${workspaceId}`);
      await click(`nav li[data-app-id="${webTabId}"]`);
      await page!.eval(
        `document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(`location.href = ${JSON.stringify(`${site.url.origin}/second?history`)}; true`)})`,
      );
      await waitForValue(
        async () =>
          (await visits()).some((v) => v.url.endsWith("/second?history") && v.title === "Second page")
            ? true
            : undefined,
        15_000,
      );

      // Ctrl+H (macOS Cmd+Y) opens History: today's pages, newest first.
      const mac = process.platform === "darwin";
      await page!.eval(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "${mac ? "y" : "h"}", code: "${mac ? "KeyY" : "KeyH"}", ${mod}: true, bubbles: true })), true`,
      );
      await page!.waitFor(
        `document.querySelector("[data-settings-shell]")?.dataset.settingsShell === "history" && !!document.querySelector("[data-browsing-history] [data-visit]")`,
        { label: "History page" },
      );
      const heading = await page!.eval<string>(`document.querySelector("[data-history-day] h2").textContent`);
      if (!heading.startsWith("Today")) throw new Error(`first day: ${heading}`);
      const titles = await page!.eval<string[]>(
        `[...document.querySelectorAll("[data-browsing-history] [data-visit-link]")].map((a) => a.innerText)`,
      );
      if (!titles[0]?.includes("Second page") || !titles.some((t) => t.includes("Test site")))
        throw new Error(`visits: ${titles.join(" | ")}`);
      await shot("browsing-history.png");

      // Search.
      await type("[data-history-search]", "second");
      await page!.waitFor(
        `(() => { const rows = [...document.querySelectorAll("[data-browsing-history] [data-visit-link]")]; return rows.length > 0 && rows.every((a) => (a.innerText + a.href).toLowerCase().includes("second")) && !rows.some((a) => a.innerText.includes("Test site")); })()`,
        { label: "search results" },
      );

      // A visit opens in a new tab.
      const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
      await click("[data-browsing-history] [data-visit-link]");
      const opened = await page!.waitFor<string>(
        `document.querySelectorAll("nav li").length === ${count + 1} && !document.querySelector("[data-settings-shell]") && document.querySelector('nav li[aria-current="page"]')?.dataset.appId`,
        { label: "opened in a new tab" },
      );
      await apiCall(`/api/apps/${opened}`, { method: "DELETE" });

      // The address bar suggests pages from history.
      await click(`nav li[data-app-id="${webTabId}"]`);
      const address = `${chromeFor(tab)} [data-address]`;
      await page!.eval(`document.querySelector('${address}').focus(), true`);
      await type(address, "Test si");
      await page!.waitFor(
        `[...document.querySelectorAll('[data-suggestions] [data-suggestion^="history:"]')].some((b) => b.innerText.includes("Test site"))`,
        { label: "history suggestion" },
      );
      await shot("history-suggestions.png");
      await page!.eval(
        `document.querySelector('${address}').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`,
      );

      // Removing one visit.
      await openSettingsAt("history");
      await page!.waitFor(`!!document.querySelector("[data-browsing-history] [data-visit]")`, { label: "visits" });
      const before = (await visits()).length;
      const removedId = await page!.eval<string>(
        `document.querySelector("[data-browsing-history] [data-visit]").dataset.visit`,
      );
      await click("[data-browsing-history] [data-visit-remove]");
      await page!.waitFor(`!document.querySelector('[data-browsing-history] [data-visit="${removedId}"]')`, {
        label: "removed",
      });
      await waitForValue(async () => ((await visits()).length === before - 1 ? true : undefined));

      // Clearing all of it: "Clear browsing data" in Privacy and security, history only.
      await click("[data-history-clear]");
      await page!.waitFor(`!!document.querySelector("[data-clear-history]")`, { label: "clear browsing data" });
      for (const other of ["[data-clear-cookies]", "[data-clear-cache]"])
        if (await page!.eval<boolean>(`document.querySelector(${JSON.stringify(other)}).checked`)) await click(other);
      const range = await page!.eval<string>(`document.querySelector("[data-clear-range]").value`);
      if (range !== "all") throw new Error(`time range: ${range}`);
      await shot("clear-browsing-data.png");
      await click("[data-clear-data]");
      await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm" });
      await click("[data-confirm-dialog] [data-confirm]");
      await waitForValue(async () => ((await visits()).length ? undefined : true));
      await openSettingsAt("history");
      await page!.waitFor(`!!document.querySelector("[data-history-empty]")`, { label: "empty history" });
      if ((await visits()).length) throw new Error("visits left after clearing");
      return `${before} visits, search, open, suggest, remove, clear`;
    },
  );

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

  await check("a site's own service worker: cleaning up and navigating away doesn't crash Rune", async () => {
    if (!webTabId) throw new Error("needs the web tab");
    const tab = `[data-web-tab="${webTabId}"]`;
    const inPage = <T>(code: string) =>
      page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
    const url = () => inPage<string>("location.href");
    await click(`nav li[data-app-id="${webTabId}"]`);
    for (let round = 1; round <= 5; round++) {
      await inPage(`location.href = ${JSON.stringify(`${site.url.origin}/sw`)}, true`);
      await waitForValue(
        async () =>
          (await inPage<string>(`document.getElementById("state")?.textContent ?? ""`)) === "ready" ? true : undefined,
        15_000,
      );
      await inPage(`document.getElementById("clean").click(), true`);
      await waitForValue(async () => ((await url()).endsWith("/second") ? true : undefined), 15_000);
    }
    // The app (and its server) are still there.
    await apiCall("/api/apps");
    return "5 rounds of request, cache cleanup, new worker and navigation";
  });

  await check(
    "insecure sites: HTTPS tried first, a warning instead, go back, continue, allowed in settings",
    async () => {
      if (!webTabId) throw new Error("needs the web tab");
      const tab = `[data-web-tab="${webTabId}"]`;
      const chrome = chromeFor(tab);
      const inPage = <T>(code: string) =>
        page!.eval<T>(`document.querySelector('${tab} webview').executeJavaScript(${JSON.stringify(code)})`);
      const url = () => inPage<string>("location.href");
      const warning = `document.querySelector('${tab} [data-insecure-warning]')`;
      await click(`nav li[data-app-id="${webTabId}"]`);
      const start = `${site.url.origin}/second`;
      await inPage(`location.href = ${JSON.stringify(start)}, true`);
      await waitForValue(async () => ((await url()) === start ? true : undefined), 15_000);

      // A link of the page to an insecure site: its HTTPS version fails, so the tab warns.
      await inPage(`location.href = "http://insecure.example/", true`);
      await page!.waitFor(`${warning}?.dataset.insecureWarning === "http://insecure.example/"`, {
        timeoutMs: 20_000,
        label: "the warning",
      });
      await page!.waitFor(`!!document.querySelector('${chrome} [data-not-secure]')`, { label: "Not secure" });
      // The address is the page warned about, not its failed HTTPS attempt.
      await page!.waitFor(`document.querySelector('${chrome} [data-address]').value === "http://insecure.example/"`, {
        label: "the http:// address",
      });
      const text = await page!.eval<string>(`${warning}.innerText`);
      if (!text.includes("doesn't have a working secure connection")) throw new Error(`warning says: ${text}`);
      await shot("insecure-warning.png");

      // Go back: the page from before, over the failed attempt.
      await click(`${tab} [data-insecure-back]`);
      await page!.waitFor(`!${warning}`, { label: "warning gone" });
      await waitForValue(async () => ((await url()) === start ? true : undefined), 15_000);
      await page!.waitFor(`!document.querySelector('${chrome} [data-not-secure]')`, { label: "secure again" });

      // A port of its own: warned at once, nothing loaded, so going back leaves the page as it is.
      await inPage(`location.href = "http://insecure.example:8081/", true`);
      await page!.waitFor(`${warning}?.innerText.includes("on its own port")`, { label: "warning for a port" });
      if ((await url()) !== start) throw new Error(`the page moved to ${await url()}`);
      await click(`${tab} [data-insecure-back]`);
      await page!.waitFor(`!${warning}`, { label: "warning gone" });

      // A local page redirecting to it: the redirect is held back too. Continue, and don't ask again.
      await inPage(`location.href = "http://${insecureHost}/hop", true`);
      await page!.waitFor(`!!${warning}`, { timeoutMs: 20_000, label: "the warning after a redirect" });
      await page!.eval(`(() => {
      const box = document.querySelector('${tab} [data-insecure-always]');
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
      await click(`${tab} [data-insecure-continue]`);
      await waitForValue(async () => ((await url()) === "http://insecure.example/" ? true : undefined), 15_000);
      await page!.waitFor(`!${warning} && !!document.querySelector('${chrome} [data-not-secure]')`, {
        label: "the site over HTTP, not secure",
      });
      await waitForValue(async () =>
        (await apiCall<{ web: { insecureAllowed: string[] } }>("/api/settings")).web.insecureAllowed.includes(
          "insecure.example",
        )
          ? true
          : undefined,
      );
      await shot("insecure-continued.png");

      // Allowed now: the page goes there without a warning.
      await inPage(`location.href = ${JSON.stringify(start)}, true`);
      await waitForValue(async () => ((await url()) === start ? true : undefined), 15_000);
      await inPage(`location.href = "http://insecure.example/?again", true`);
      await waitForValue(async () => ((await url()) === "http://insecure.example/?again" ? true : undefined), 15_000);
      if (await page!.eval<boolean>(`!!${warning}`)) throw new Error("warned about an allowed site");

      // Settings → Privacy and security lists it; removing it warns again.
      await openSettingsAt("browser-privacy");
      await page!.waitFor(`!!document.querySelector('[data-insecure-allowed="insecure.example"]')`, {
        label: "allowed site in settings",
      });
      await shot("insecure-settings.png");
      await click(`[data-insecure-allowed="insecure.example"] button`);
      await page!.waitFor(`!document.querySelector('[data-insecure-allowed="insecure.example"]')`, {
        label: "removed",
      });
      await waitForValue(async () =>
        (await apiCall<{ web: { insecureAllowed: string[] } }>("/api/settings")).web.insecureAllowed.length === 0
          ? true
          : undefined,
      );
      await click(`nav li[data-app-id="${webTabId}"]`);
      await inPage(`location.href = ${JSON.stringify(start)}, true`);
      await waitForValue(async () => ((await url()) === start ? true : undefined), 15_000);
      await inPage(`location.href = "http://insecure.example/", true`);
      await page!.waitFor(`!!${warning}`, { timeoutMs: 20_000, label: "warned again" });
      await click(`${tab} [data-insecure-back]`);
      await page!.waitFor(`!${warning}`, { label: "warning gone" });
    },
  );

  await check(
    "site permissions: prompts, allow this time, remembered per site, in use with stop, screen sharing, settings",
    async () => {
      if (!webTabId) throw new Error("needs the web tab");
      const tab = `[data-web-tab="${webTabId}"]`;
      const bar = chromeFor(tab);
      const inPage = <T>(code: string, gesture = false) => inView<T>(tab, code, gesture);
      const local = site.url.origin.replace("127.0.0.1", "localhost");
      const open = async (origin: string) => {
        await inPage(`location.href = ${JSON.stringify(`${origin}/perm`)}, true`);
        await waitForValue(
          async () =>
            (await inPage<string>(`location.origin === ${JSON.stringify(origin)} && typeof window.camera`)) ===
            "function"
              ? true
              : undefined,
          15_000,
        );
      };
      const result = () => waitForValue(async () => (await inPage<string | null>("window.r")) ?? undefined, 15_000);
      const prompt = (kinds: string) =>
        page!.waitFor(
          `document.querySelector('${tab} [data-permission-prompt]')?.dataset.permissionPrompt === "${kinds}"`,
          {
            label: `a prompt for ${kinds}`,
          },
        );
      const noPrompt = `!document.querySelector('${tab} [data-permission-prompt]')`;
      const waitControls = (attr: "siteInUse" | "siteBlocked", value: string) =>
        page!.waitFor(`document.querySelector('${bar} [data-site-info-button]')?.dataset.${attr} === "${value}"`, {
          label: `address bar ${attr} = "${value}"`,
        });
      const choose = (selector: string, value: string) =>
        page!.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      await click(`nav li[data-app-id="${webTabId}"]`);
      await open(site.url.origin);

      // Not decided yet reads as "prompt", like in Chromium (Electron alone would say "denied").
      const before = await inPage<string>(
        `navigator.permissions.query({ name: "camera" }).then((s) => Notification.permission + " " + s.state)`,
      );
      if (before !== "default prompt") throw new Error(`before deciding, the page sees ${before}`);

      // The camera and microphone: asked in the tab, allowed this time; the address bar shows them in use.
      await inPage("camera()");
      await prompt("camera microphone");
      await shot("site-permission-prompt.png");
      await click(`${tab} [data-permission-answer="once"]`);
      const got = await result();
      if (got !== "ok") {
        const notice = await page!.eval<string | null>(
          `document.querySelector('${tab} [data-permission-notice]')?.innerText ?? null`,
        );
        throw new Error(`getUserMedia didn't get the camera: ${got}${notice ? ` (Rune said: ${notice})` : ""}`);
      }
      await waitControls("siteInUse", "camera microphone");
      await shot("site-permission-in-use.png");

      // "This time" lasts while on the site (a reload keeps it), and isn't remembered.
      await inPage("location.reload(), true");
      await open(site.url.origin);
      await inPage("camera()");
      if ((await result()) !== "ok") throw new Error("allowed this time, the camera was refused after a reload");
      if (!(await page!.eval<boolean>(noPrompt))) throw new Error("asked again on the same visit");
      await waitControls("siteInUse", "camera microphone");

      // Stopped from the address bar: the page's tracks end, as if the device went away.
      await click(`${bar} [data-site-info-button]`);
      await page!.waitFor(`!!document.querySelector('[data-site-info] [data-in-use="camera"]')`, {
        label: "the in-use list",
      });
      await shot("site-permissions-popover.png");
      await click(`[data-stop-permission="camera"]`);
      await waitControls("siteInUse", "microphone");
      const events = await inPage<string[]>("events");
      if (!events.includes("ended:video") || (await inPage<string>(`cam.getVideoTracks()[0].readyState`)) !== "ended")
        throw new Error(`the camera didn't stop: ${JSON.stringify(events)}`);
      await click(`[data-stop-permission="microphone"]`);
      await waitControls("siteInUse", "");
      await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);

      // Another site asks for itself; blocked, it's refused and the address bar says so.
      await open(local);
      await inPage("camera()");
      await prompt("camera microphone");
      await click(`${tab} [data-permission-answer="block"]`);
      if ((await result()) !== "NotAllowedError") throw new Error("a blocked camera wasn't refused");
      await waitControls("siteBlocked", "camera microphone");
      await inPage("location.reload(), true");
      await open(local);
      await inPage("camera()");
      if ((await result()) !== "NotAllowedError") throw new Error("the block wasn't remembered");
      if (!(await page!.eval<boolean>(noPrompt))) throw new Error("a blocked site asked again");
      const blockedState = await inPage<string>(`navigator.permissions.query({ name: "camera" }).then((s) => s.state)`);
      if (blockedState !== "denied") throw new Error(`blocked, the page sees ${blockedState}`);

      // Back on the first site, "this time" is over: it asks again.
      await open(site.url.origin);
      await inPage("camera()");
      await prompt("camera microphone");
      await click(`${tab} [data-permission-answer="dismiss"]`);
      if ((await result()) !== "NotAllowedError") throw new Error("a dismissed prompt allowed the camera");

      // Notifications: no "this time"; allowed for good, then blocked from the address bar.
      await inPage("notify()");
      await prompt("notifications");
      if (await page!.eval<boolean>(`!!document.querySelector('${tab} [data-permission-answer="once"]')`))
        throw new Error('notifications offered "Allow this time"');
      await click(`${tab} [data-permission-answer="allow"]`);
      if ((await result()) !== "granted") throw new Error("notifications weren't allowed");
      // Saved in the site's settings (Settings → Site settings), like a choice made there.
      await waitForValue(async () =>
        (await apiCall<{ browser: { sites: Record<string, Record<string, string>> } }>("/api/settings")).browser.sites[
          "127.0.0.1"
        ]?.notifications === "allow"
          ? true
          : undefined,
      );
      await inPage("location.reload(), true");
      await open(site.url.origin);
      if ((await inPage<string>("Notification.permission")) !== "granted")
        throw new Error("the allow wasn't remembered");
      await click(`${bar} [data-site-info-button]`);
      await page!.waitFor(`!!document.querySelector('[data-site-info] [data-site-info-setting="notifications"]')`, {
        label: "the site's settings",
      });
      await choose('[data-site-info] [data-site-info-setting="notifications"]', "block");
      await page!.waitFor(`!!document.querySelector("[data-site-info-reload]")`, { label: "the reload hint" });
      const now = await waitForValue(async () => {
        const value = await inPage<string>("Notification.permission");
        return value === "denied" ? value : undefined;
      });
      if (now !== "denied") throw new Error(`blocked in the address bar, the page sees ${now}`);
      await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);

      // Screen sharing: the picker lists the workspace's tabs (and the screens, where they can be listed).
      await inPage("share()", true);
      await page!.waitFor(`!!document.querySelector("[data-screen-picker]")`, {
        label: "the screen picker",
        timeoutMs: 20_000,
      });
      const contentsId = await page!.eval<number>(`document.querySelector('${tab} webview').getWebContentsId()`);
      if (await page!.eval<boolean>(`!!document.querySelector("[data-screen-type]")`))
        await click(`[data-screen-type="tab"]`);
      await page!.waitFor(`!!document.querySelector('[data-screen-source="tab:${contentsId}"]')`, {
        label: "this tab in the picker",
      });
      await click(`[data-screen-source="tab:${contentsId}"]`);
      await shot("screen-picker.png");
      await click("[data-screen-share]");
      if ((await result()) !== "ok") throw new Error("sharing the tab failed");
      await waitControls("siteInUse", "screen");
      await click(`${bar} [data-site-info-button]`);
      await page!.waitFor(`!!document.querySelector('[data-stop-permission="screen"]')`, { label: "stop sharing" });
      await click(`[data-stop-permission="screen"]`);
      await waitControls("siteInUse", "");
      if (!(await inPage<string[]>("events")).includes("ended:screen")) throw new Error("sharing didn't stop");
      await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
      await page!.waitFor(`!document.querySelector("[data-site-info]")`, { label: "site settings closed" });
      // Cancelled, the page is refused.
      await inPage("share()", true);
      await page!.waitFor(`!!document.querySelector("[data-screen-picker]")`, { label: "the screen picker again" });
      await click("[data-screen-cancel]");
      const cancelled = await result();
      if (cancelled !== "NotAllowedError") throw new Error(`a cancelled picker: ${cancelled}`);
      // A page can't name a screen or window itself (getUserMedia with Chrome's desktop source): refused, no picker.
      await inPage("desktop()", true);
      if ((await result()) !== "NotAllowedError") throw new Error("getUserMedia shared a desktop source");
      if (await page!.eval<boolean>(`!!document.querySelector("[data-screen-picker]")`))
        throw new Error("a desktop source showed the picker");

      // A private window asks in that window, keeps the answer out of the site's settings, and forgets it once closed.
      const mainId = await page!.eval<string>("window.rune.window.id");
      const privateWindow = async () => {
        await page!.eval(
          `window.dispatchEvent(new KeyboardEvent("keydown", { key: "N", ${mod}: true, shiftKey: true, bubbles: true })), true`,
        );
        const target = await waitForValue(async () => {
          const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string }[];
          return list.find((t) => {
            const id =
              t.type === "page" && t.url.startsWith("app://") ? new URL(t.url).searchParams.get("window") : null;
            return !!id && id !== mainId && id.startsWith("private-");
          });
        }, 20_000);
        const win = await Page.connect(port, 10_000, (t) => t.url === target.url);
        await win.send("Emulation.setFocusEmulationEnabled", { enabled: true });
        await win.waitFor(`document.querySelectorAll("nav li[data-app-id]").length === 1`, {
          label: "the private window's tab",
          timeoutMs: 20_000,
        });
        const tabId = await win.eval<string>(`document.querySelector("nav li[data-app-id]").dataset.appId`);
        await win.eval(
          `window.__runeRpc("page.navigate", { tabId: ${JSON.stringify(tabId)}, url: ${JSON.stringify(`${site.url.origin}/perm`)} })`,
        );
        await win.waitFor(`document.querySelector("webview")?.getURL?.().endsWith("/perm")`, {
          label: "the private page",
          timeoutMs: 20_000,
        });
        const id = new URL(target.url).searchParams.get("window")!;
        const inPrivate = <T>(code: string) =>
          win.eval<T>(`document.querySelector("webview").executeJavaScript(${JSON.stringify(code)})`);
        await waitForValue(async () =>
          (await inPrivate<string>("typeof window.notify")) === "function" ? true : undefined,
        );
        return { win, id, inPrivate };
      };
      const closePrivate = async (p: { win: Page; id: string }) => {
        await p.win.eval("setTimeout(() => window.rune.window.close(), 50), true");
        await waitForValue(async () => {
          const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { url: string }[];
          return list.some((t) => t.url.includes(`window=${p.id}`)) ? undefined : true;
        }, 15_000);
        p.win.close();
      };
      const priv = await privateWindow();
      // Blocked in normal windows (above), inherited: refused without asking.
      if ((await priv.inPrivate<string>("Notification.permission")) !== "denied")
        throw new Error("a private window didn't keep a normal window's block");
      await priv.inPrivate("navigator.geolocation.getCurrentPosition(() => {}, () => {}), true");
      await priv.win.waitFor(
        `document.querySelector("[data-permission-prompt]")?.dataset.permissionPrompt === "location"`,
        {
          label: "the prompt in the private window",
        },
      );
      if (await page!.eval<boolean>(`!!document.querySelector("[data-permission-prompt]")`))
        throw new Error("a private window's prompt showed in the main window");
      await priv.win.screenshot(join(outDir, "site-permission-private.png"));
      await priv.win.eval(`document.querySelector('[data-permission-answer="allow"]').click(), true`);
      await waitForValue(async () =>
        (await priv.inPrivate<string>(`navigator.permissions.query({ name: "geolocation" }).then((s) => s.state)`)) ===
        "granted"
          ? true
          : undefined,
      );
      const saved = (await apiCall<{ browser: { sites: Record<string, Record<string, string>> } }>("/api/settings"))
        .browser.sites["127.0.0.1"];
      if (saved?.location) throw new Error(`a private window's answer was saved: ${JSON.stringify(saved)}`);
      await closePrivate(priv);
      const again = await privateWindow();
      const after = await again.inPrivate<string>(
        `navigator.permissions.query({ name: "geolocation" }).then((s) => s.state)`,
      );
      if (after !== "prompt") throw new Error(`a closed private window's answer was kept: ${after}`);
      await closePrivate(again);

      // Settings → Site settings has both sites' choices; resetting one makes it ask again.
      await openSettingsAt("browser-sites");
      const siteRow = (host: string) => `[data-site-row="${host}"]`;
      await page!.waitFor(
        `document.querySelector('${siteRow("127.0.0.1")}')?.innerText.includes("Notifications blocked") && document.querySelector('${siteRow("localhost")}')?.innerText.includes("Camera blocked")`,
        { label: "both sites in Site settings" },
      );
      await shot("site-permissions-settings.png");
      for (const host of ["localhost", "127.0.0.1"]) {
        await click(siteRow(host));
        await page!.waitFor(`!!document.querySelector('[data-site-details="${host}"]')`, {
          label: `${host}'s settings`,
        });
        await click(`[data-site-details="${host}"] [data-reset-site]`);
        await waitForValue(async () =>
          (await apiCall<{ browser: { sites: Record<string, unknown> } }>("/api/settings")).browser.sites[host]
            ? undefined
            : true,
        );
        await click("[data-site-back]");
      }
      await click(`nav li[data-app-id="${webTabId}"]`);
      await open(local);
      await inPage("camera()");
      await prompt("camera microphone");
      await click(`${tab} [data-permission-answer="dismiss"]`);
      await result();
      return `camera and microphone this time, stopped from the address bar, blocked on another site, notifications allowed then blocked, a tab shared and stopped, refused when cancelled, desktop sources refused, a private window's answer forgotten`;
    },
  );

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
    // So can the sites it asks for when it needs them.
    const optionalSite = `[data-extension-details-page="${id}"] [data-extension-site="https://example.com/*"]`;
    const siteAllowed = `window.rune.extensions.list().then((r) => r.extensions.find((e) => e.id === "${id}").optionalSiteAccess.find((s) => s.pattern === "https://example.com/*")?.allowed)`;
    await page!.waitFor(`!!document.querySelector('${optionalSite} [role="switch"][aria-checked="false"]')`, {
      label: "optional site, not given",
    });
    await click(`${optionalSite} [role="switch"]`);
    await page!.waitFor(`${siteAllowed}.then((a) => a === true)`, { label: "optional site given" });
    await page!.waitFor(`!!document.querySelector('${optionalSite} [role="switch"][aria-checked="true"]')`, {
      label: "its switch on",
    });
    await click(`${optionalSite} [role="switch"]`);
    await page!.waitFor(`${siteAllowed}.then((a) => a === false)`, { label: "optional site taken back" });
    await page!.waitFor(`!!document.querySelector('${optionalSite} [role="switch"][aria-checked="false"]')`, {
      label: "its switch off",
    });
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
    // One puzzle button at the end of the address, no separate pinned buttons; the top row is the window's
    // buttons and navigation.
    const topRow = await page!.eval<{ order: string[]; separate: number; puzzles: number }>(`(() => {
      const nav = document.querySelector('${chromeFor(tab)} [data-nav-row]');
      const address = document.querySelector('${chromeFor(tab)} [data-address-bar]');
      const pick = (el) => el.closest("[data-window-controls]") ? el.dataset.windowControl : el.matches("[data-sidebar-toggle]") ? "sidebar" : el.matches("[data-back]") ? "back" : el.matches("[data-forward]") ? "forward" : el.matches("[data-reload]") ? "reload" : "other:" + el.title;
      return { order: [...nav.querySelectorAll("button")].map(pick), separate: document.querySelectorAll("[data-extension-action]").length, puzzles: address.querySelectorAll("[data-extensions-menu]").length };
    })()`);
    // macOS has its own traffic lights instead of the window's buttons.
    const expectedRow = `${process.platform === "darwin" ? "" : "close,minimize,maximize,"}sidebar,back,forward,reload`;
    if (topRow.order.join() !== expectedRow || topRow.separate || topRow.puzzles !== 1)
      throw new Error(`top row: ${JSON.stringify(topRow)}`);
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
    // It drops down under the address bar, from its left edge (the button is at its far end).
    const under = (popover: string) =>
      page!.eval<{ left: number; top: number; barLeft: number; barBottom: number }>(`(() => {
        const bar = document.querySelector('${chromeFor(tab)} [data-address-bar]').getBoundingClientRect();
        const r = document.querySelector('${popover}').getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), barLeft: Math.round(bar.left), barBottom: Math.round(bar.bottom) };
      })()`);
    const menuAt = await under("[data-extensions-list]");
    if (menuAt.left !== menuAt.barLeft || menuAt.top !== menuAt.barBottom + 6)
      throw new Error(`the menu isn't under the address bar: ${JSON.stringify(menuAt)}`);
    await shot("extensions-menu.png");
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-extensions-list]")`, { label: "menu closed" });

    // Real clicks: the button closes its menu again, and so does a click in the page.
    const realClick = async (point: { x: number; y: number }) => {
      for (const type of ["mousePressed", "mouseReleased"])
        await page!.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    };
    const centerOf = (selector: string) =>
      page!.eval<{ x: number; y: number }>(
        `(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
      );
    const puzzle = await centerOf(`${chromeFor(tab)} [data-extensions-menu]`);
    const inThePage = await centerOf(`${tab} webview`);
    await realClick(puzzle);
    await page!.waitFor(`!!document.querySelector("[data-extensions-list]")`, { label: "menu opened by a click" });
    await realClick(puzzle);
    await page!.waitFor(`!document.querySelector("[data-extensions-list]")`, { label: "menu closed by the button" });
    await Bun.sleep(200);
    if (await page!.eval<boolean>(`!!document.querySelector("[data-extensions-list]")`))
      throw new Error("the button's second click opened the menu again");
    await realClick(puzzle);
    await page!.waitFor(`!!document.querySelector("[data-extensions-list]")`, { label: "menu opened again" });
    await realClick(inThePage);
    await page!.waitFor(`!document.querySelector("[data-extensions-list]")`, { label: "menu closed by the page" });

    // Its declarativeNetRequest rules block (and Rune Browser's own rules, checked above, still work alongside).
    // The extension's rules load in the background: on a slow machine the first fetch can come before them.
    const before = siteSeen.length;
    const blocked = await waitForValue(async () => {
      const result = await inPage<string>(`fetch("/blocked-by-extension").then(() => "loaded", () => "blocked")`);
      return result === "blocked" ? result : undefined;
    }, 15_000).catch(() => "loaded");
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
    const popupAt = await under(`[data-extension-popup="${id}"]`);
    if (popupAt.left !== popupAt.barLeft || popupAt.top !== popupAt.barBottom + 6)
      throw new Error(`the popup isn't under the address bar: ${JSON.stringify(popupAt)}`);
    await shot("extensions-popup.png");
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-extension-popup]")`, { label: "popup closed" });
    // The button closes a popup that's open (without opening the menu), and so does a click in the page.
    const openPopup = async () => {
      await realClick(puzzle);
      await page!.waitFor(`!!document.querySelector('[data-extension-item="${id}"]')`, { label: "menu" });
      await click(`[data-extension-item="${id}"]`);
      await page!.waitFor(`!!document.querySelector('[data-extension-popup="${id}"] webview')`, { label: "popup" });
      // Its page has the focus.
      await page!.waitFor(`!!document.activeElement?.closest("[data-extension-popup]")`, { label: "popup focused" });
    };
    await openPopup();
    await realClick(puzzle);
    await page!.waitFor(`!document.querySelector("[data-extension-popup]")`, { label: "popup closed by the button" });
    await Bun.sleep(200);
    if (await page!.eval<boolean>(`!!document.querySelector("[data-extensions-list]")`))
      throw new Error("closing the popup with the button opened the menu");
    await openPopup();
    await realClick(inThePage);
    await page!.waitFor(`!document.querySelector("[data-extension-popup]")`, { label: "popup closed by the page" });

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
        workerUserAgent?: string;
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
    // Service workers don't get the session's user agent, only the app's: it's plain Chrome too.
    if (typeof stored.workerUserAgent !== "string" || !/Chrome\//.test(stored.workerUserAgent))
      throw new Error(`the worker's user agent: ${JSON.stringify(stored.workerUserAgent)}`);
    if (/Electron|RuneBrowser/i.test(stored.workerUserAgent))
      throw new Error(`the worker's user agent names Electron: ${stored.workerUserAgent}`);
    if (siteSeen.length !== before) throw new Error("a blocked request reached the site");

    // chrome.bookmarks is Rune Browser's bookmarks, and the worker hears about changes.
    const options = `[data-web-tab="${optionsTab}"]`;
    const made = await inView<{ id: string; found: number }>(
      options,
      `chrome.bookmarks.create({ title: "From the extension", url: "https://ext.example/" })
        .then(async (node) => ({ id: node.id, found: (await chrome.bookmarks.search("from the extension")).length }))`,
    );
    if (made.found !== 1) throw new Error(`chrome.bookmarks.search found ${made.found}`);
    const saved = await apiCall<{ children: { children: { id: string; title: string }[] }[] }>("/api/bookmarks");
    if (!saved.children.some((f) => f.children.some((b) => b.id === made.id && b.title === "From the extension")))
      throw new Error("the extension's bookmark isn't in Rune Browser's bookmarks");
    await waitForValue(async () => {
      const value = await inView<string | undefined>(
        options,
        `chrome.storage.local.get("bookmarked").then((r) => r.bookmarked)`,
      );
      return value === "From the extension" ? true : undefined;
    }, 10_000).catch(() => {
      throw new Error("chrome.bookmarks.onCreated didn't reach the extension's worker");
    });
    await inView(options, `chrome.bookmarks.remove(${JSON.stringify(made.id)}).then(() => true)`);

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
    return `content script with Chrome's data, badge ${badge}, popup on ${popupUrl}, shortcut → ${stored.command}, onInstalled: ${stored.installed.reason}, bookmarks with their events, sign-ins by the extension and the dialog`;
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
      // Under the composer, the permissions say so; switched back from their menu.
      await page!.waitFor(`!!document.querySelector('${panel} [data-access-picker][data-full-access]')`, {
        label: "full access shown",
      });
      await click(`${panel} [data-access-picker]`);
      await page!.waitFor(
        `!!document.querySelector('[data-access-menu] [data-menu-item="full"][aria-checked="true"]')`,
        {
          label: "permissions menu",
        },
      );
      await shot("access-menu.png");
      await click('[data-access-menu] [data-menu-item="ask"]');
      await page!.waitFor(`!document.querySelector("[data-full-access]")`, { label: "back to asking" });
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
      "general",
      "appearance",
      "workspace",
      "agent",
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
    await click("[data-preset]", "Ocean");
    await page!.waitFor(`document.querySelector('[data-settings] input[type="color"]')?.value === "#0284c7"`, {
      label: "Ocean accent",
    });
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
      const s = await apiCall<{ agent: { instructions: string }; theme: { accent?: string } }>("/api/settings");
      return s.agent.instructions === "Amounts are in EUR." && s.theme.accent === "#0284c7" ? true : undefined;
    });
    await openSettingsAt("providers");
    const rows = await page!.eval<string[]>(
      `[...document.querySelectorAll("[data-provider-row]")].map((r) => r.dataset.providerRow + ":" + r.querySelector("[data-provider-state]")?.dataset.providerState)`,
    );
    if (rows.length !== 3) throw new Error(`provider rows: ${rows.join(", ")}`);
    await shot("settings-providers.png");
    // Searching shows only the matching rows, from every category, and narrows the sidebar to those categories.
    await type("[data-settings-search]", "third-party cookies");
    await page!.waitFor(
      `[...document.querySelectorAll("[data-search-page]")].filter((p) => p.style.display !== "none").map((p) => p.dataset.searchPage).join() === "browser-privacy" && [...document.querySelectorAll('[data-search-page="browser-privacy"] [data-setting-row]')].filter((r) => r.offsetParent).length === 1`,
      { label: "search: one row, in Privacy and security" },
    );
    const navShown = await page!.eval<string>(
      `[...document.querySelectorAll("[data-settings-nav]")].map((b) => b.dataset.settingsNav).join()`,
    );
    if (navShown !== "browser-privacy") throw new Error(`sidebar while searching: ${navShown}`);
    await shot("settings-search.png");
    await type("[data-settings-search]", "nothing matches this");
    await page!.waitFor(`!!document.querySelector("[data-settings-no-results]")`, { label: "no results" });
    await type("[data-settings-search]", "");
    await page!.waitFor(`!document.querySelector("[data-settings-results]")`, { label: "search cleared" });
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
    // Resetting goes back to Rune's palette (the icon's cream and burnt orange), in light and dark.
    await openSettingsAt("appearance");
    await click("[data-preset]", "Default");
    await click('[data-settings] [role="radio"]', "System");
    const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    const paletteShown = async (mode: Mode) => {
      // The background is the palette's, and the accent field shows the palette's accent as the default.
      await page!.waitFor(
        `getComputedStyle(document.querySelector("[data-content]")).backgroundColor === ${JSON.stringify(rgb(base[mode].bg))} && document.querySelector('[data-settings] input[type="color"]')?.value === ${JSON.stringify(base[mode].accent)}`,
        { label: `Rune's palette (${mode})` },
      );
      await Bun.sleep(300); // let color transitions finish
      await shot(`settings-${mode}.png`);
    };
    const systemMode = (await page!.eval<boolean>(`matchMedia("(prefers-color-scheme: dark)").matches`))
      ? "dark"
      : "light";
    await paletteShown(systemMode);
    const otherMode = systemMode === "dark" ? "light" : "dark";
    await page!.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: otherMode }] });
    try {
      await paletteShown(otherMode);
    } finally {
      await page!.send("Emulation.setEmulatedMedia", { features: [] });
    }
    return `${nav.length} categories; ${rows.join(", ")}; shells ${shells.join(", ")}; background ${await pageBg()} after reset`;
  });

  await check(
    "browser settings: their own section, site controls, permissions, JavaScript, Do Not Track, fonts, zoom, search, clearing data, import",
    async () => {
      let step = "start";
      try {
        return await browserChecks();
      } catch (err) {
        throw new Error(`${step}: ${(err as Error).message}`);
      }
      async function browserChecks() {
        type Browser = {
          search: { engine: string };
          sites: Record<string, Record<string, string>>;
          fonts: { size: number };
          languages: { preferred: string[] };
          zoom: { default: number };
        };
        const savedBrowser = async () => (await apiCall<{ browser: Browser }>("/api/settings")).browser;
        const choose = (selector: string, value: string) =>
          page!.eval(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error("not found: " + ${JSON.stringify(selector)});
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`);
        const confirm = async () => {
          await page!.waitFor(`!!document.querySelector("[data-confirm-dialog]")`, { label: "confirm dialog" });
          await click("[data-confirm-dialog] [data-confirm]");
        };

        // Settings: the browser's settings are a group of their own, apart from Rune Browser's.
        step = "settings groups";
        await openSettingsAt("browser-privacy");
        // Each group's categories, with the parts shown on their pages (General: Search engine…).
        const groups = await page!.eval<Record<string, string[]>>(
          `Object.fromEntries([...document.querySelectorAll('[aria-label="Settings categories"] [data-settings-group]')].map((g) => [g.dataset.settingsGroup, [...g.querySelectorAll("[data-settings-nav]")].flatMap((b) => [b.dataset.settingsNav, ...b.dataset.settingsParts.split(" ")])]))`,
        );
        for (const id of [
          "browser-privacy",
          "browser-sites",
          "browser-search",
          "browser-startup",
          "browser-appearance",
          "browser-languages",
          "browser-downloads",
          "browser-import",
          "browser-reset",
          "extensions",
        ])
          if (!groups.browser?.includes(id)) throw new Error(`browser group: ${JSON.stringify(groups)}`);
        if (groups.agents?.some((id) => id.startsWith("browser-")) || !groups.agents?.includes("agent"))
          throw new Error(`Rune Browser's group: ${JSON.stringify(groups)}`);
        await shot("settings-browser-privacy.png");

        // A web tab on the test site: its feed page loads with JavaScript and sets a cookie.
        step = "feed page";
        const count = await page!.eval<number>(`document.querySelectorAll("nav li").length`);
        await newTab("New web tab");
        const tabId = await page!.waitFor<string>(
          `document.querySelectorAll("nav li").length === ${count + 1} && document.querySelector("nav li:last-of-type").dataset.appId`,
          { label: "web tab" },
        );
        const tab = `[data-web-tab="${tabId}"]`;
        const inPage = <T>(code: string) => inView<T>(tab, code);
        const go = async (url: string, title: string) => {
          await page!.waitFor(`!!document.querySelector('${chromeFor(tab)} [data-address]')`, { label: "address bar" });
          await page!.eval(`(() => {
          const input = document.querySelector('${chromeFor(tab)} [data-address]');
          input.value = ${JSON.stringify(url)};
          input.dispatchEvent(new InputEvent("input", { bubbles: true }));
          input.form.requestSubmit();
          return true;
        })()`);
          await page!.waitFor(
            `document.querySelector('nav li[data-app-id="${tabId}"]')?.innerText.includes(${JSON.stringify(title)})`,
            {
              timeoutMs: 20_000,
              label: title,
            },
          );
        };
        const status = () => inPage<string>(`document.getElementById("status")?.textContent ?? ""`);
        const reloadFeed = async () => {
          await inPage(`location.reload(), true`);
          await Bun.sleep(300);
          await waitForValue(async () =>
            (await inPage<string>(`document.readyState`)) === "complete" ? true : undefined,
          );
        };
        await go(`${site.url.origin}/feed`, "Feed");
        await waitForValue(async () => ((await status()) === "Loaded 2 items" ? true : undefined), 15_000);
        if (!(await inPage<string>(`document.cookie`)).includes("sid=")) throw new Error("no cookie set");
        // Sites can't use notifications until you allow them.
        step = "notifications refused";
        const before = await inPage<string>(`Notification.permission`);
        if (before === "granted") throw new Error("notifications allowed by default");

        // The site controls in the address bar: allow notifications, block JavaScript.
        step = "site controls";
        await click(`${chromeFor(tab)} [data-site-info-button]`);
        await page!.waitFor(`!!document.querySelector('[data-site-info="127.0.0.1"]')`, { label: "site controls" });
        await choose('[data-site-info-setting="notifications"]', "allow");
        await choose('[data-site-info-setting="javascript"]', "block");
        await page!.waitFor(`!!document.querySelector("[data-site-info-reload]")`, { label: "reload to apply" });
        await shot("site-info.png");
        await waitForValue(async () => {
          const b = await savedBrowser();
          return b.sites["127.0.0.1"]?.javascript === "block" && b.sites["127.0.0.1"]?.notifications === "allow"
            ? true
            : undefined;
        });
        await click("[data-site-info-reload]");
        await Bun.sleep(500);
        await waitForValue(async () =>
          (await inPage<string>(`document.readyState`)) === "complete" ? true : undefined,
        );
        await Bun.sleep(800);
        if ((await status()) !== "Loading…") throw new Error(`JavaScript ran although it's blocked: ${await status()}`);
        const after = await inPage<string>(`Notification.permission`);
        if (after !== "granted") throw new Error(`notifications: ${after}`);
        await page!.eval(
          `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`,
        );

        // Back to the default: JavaScript runs again.
        step = "JavaScript back";
        await click(`${chromeFor(tab)} [data-site-info-button]`);
        await page!.waitFor(`!!document.querySelector('[data-site-info="127.0.0.1"]')`, { label: "site controls" });
        await choose('[data-site-info-setting="javascript"]', "");
        await click("[data-site-info-reload]");
        await page!.eval(
          `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`,
        );
        await waitForValue(async () => ((await status()) === "Loaded 2 items" ? true : undefined), 15_000);

        // Do Not Track goes out with requests once it's on.
        step = "Do Not Track";
        await openSettingsAt("browser-privacy");
        await click('[data-do-not-track] [role="switch"]');
        await waitForValue(async () =>
          (await apiCall<{ browser: { privacy: { doNotTrack: boolean } } }>("/api/settings")).browser.privacy.doNotTrack
            ? true
            : undefined,
        );
        await click(`nav li[data-app-id="${tabId}"]`);
        await waitForValue(async () => {
          await reloadFeed();
          return siteSeen.at(-1)?.dnt === "1" ? true : undefined;
        }, 15_000);
        await openSettingsAt("browser-privacy");
        await click('[data-do-not-track] [role="switch"]');

        // Fonts: a bigger default size, in the open page too.
        step = "fonts";
        await openSettingsAt("browser-appearance");
        await choose("[data-font-size]", "20");
        await shot("settings-browser-fonts.png");
        const fontSize = await waitForValue(async () => {
          const size = await inPage<string>(`getComputedStyle(document.body).fontSize`);
          return size === "20px" ? size : undefined;
        }, 10_000).catch(async () => inPage<string>(`getComputedStyle(document.body).fontSize`));
        if (fontSize !== "20px") throw new Error(`font size in the open page: ${fontSize}`);

        // Page zoom: the default applies to open pages; a site's own zoom is remembered.
        step = "page zoom";
        await choose("[data-default-zoom]", "1.25");
        await page!.waitFor(`Math.abs(document.querySelector('${tab} webview').getZoomFactor() - 1.25) < 0.01`, {
          label: "default zoom in the open page",
        });
        await choose("[data-default-zoom]", "1");
        await choose("[data-font-size]", "16");

        // Site settings: all sites (with the test site's cookies), and one site's page.
        step = "site settings";
        await openSettingsAt("browser-sites");
        await page!.waitFor(`!!document.querySelector('[data-site-row="127.0.0.1"]')`, {
          label: "the test site in all sites",
        });
        await shot("settings-browser-sites.png");
        await click('[data-site-row="127.0.0.1"]');
        await page!.waitFor(`!!document.querySelector('[data-site-details="127.0.0.1"]')`, { label: "site details" });
        await page!.waitFor(`document.querySelector('[data-site-details="127.0.0.1"]').innerText.includes("cookie")`, {
          label: "the site's cookies",
        });
        await click("[data-reset-site]");
        await waitForValue(async () => ((await savedBrowser()).sites["127.0.0.1"] ? undefined : true));
        await click("[data-site-back]");

        // Search engine: a custom one is used by the address bar.
        step = "search engine";
        await openSettingsAt("browser-search");
        await choose("[data-search-engine]", "custom");
        await page!.waitFor(`!!document.querySelector("[data-search-url]")`, { label: "custom engine fields" });
        await type("[data-search-name]", "Test search");
        await type("[data-search-url]", `${site.url.origin}/act-done?q=%s`);
        await click(`nav li[data-app-id="${tabId}"]`);
        await go("rune settings", "Searched");
        const results = await inPage<string>(`document.querySelector("h1").textContent`);
        if (results !== "Results for rune settings") throw new Error(`searched: ${results}`);

        // Ctrl+Shift+Delete (macOS Cmd+Shift+Backspace) opens Clear browsing data. For a time range, cookies go
        // for the sites visited in it (Electron can't clear them by time): the test site's, here. Checked on the
        // feed page, whose cookie it is.
        step = "clearing data for a time range";
        await go(`${site.url.origin}/feed`, "Feed");
        await waitForValue(async () => ((await inPage<string>(`document.cookie`)).includes("sid=") ? true : undefined));
        const macKeys = process.platform === "darwin";
        await page!.eval(
          `window.dispatchEvent(new KeyboardEvent("keydown", { key: "${macKeys ? "Backspace" : "Delete"}", code: "${macKeys ? "Backspace" : "Delete"}", ${macKeys ? "metaKey" : "ctrlKey"}: true, shiftKey: true, bubbles: true })), true`,
        );
        await page!.waitFor(`!!document.querySelector('[data-settings-part="browser-clear"] [data-clear-range]')`, {
          label: "Clear browsing data",
        });
        await choose("[data-clear-range]", "hour");
        await click("[data-clear-history]");
        await click("[data-clear-data]");
        await confirm();
        // Back to the defaults (all time, history too) for the clearing below.
        await choose("[data-clear-range]", "all");
        await click("[data-clear-history]");
        await click(`nav li[data-app-id="${tabId}"]`);
        await waitForValue(async () => ((await inPage<string>(`document.cookie`)) === "" ? true : undefined), 10_000);
        await reloadFeed();
        await waitForValue(async () => ((await inPage<string>(`document.cookie`)).includes("sid=") ? true : undefined));

        // Clearing cookies and site data of this workspace.
        step = "clearing data";
        await openSettingsAt("browser-privacy");
        await click("[data-clear-data]");
        await confirm();
        await click(`nav li[data-app-id="${tabId}"]`);
        await waitForValue(async () => ((await inPage<string>(`document.cookie`)) === "" ? true : undefined), 10_000);

        // Import from another browser: the fixture profile's search engine, a site's permission, fonts, languages.
        step = "import";
        await openSettingsAt("browser-import");
        await page!.waitFor(`!!document.querySelector('[data-import-part="search"]:not(:disabled)')`, {
          label: "the profile's settings",
          timeoutMs: 15_000,
        });
        await shot("settings-browser-import.png");
        await click("[data-import-run]");
        const imported = await waitForValue(async () => {
          const b = await savedBrowser();
          return b.search.engine === "google" && b.sites["imported.example.com"]?.notifications === "allow"
            ? b
            : undefined;
        });
        if (imported.fonts.size !== 18 || imported.languages.preferred.join(",") !== "de-DE,en-US")
          throw new Error(`imported: ${JSON.stringify(imported)}`);

        // Reset: the browser settings go back to their defaults.
        step = "reset";
        await openSettingsAt("browser-reset");
        await click("[data-reset-browser]");
        await confirm();
        await waitForValue(async () => {
          const b = await savedBrowser();
          return b.search.engine === "duckduckgo" && !Object.keys(b.sites).length && b.fonts.size === 16
            ? true
            : undefined;
        });
        // Its tab goes, so later checks don't find its pages.
        await apiCall(`/api/apps/${tabId}`, { method: "DELETE" });
        await page!.waitFor(`!document.querySelector('nav li[data-app-id="${tabId}"]')`, { label: "tab closed" });
        return `groups ${Object.keys(groups).join(" / ")}; notifications ${before} → ${after}; JavaScript blocked and back; DNT sent; font ${fontSize}; searched; cookies cleared; imported and reset`;
      }
    },
  );

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
    // The agent sidebar is closed on web tabs until it's opened (Ctrl+I).
    await page!.eval(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ${mod}: true, bubbles: true })), true`,
    );
    const panel = `[data-agent-for="${tab.id}"]`;
    await page!.waitFor(`!!document.querySelector('${panel} [data-composer-plus]')`, { label: "+ button" });
    const source = await apiCall<{ id: string }>(`/api/apps/${tab.id}/sources`, { method: "POST", body: { folder } });
    await page!.waitFor(
      `document.querySelector('${panel} [data-composer-below] [data-source-chip="${source.id}"]')?.innerText.includes("shop-frontend")`,
      { label: "folder chip under the composer" },
    );
    // The + menu adds folders (and attaches files); there's no repository form.
    await click(`${panel} [data-composer-plus]`);
    await page!.waitFor(`!!document.querySelector('[data-composer-menu] [data-menu-item="add-folder"]')`, {
      label: "+ menu",
    });
    await shot("sources.png");
    const items = await page!.eval<string>(`document.querySelector("[data-composer-menu]").innerText`);
    if (/git|repositor/i.test(items)) throw new Error(`the + menu still offers a repository: ${items}`);
    await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
    await page!.waitFor(`!document.querySelector("[data-composer-menu]")`, { label: "menu closed" });
    await click(`${panel} [data-source-chip="${source.id}"] [data-source-remove]`);
    await page!.waitFor(`!document.querySelector('${panel} [data-source-chip]')`, { label: "chip removed" });
    if ((await apiCall<unknown[]>(`/api/apps/${tab.id}/sources`)).length) throw new Error("the source wasn't removed");
    if (!existsSync(join(folder, "src", "cart.ts"))) throw new Error("removing it touched the folder");
    await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
    rmSync(dirname(folder), { recursive: true, force: true });
    return "folder chip under the composer, the + menu adds folders only, removed (folder untouched)";
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
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ${mod}: true, bubbles: true })), true`,
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

  await check("default browser: links and files from other apps open as tabs in the running window", async () => {
    // Settings says whether Rune Browser is the default (runs from source can't be).
    await openSettingsAt("browser-default");
    await page!.waitFor(`document.querySelector("[data-default-browser]")?.dataset.defaultBrowser === "unsupported"`, {
      label: "default browser row",
    });
    await shot("settings-default-browser.png");
    // Opening a link and a web file launches Rune Browser again, as the system does: that copy
    // hands them to this one and quits.
    const dir = mkdtempSync(join(tempDir, "rune-e2e-links-"));
    const file = join(dir, "From another app.html");
    writeFileSync(file, "<title>A file from another app</title><h1>A file</h1>");
    const link = `${site.url.origin}/second?from=another-app`;
    try {
      const second = await launchElectron({ RUNE_USER_DATA_DIR: profile, RUNE_OFFSCREEN: "1" }, [
        "--ozone-platform=headless",
        "--password-store=basic",
        "--",
        link,
        file,
      ]);
      const exit = await Promise.race([second.exited, Bun.sleep(30_000 * TIMEOUT_SCALE).then(() => "running")]);
      if (exit !== 0) {
        second.kill();
        throw new Error(`the second launch didn't hand over its links and quit (${exit})`);
      }
      type Tab = { id: string; kind: string; url?: string };
      let tabs: Tab[] = [];
      const opened = await waitForValue(async () => {
        tabs = await apiCall<Tab[]>("/api/apps");
        const fromLink = tabs.find((a) => a.kind === "web" && a.url === link);
        const fromFile = tabs.find((a) => a.kind === "web" && a.url === fileUrl(file));
        return fromLink && fromFile ? { fromLink, fromFile } : undefined;
      }, 20_000).catch((err) => {
        throw new Error(`${err.message}; the web tabs: ${tabs.map((t) => t.url).join(", ")}`);
      });
      // In order: the last one is on screen.
      await page!.waitFor(
        `document.querySelector('nav li[aria-current="page"]')?.dataset.appId === "${opened.fromFile.id}"`,
        { label: "the file's tab selected" },
      );
      await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${opened.fromLink.id}"]')`, {
        label: "the link's tab in the sidebar",
      });
      // The file's page loaded (its title names the tab).
      await page!.waitFor(
        `document.querySelector('nav li[data-app-id="${opened.fromFile.id}"]')?.textContent.includes("A file from another app")`,
        { label: "the file's page", timeoutMs: 15_000 },
      );
      await shot("default-browser-links.png");
      for (const tab of [opened.fromLink, opened.fromFile]) await apiCall(`/api/apps/${tab.id}`, { method: "DELETE" });
      return "a second launch with a link and a file opened both here, then quit";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Types into the address bar (the one in the sidebar) and presses Enter. */
  const enterAddress = (text: string) =>
    page!.eval(`(() => {
      const input = document.querySelector("[data-address]");
      input.focus();
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.form.requestSubmit();
      return true;
    })()`);
  const addressShows = (text: string) =>
    page!.waitFor(`document.querySelector("[data-address]")?.value === ${JSON.stringify(text)}`, {
      label: `the address bar showing ${text}`,
    });

  await check("internal pages: rune:// and chrome:// open Rune's pages; version, GPU, flags, the list", async () => {
    await newTab("New web tab");
    const blankTab = await page!.waitFor<string>(
      `document.activeElement === document.querySelector("[data-address]") && document.querySelector('nav li[aria-current="page"]')?.dataset.appId`,
      { label: "a new tab's address bar" },
    );
    // chrome:// addresses are rune:// pages; the address bar shows where you are.
    await enterAddress("chrome://version");
    await page!.waitFor(
      `document.querySelector('[data-internal-page="version"] [data-row="version:Chromium"]')?.textContent.length > 3`,
      { label: "rune://version with Chromium's version" },
    );
    await addressShows("rune://version");
    const version = await page!.eval<string>(`document.querySelector('[data-internal-page="version"]').innerText`);
    for (const part of ["Electron", "V8", "User agent", "Profile path"])
      if (!version.includes(part)) throw new Error(`rune://version doesn't show ${part}`);
    if (await page!.eval<boolean>(`!document.querySelector('[data-settings-nav="about"][aria-current="page"]')`))
      throw new Error("About isn't highlighted for an internal page");
    await shot("internal-version.png");

    await enterAddress("rune://gpu");
    await page!.waitFor(`!!document.querySelector('[data-internal-page="gpu"] [data-gpu-feature]')`, {
      timeoutMs: 15_000,
      label: "rune://gpu's feature status",
    });
    await addressShows("rune://gpu");
    await shot("internal-gpu.png");

    // Flags: set one, it's saved for the next start, and asks for a relaunch; reset.
    await enterAddress("about:flags");
    await page!.waitFor(`!!document.querySelector('[data-flag="enable-quic"]')`, { label: "rune://flags" });
    await addressShows("rune://flags");
    await page!.eval(`(() => {
      const select = document.querySelector('[data-flag="enable-quic"] select');
      select.value = "disabled";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await page!.waitFor(
      `document.querySelector('[data-flag="enable-quic"]')?.dataset.flagValue === "disabled" && !!document.querySelector("[data-flags-relaunch]")`,
      { label: "the flag set, and a relaunch asked for" },
    );
    const saved = JSON.parse(readFileSync(join(profile, "flags.json"), "utf8"));
    if (saved["enable-quic"] !== "disabled") throw new Error(`flags.json: ${JSON.stringify(saved)}`);
    await type("[data-flags-search]", "dark mode");
    await page!.waitFor(
      `document.querySelectorAll("[data-flag]").length === 1 && !!document.querySelector('[data-flag="enable-force-dark"]')`,
      { label: "searching the flags" },
    );
    await type("[data-flags-search]", "");
    // The row comes back with its value.
    await page!.waitFor(`document.querySelector('[data-flag="enable-quic"] select')?.value === "disabled"`, {
      label: "the flag's value after the search",
    });
    await shot("internal-flags.png");
    await click("[data-flags-reset]");
    await page!.waitFor(`!document.querySelector("[data-flags-relaunch]")`, { label: "flags reset" });

    // Settings pages: Chromium's sub-pages, and the address of the one shown.
    await enterAddress("chrome://settings/search");
    await page!.waitFor(
      `document.querySelector("[data-settings-shell]")?.dataset.settingsTarget === "browser-search" && !!document.querySelector('[data-settings="general"] [data-settings-part="browser-search"]')`,
      { label: "chrome://settings/search → Settings: General, at Search engine" },
    );
    await addressShows("rune://settings/browser-search");
    await enterAddress("chrome://extensions");
    await page!.waitFor(`document.querySelector("[data-settings-shell]")?.dataset.settingsShell === "extensions"`, {
      label: "chrome://extensions → Settings: Extensions",
    });
    await addressShows("rune://extensions");
    await enterAddress("chrome://history");
    await page!.waitFor(`!!document.querySelector("[data-browsing-history]")`, { label: "chrome://history → History" });
    await addressShows("rune://history");

    // The list of them all; an address that isn't a page lands there.
    await enterAddress("chrome://dino");
    await page!.waitFor(`!!document.querySelector('[data-internal-page="rune-urls"] [data-rune-url="gpu"]')`, {
      label: "rune://rune-urls",
    });
    if (
      await page!.eval<boolean>(
        `document.querySelector('[data-chromium-url="password-manager"]')?.dataset.status !== "not-yet"`,
      )
    )
      throw new Error("chrome://password-manager isn't listed as not there yet");
    await shot("internal-urls.png");
    await click('[data-rune-url="version"] button');
    await page!.waitFor(`!!document.querySelector('[data-internal-page="version"]')`, { label: "a link in the list" });

    // The command bar opens them too.
    await runCommand("chrome://gpu", "route.open");
    await page!.waitFor(`!!document.querySelector('[data-internal-page="gpu"]')`, {
      label: "command bar → rune://gpu",
    });
    await apiCall(`/api/apps/${blankTab}`, { method: "DELETE" });
    return "chrome://, about: and rune:// addresses; version, GPU, flags saved for the next start, settings pages, the list";
  });

  await check("load errors: a certificate that isn't valid warns first, unreachable sites say why", async () => {
    // A site with a self-signed certificate (made with openssl, which CI's machines have).
    const certDir = mkdtempSync(join(tempDir, "rune-e2e-cert-"));
    const made = Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(certDir, "key.pem"),
        "-out",
        join(certDir, "cert.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=127.0.0.1",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const insecure = made.success
      ? Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          tls: {
            cert: readFileSync(join(certDir, "cert.pem"), "utf8"),
            key: readFileSync(join(certDir, "key.pem"), "utf8"),
          },
          fetch: () =>
            new Response(`<!doctype html><title>Self-signed site</title><h1>Behind a self-signed certificate</h1>`, {
              headers: { "Content-Type": "text/html" },
            }),
        })
      : null;
    let tabId: string | undefined;
    try {
      await newTab("New web tab");
      tabId = await page!.waitFor<string>(`document.querySelector('nav li[aria-current="page"]')?.dataset.appId`, {
        label: "the new tab",
      });
      let tab = `[data-web-tab="${tabId}"]`;
      // Nothing listens on this port: refused, with Chromium's words and a Reload button.
      const closed = await new Promise<number>((resolve) => {
        const srv = createServer().listen(0, "127.0.0.1", () => {
          const { port } = srv.address() as { port: number };
          srv.close(() => resolve(port));
        });
      });
      await enterAddress(`http://127.0.0.1:${closed}/`);
      await page!.waitFor(`document.querySelector('${tab} [data-load-error]')?.dataset.loadError === "network"`, {
        timeoutMs: 20_000,
        label: "the error page for a refused connection",
      });
      const refused = await page!.eval<string>(`document.querySelector('${tab} [data-load-error]').innerText`);
      if (!refused.includes("refused to connect") || !refused.includes("ERR_CONNECTION_REFUSED"))
        throw new Error(`the error page says: ${refused}`);
      await addressShows(`127.0.0.1:${closed}`);
      await shot("load-error-network.png");
      if (!insecure) {
        // CI must cover the certificate warning; a computer without openssl only checks the rest.
        const why = `openssl isn't available (${made.stderr.toString().trim()})`;
        if (process.env.CI) throw new Error(why);
        return `${why}: only the network error`;
      }

      // In a new tab, so the warning is its very first page.
      await apiCall(`/api/apps/${tabId}`, { method: "DELETE" });
      await newTab("New web tab");
      tabId = await page!.waitFor<string>(
        `document.querySelector('nav li[aria-current="page"]')?.dataset.appId !== ${JSON.stringify(tabId)} && document.querySelector('nav li[aria-current="page"]')?.dataset.appId`,
        { label: "another new tab" },
      );
      tab = `[data-web-tab="${tabId}"]`;
      const url = `https://127.0.0.1:${insecure.port}/`;
      await enterAddress(url);
      await page!.waitFor(`document.querySelector('${tab} [data-load-error]')?.dataset.loadError === "certificate"`, {
        timeoutMs: 20_000,
        label: "Your connection is not private",
      });
      const warning = await page!.eval<string>(`document.querySelector('${tab} [data-load-error]').innerText`);
      if (!warning.includes("Your connection is not private") || !warning.includes("NET::ERR_CERT"))
        throw new Error(`the warning says: ${warning}`);
      await page!.waitFor(`document.querySelector("[data-address-bar]")?.dataset.addressIcon === "triangle-alert"`, {
        label: "the address bar warns",
      });
      await click(`${tab} [data-load-error-advanced]`);
      await page!.waitFor(
        `document.querySelector('${tab} [data-certificate-details]')?.innerText.includes("127.0.0.1")`,
        { label: "the certificate's details under Advanced" },
      );
      await shot("load-error-certificate.png");
      await click(`${tab} [data-load-error-proceed]`);
      await page!.waitFor(
        `!document.querySelector('${tab} [data-load-error]') && document.querySelector('nav li[data-app-id="${tabId}"]')?.innerText.includes("Self-signed site")`,
        { timeoutMs: 20_000, label: "the site, after Proceed" },
      );
      // Still marked as not secure while it's open.
      await page!.waitFor(`document.querySelector("[data-address-bar]")?.dataset.addressIcon === "triangle-alert"`, {
        label: "the address bar still warns",
      });
      return "refused connection, self-signed certificate: warning, details, proceed";
    } finally {
      if (tabId) await apiCall(`/api/apps/${tabId}`, { method: "DELETE" }).catch(() => {});
      insecure?.stop(true);
      rmSync(certDir, { recursive: true, force: true });
    }
  });

  await check(
    "bookmarks: the star and Ctrl+D, the bar and menu, address and command bar, the page, import from Chrome",
    async () => {
      type Node = { id: string; title: string; url?: string; children?: Node[] };
      const tree = () => apiCall<Node>("/api/bookmarks");
      const all = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(all)];
      const find = async (title: string) => all(await tree()).find((n) => n.title === title);
      const folderOf = async (id: string) => (await tree()).children!.find((f) => all(f).some((n) => n.id === id))?.id;
      const tabApp = await apiCall<{ id: string }>("/api/apps", {
        method: "POST",
        body: { kind: "web", url: `${site.url.origin}/second` },
      });
      await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${tabApp.id}"]')`, { label: "tab" });
      await click(`nav li[data-app-id="${tabApp.id}"]`);
      const tab = `[data-web-tab="${tabApp.id}"]`;
      await page!.waitFor(
        `document.querySelector('nav li[data-app-id="${tabApp.id}"]')?.innerText.includes("Second page")`,
        {
          timeoutMs: 20_000,
          label: "page loaded",
        },
      );
      const star = `[data-address-bar] [data-bookmark-star]`;
      await page!.waitFor(`document.querySelector('${star}')?.dataset.bookmarkStar === "off"`, { label: "empty star" });

      // The star bookmarks the page, and its popover renames it right away.
      await click(star);
      await page!.waitFor(`document.querySelector("[data-bookmark-editor]")?.innerText.includes("Bookmark added")`, {
        label: "popover",
      });
      await type("[data-bookmark-name]", "My second page");
      await shot("bookmark-popover.png");
      await click("[data-bookmark-done]");
      await page!.waitFor(`!document.querySelector("[data-bookmark-editor]")`, { label: "popover closed" });
      const second = await waitForValue(async () => {
        const n = await find("My second page");
        return n?.url === `${site.url.origin}/second` ? n : undefined;
      }).catch(async () => {
        throw new Error(`the star's bookmark wasn't renamed: ${JSON.stringify(await tree())}`);
      });
      if ((await folderOf(second.id)) !== "1") throw new Error("the first bookmark isn't on the bookmarks bar");
      await page!.waitFor(`document.querySelector('${star}')?.dataset.bookmarkStar === "on"`, { label: "filled star" });

      // Ctrl+D in the page bookmarks it (and doesn't pin the tab any more); the popover moves it.
      const press = (keyCode: string, modifiers: string[]) =>
        page!.eval(`(() => {
          const view = document.querySelector('${tab} webview');
          view.focus();
          for (const type of ["keyDown", "keyUp"]) view.sendInputEvent({ type, keyCode: ${JSON.stringify(keyCode)}, modifiers: ${JSON.stringify(modifiers)} });
          return true;
        })()`);
      await page!.eval(`document.querySelector('${tab} webview').loadURL("${site.url.origin}/").catch(() => {}), true`);
      await page!.waitFor(`document.querySelector('${star}')?.dataset.bookmarkStar === "off"`, {
        timeoutMs: 20_000,
        label: "another page",
      });
      await press("D", [modKey]);
      await page!.waitFor(`!!document.querySelector("[data-bookmark-editor]")`, { label: "popover from Ctrl+D" });
      await page!.eval(`(() => {
        const select = document.querySelector("[data-bookmark-folder]");
        select.value = "2";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      await click("[data-bookmark-done]");
      const testSite = await waitForValue(async () => {
        const n = await find("Test site");
        return n && (await folderOf(n.id)) === "2" ? n : undefined;
      }).catch(async () => {
        throw new Error(`Ctrl+D's bookmark isn't in other bookmarks: ${JSON.stringify(await tree())}`);
      });
      if (
        await page!.eval<boolean>(
          `document.querySelector('nav li[data-app-id="${tabApp.id}"]').hasAttribute("data-pinned")`,
        )
      )
        throw new Error("Ctrl+D pinned the tab");

      // The bookmarks bar, from the command bar: the bar's bookmark, and other bookmarks at its end.
      await runCommand("show the bookmarks bar", "bookmarks.bar");
      await page!.waitFor(`!!document.querySelector('[data-bookmarks-bar] [data-bar-item="${second.id}"]')`, {
        label: "bookmark on the bar",
      });
      await click(`[data-bookmarks-bar] [data-bar-item="2"]`);
      await page!.waitFor(`!!document.querySelector('[data-bookmarks-menu] [data-bookmark-item="${testSite.id}"]')`, {
        label: "other bookmarks' menu",
      });
      await shot("bookmarks-bar.png");
      await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
      await page!.waitFor(`!document.querySelector("[data-bookmarks-menu]")`, { label: "menu closed" });
      // Clicking one on the bar opens it in the tab.
      await click(`[data-bookmarks-bar] [data-bar-item="${second.id}"]`);
      await page!.waitFor(`document.querySelector('${star}')?.dataset.bookmarkStar === "on"`, {
        timeoutMs: 20_000,
        label: "opened from the bar",
      });

      // The menu in the sidebar's top row.
      await fromMenu("", "bookmarks");
      await page!.waitFor(`!!document.querySelector('[data-bookmarks-menu] [data-bookmark-item="${second.id}"]')`, {
        label: "bookmarks menu",
      });
      await shot("bookmarks-menu.png");
      await page!.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`);
      await page!.waitFor(`!document.querySelector("[data-bookmarks-menu]")`, { label: "menu closed again" });

      // The address bar suggests bookmarks while typing; so does the command bar.
      await page!.eval(`(() => {
        const input = document.querySelector("[data-address]");
        input.focus();
        input.value = "my sec";
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return true;
      })()`);
      await page!.waitFor(`!!document.querySelector('[data-suggestions] [data-suggestion="bookmark:${second.id}"]')`, {
        label: "bookmark suggested",
      });
      // A page that's bookmarked and in history is one row, the bookmark's (history answers a moment later).
      await new Promise((r) => setTimeout(r, 300));
      const urls = await page!.eval<string[]>(
        `[...document.querySelectorAll("[data-suggestions] [data-suggestion-url]")].map((e) => e.dataset.suggestionUrl)`,
      );
      if (new Set(urls).size !== urls.length) throw new Error(`the same page suggested twice: ${urls.join(", ")}`);
      await page!.eval(
        `document.querySelector("[data-address]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`,
      );
      await page!.eval(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ${mod}: true, bubbles: true })), true`,
      );
      await page!.waitFor(`!!document.querySelector("[data-command-bar] input")`, { label: "command bar" });
      await type("[data-command-bar] input", "my second page");
      await page!.waitFor(`!!document.querySelector('[data-command-bar] [data-command="bookmark:${second.id}"]')`, {
        label: "bookmark in the command bar",
      });
      await page!.eval(
        `document.querySelector("[data-command-bar] input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`,
      );

      // The bookmarks page (Ctrl+Shift+O): import from the fixture Chrome profile.
      await page!.eval(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "${process.platform === "darwin" ? "b" : "O"}", code: "Key${process.platform === "darwin" ? "B" : "O"}", ${mod}: true, ${process.platform === "darwin" ? "altKey" : "shiftKey"}: true, bubbles: true })), true`,
      );
      await page!.waitFor(`!!document.querySelector("[data-bookmarks-page]")`, { label: "bookmarks page" });
      // Settings → Browser → Import has the same import (it opens the bookmarks page's).
      await openSettingsAt("browser-import");
      await click("[data-import-bookmarks]");
      await page!.waitFor(`!!document.querySelector("[data-bookmarks-page]")`, { label: "bookmarks page again" });
      await page!.waitFor(`!!document.querySelector("[data-bookmarks-import-dialog] [data-import-source]")`, {
        label: "Chrome's profile offered",
      });
      await shot("bookmarks-import.png");
      await click("[data-bookmarks-import-dialog] [data-import-source]");
      await page!.waitFor(`!document.querySelector("[data-bookmarks-import-dialog]")`, { label: "imported" });
      const imported = await waitForValue(async () => {
        const root = await tree();
        const bar = root.children!.find((f) => f.id === "1")!;
        const folder = bar.children!.find((n) => n.title === "Imported from Chromium");
        return folder?.children?.some((n) => n.title === "Chrome docs") ? folder : undefined;
      }).catch(async () => {
        throw new Error(`Chrome's bookmarks didn't come in: ${JSON.stringify(await tree())}`);
      });
      if (!(await find("An essay"))) throw new Error("other bookmarks weren't imported");
      await page!.waitFor(`!!document.querySelector('[data-bookmarks-page] [data-bookmark-row="${imported.id}"]')`, {
        label: "imported folder on the page",
      });
      await shot("bookmarks-page.png");

      // Dragged to the top of the bar, before "My second page".
      await page!.eval(`(() => {
        const from = document.querySelector('[data-bookmark-row="${imported.id}"]');
        const to = document.querySelector('[data-bookmark-row="${second.id}"]');
        const dataTransfer = new DataTransfer();
        from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
        const r = to.getBoundingClientRect();
        const at = { bubbles: true, cancelable: true, dataTransfer, clientX: r.left + 20, clientY: r.top + 3 };
        to.dispatchEvent(new DragEvent("dragover", at));
        to.dispatchEvent(new DragEvent("drop", at));
        from.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
        return true;
      })()`);
      await waitForValue(async () => {
        const bar = (await tree()).children!.find((f) => f.id === "1")!;
        return bar.children![0]?.id === imported.id ? true : undefined;
      }).catch(() => {
        throw new Error("dragging didn't reorder the bar");
      });

      // Renamed in place.
      await click(`[data-bookmark-row="${second.id}"] [data-bookmark-edit]`);
      await page!.waitFor(`!!document.querySelector('[data-bookmark-editing="${second.id}"]')`, { label: "editing" });
      await type(`[data-bookmark-editing="${second.id}"] [data-edit-name]`, "Second, renamed");
      await page!.eval(`document.querySelector('[data-bookmark-editing="${second.id}"]').requestSubmit(), true`);
      await waitForValue(async () => ((await find("Second, renamed")) ? true : undefined));

      // Search finds them in every folder; Delete removes one.
      await type("[data-bookmarks-search]", "essay");
      const essay = (await find("An essay"))!;
      await page!.waitFor(`!!document.querySelector('[data-bookmark-row="${essay.id}"]')`, { label: "search result" });
      await page!.eval(`(() => {
        const row = document.querySelector('[data-bookmark-row="${essay.id}"]');
        row.focus();
        row.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
        return true;
      })()`);
      await waitForValue(async () => ((await find("An essay")) ? undefined : true)).catch(() => {
        throw new Error("Delete didn't remove the bookmark");
      });
      await type("[data-bookmarks-search]", "");

      // Turned off again, for the checks after this one.
      await runCommand("hide the bookmarks bar", "bookmarks.bar");
      await page!.waitFor(`!document.querySelector("[data-bookmarks-bar]")`, { label: "bar hidden" });
      return "star, Ctrl+D, popover, bar, menu, suggestions, command bar, import, drag, rename, search, delete";
    },
  );

  await check("windows: new and private windows, tabs moved out and back, a closed window reopened", async () => {
    const mainId = await page!.eval<string>("window.rune.window.id");
    /** Closes a window from its own page: a moment later, so the answer gets back before the page is gone. */
    const closeWindow = (win: Page) => win.eval("setTimeout(() => window.rune.window.close(), 50), true");
    /** The page of another window, once it's open (found by the window id in its URL). */
    const windowPage = async (match: (id: string) => boolean, label: string) => {
      const target = await waitForValue(async () => {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string }[];
        return list.find((t) => {
          const id = t.type === "page" && t.url.startsWith("app://") ? new URL(t.url).searchParams.get("window") : null;
          return !!id && id !== mainId && match(id);
        });
      }, 20_000).catch(() => {
        throw new Error(`no ${label} opened`);
      });
      const win = await Page.connect(port, 10_000, (t) => t.url === target.url);
      await win.send("Runtime.enable");
      win.on("Runtime.exceptionThrown", (e) =>
        pageErrors.push(`${label}: ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text}`),
      );
      await win.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await win.waitFor(`!!document.querySelector("[data-sidebar-footer] [data-more-menu]")`, {
        label: `${label} to load`,
      });
      return { win, id: new URL(target.url).searchParams.get("window")! };
    };
    const windowGone = (id: string) =>
      waitForValue(async () => {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { url: string }[];
        return list.some((t) => t.url.includes(`window=${id}`)) ? undefined : true;
      }, 15_000);
    const tabsIn = (win: Page) =>
      win.eval<string[]>(`[...document.querySelectorAll("nav li[data-app-id]")].map((li) => li.dataset.appId)`);
    const keys = (win: Page, key: string, shift = false) =>
      win.eval(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, ${mod}: true, shiftKey: ${shift}, bubbles: true })), true`,
      );
    const opened: Page[] = [];
    try {
      // Ctrl+N: a normal window with a new tab of its own.
      await keys(page!, "n");
      const second = await windowPage((id) => id.startsWith("w-"), "new window");
      opened.push(second.win);
      await second.win.waitFor(`document.querySelectorAll("nav li[data-app-id]").length === 1`, {
        label: "the new window's new tab",
      });
      const [secondTab] = await tabsIn(second.win);
      if ((await tabsIn(page!)).includes(secondTab!)) throw new Error("the new window's tab is in the first one too");
      if (await second.win.eval<boolean>(`!!document.querySelector("[data-private-badge]")`))
        throw new Error("a normal window is marked private");

      // Ctrl+Shift+N: a private window, marked as such, without agents, apps or workspaces.
      await keys(page!, "N", true);
      const priv = await windowPage((id) => id.startsWith("private-"), "private window");
      opened.push(priv.win);
      await priv.win.waitFor(`document.querySelectorAll("nav li[data-app-id]").length === 1`, {
        label: "the private window's new tab",
      });
      const privateUi = await priv.win.eval<Record<string, unknown>>(`({
          badge: !!document.querySelector("[data-private-badge]"),
          tinted: document.querySelector("nav[data-sidebar]")?.hasAttribute("data-private-window"),
          agent: !!document.querySelector("[data-agent-show]"),
          workspaces: !!document.querySelector("[data-workspace-bar]"),
          title: document.title,
        })`);
      if (!privateUi.badge || !privateUi.tinted) throw new Error(`not marked private: ${JSON.stringify(privateUi)}`);
      if (privateUi.agent || privateUi.workspaces)
        throw new Error(`agent or workspaces shown: ${JSON.stringify(privateUi)}`);
      if (!String(privateUi.title).includes("Private")) throw new Error(`title: ${privateUi.title}`);
      // Its "New tab" menu has no apps; Ctrl+I (the agent) does nothing there.
      await priv.win.eval(`document.querySelector("[data-new-tab]").click(), true`);
      await priv.win.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "private new tab menu" });
      const menu = await priv.win.eval<string>(`document.querySelector("[data-context-menu]").innerText`);
      if (menu.includes("New app") || !menu.includes("New private window"))
        throw new Error(`private New tab menu: ${menu}`);
      await priv.win.eval(
        `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true`,
      );
      await priv.win.screenshot(join(outDir, "window-private.png"));

      // A page in it sets a cookie; agents can't use the tab.
      const [privTab] = await tabsIn(priv.win);
      await priv.win.eval(
        `window.__runeRpc("page.navigate", { tabId: ${JSON.stringify(privTab)}, url: ${JSON.stringify(`${site.url.origin}/second`)} })`,
      );
      await priv.win.waitFor(`document.querySelector("webview")?.getURL?.().includes("/second")`, {
        label: "private page to load",
        timeoutMs: 20_000,
      });
      const partition = await priv.win.eval<string>(`document.querySelector("webview").getAttribute("partition")`);
      if (partition !== "persist:private-web") throw new Error(`private tab's session: ${partition}`);
      await priv.win.eval(
        `document.querySelector("webview").executeJavaScript('document.cookie = "private=1; max-age=3600"; document.cookie')`,
      );
      const refused = await apiCall(`/api/apps/${privTab}/chat`, { method: "POST", body: { prompt: "hi" } }).then(
        () => false,
        (err: Error) => err.message.includes("private"),
      );
      if (!refused) throw new Error("an agent started in a private tab");

      // Extensions run there only when allowed.
      const extensionsInPrivate = () =>
        priv.win.eval<number>(
          `window.rune.extensions.prepare("private").then(() => window.rune.extensions.actions("private", null)).then((a) => a.length)`,
        );
      const ext = (await page!.eval<{ extensions: { id: string }[] }>("window.rune.extensions.list()")).extensions[0];
      if (ext) {
        if ((await extensionsInPrivate()) !== 0) throw new Error("an extension runs in private windows unasked");
        await page!.eval(`window.rune.extensions.setAllowPrivate(${JSON.stringify(ext.id)}, true)`);
        await waitForValue(async () => ((await extensionsInPrivate()) > 0 ? true : undefined));
        await page!.eval(`window.rune.extensions.setAllowPrivate(${JSON.stringify(ext.id)}, false)`);
        await waitForValue(async () => ((await extensionsInPrivate()) === 0 ? true : undefined));
      }

      // Closing it deletes its tabs and its cookies.
      await closeWindow(priv.win);
      await windowGone(priv.id);
      await waitForValue(async () =>
        (await apiCall<{ private: boolean }[]>("/api/apps")).some((t) => t.private) ? undefined : true,
      );
      await keys(page!, "N", true);
      const again = await windowPage((id) => id.startsWith("private-") && id !== priv.id, "second private window");
      opened.push(again.win);
      await again.win.waitFor(`document.querySelectorAll("nav li[data-app-id]").length === 1`, {
        label: "the second private window's tab",
      });
      const [againTab] = await tabsIn(again.win);
      await again.win.eval(
        `window.__runeRpc("page.navigate", { tabId: ${JSON.stringify(againTab)}, url: ${JSON.stringify(`${site.url.origin}/second`)} })`,
      );
      await again.win.waitFor(`document.querySelector("webview")?.getURL?.().includes("/second")`, {
        label: "page in the second private window",
        timeoutMs: 20_000,
      });
      const cookie = await again.win.eval<string>(
        `document.querySelector("webview").executeJavaScript("document.cookie")`,
      );
      if (cookie.includes("private=1")) throw new Error(`a closed private window's cookie is still there: ${cookie}`);
      await closeWindow(again.win);
      await windowGone(again.id);

      // "Move to new window" from a tab's menu (a window's only tab has nothing to move from): it opens there, and leaves this one.
      const staying = await apiCall<{ id: string }>("/api/apps", {
        method: "POST",
        body: { kind: "web", url: `${site.url.origin}/`, windowId: mainId },
      });
      const moving = await apiCall<{ id: string }>("/api/apps", {
        method: "POST",
        body: { kind: "web", url: `${site.url.origin}/second`, windowId: mainId },
      });
      await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${moving.id}"]')`, { label: "tab to move" });
      await page!.eval(`(() => {
          const li = document.querySelector('nav li[data-app-id="${moving.id}"]');
          const r = li.getBoundingClientRect();
          li.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 10 }));
          return true;
        })()`);
      await page!.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "tab menu" });
      await click("[data-context-menu] button", "Move to new window");
      const third = await windowPage((id) => id.startsWith("w-") && id !== second.id, "window of the moved tab");
      opened.push(third.win);
      await third.win.waitFor(`!!document.querySelector('nav li[data-app-id="${moving.id}"][aria-current="page"]')`, {
        label: "the moved tab, shown in its new window",
      });
      await page!.waitFor(`!document.querySelector('nav li[data-app-id="${moving.id}"]')`, {
        label: "the moved tab gone from the first window",
      });

      // And back, by dragging it onto the first window's tabs: its window had only it, so it closes.
      await page!.eval(`(() => {
          const target = document.querySelector("nav li[data-app-id]");
          const dt = new DataTransfer();
          dt.setData("application/x-rune-tab", ${JSON.stringify(moving.id)});
          const r = target.getBoundingClientRect();
          const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.bottom - 2 };
          target.dispatchEvent(new DragEvent("dragover", at));
          target.dispatchEvent(new DragEvent("drop", at));
          return true;
        })()`);
      await page!.waitFor(`!!document.querySelector('nav li[data-app-id="${moving.id}"]')`, {
        label: "the tab dropped back into the first window",
      });
      await windowGone(third.id);

      // A closed window comes back with its tabs (Ctrl+Shift+T, as it's what was closed last).
      await closeWindow(second.win);
      await windowGone(second.id);
      await keys(page!, "T", true);
      const reopened = await windowPage((id) => id === second.id, "reopened window");
      opened.push(reopened.win);
      await reopened.win.waitFor(`!!document.querySelector('nav li[data-app-id="${secondTab}"]')`, {
        label: "the reopened window's tab",
      });
      await closeWindow(reopened.win);
      await windowGone(second.id);
      for (const id of [moving.id, staying.id]) await apiCall(`/api/apps/${id}`, { method: "DELETE" });
      return "Ctrl+N, Ctrl+Shift+N (marked, no agents, extensions when allowed, cookies gone), moved out by menu and back by drag, reopened";
    } finally {
      for (const win of opened) win.close();
    }
  });

  await check("no uncaught errors in the renderer", async () => {
    // Expected noise from Electron itself isn't an app bug.
    const real = pageErrors.filter((e) => !/Electron Security Warning/.test(e));
    if (real.length) throw new Error(real.slice(0, 5).join("\n"));
  });
} finally {
  page?.close();
  site.stop(true);
  insecureSite.stop(true);
  electron.kill();
  await electron.exited;
  // Windows may still hold a file of the profile for a moment after Electron exits (EBUSY).
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    console.warn(`Couldn't remove ${profile}:`, err);
  }
  rmSync(browserDir, { recursive: true, force: true });
  rmSync(downloadsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${outDir}/`);
if (skippedShots.length) console.log(`(window wasn't painting, skipped screenshots: ${skippedShots.join(", ")})`);

// The checks build on each other (one slow step fails the ones after it), so a
// failed run is run again as a whole, on a fresh profile. What passes then was flaky.
const retriesIndex = args.indexOf("--retries");
const retries = retriesIndex === -1 ? 0 : Number(args[retriesIndex + 1]) || 0;
if (failed.length && retries > 0) {
  console.log(
    `\nRunning the e2e checks again (${failed.length} failed; ${retries} ${retries === 1 ? "try" : "tries"} left)…\n`,
  );
  const rest = args.filter((_, i) => i !== retriesIndex && i !== retriesIndex + 1);
  const again = Bun.spawn([process.execPath, import.meta.path, ...rest, "--retries", String(retries - 1)], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await again.exited;
  if (code === 0)
    reportFlaky(
      "e2e checks",
      failed.map((r) => `${r.name} — ${r.detail}`.slice(0, 300)),
    );
  process.exit(code);
}
process.exit(failed.length ? 1 : 0);
