// The README's screenshots (docs/screenshots/), taken of the real browser: the built app is launched headless
// on a throwaway profile, with the settings a new profile starts with, and driven over the DevTools protocol.
// The website in page-changes.png is the website's demo recipe site (apps/landing/scripts/demo-site.html),
// served here under a made-up host, and its page changes are added through the app's own API, as the agent
// would add them.
//
//   bun run build          (once, or after changing the browser)
//   bun run screenshots
//
// Needs openssl (for the demo site's certificate).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchElectron } from "./electron";
import { Page } from "./lib/cdp";

const here = import.meta.dir;
const out = join(here, "../docs/screenshots");
const only = process.argv[2];
const HOST = "www.slowcooked.blog";
const PAGE = `https://${HOST}/recipes/weeknight-tomato-soup`;
/** The window's size. The changes menu is placed wrongly when the app is zoomed, so these are 1x screenshots. */
const SIZE = { width: 1400, height: 900 };
const CHANGES = [
  { title: "Hide the ads", action: "hide", selector: ".ad, .promo" },
  { title: "Hide the life story", action: "hide", selector: ".story, .jump, .meta" },
  { title: "Hide the newsletter pop-up", action: "hide", selector: ".newsletter" },
  { title: "Larger ingredients", action: "style", selector: ".card li", value: "font-size: 20px; line-height: 1.8" },
];

if (!(await Bun.file(join(here, "../dist/electron/main.cjs")).exists())) {
  console.error("No build found — run `bun run build` first.");
  process.exit(1);
}

// The demo site, over HTTPS: Rune Browser warns before showing a site over plain HTTP.
const certs = mkdtempSync(join(tmpdir(), "rune-shots-cert-"));
const profile = mkdtempSync(join(tmpdir(), "rune-shots-"));
await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${join(certs, "key.pem")} -out ${join(certs, "cert.pem")} -days 2 -subj ${`/CN=${HOST}`} -addext ${`subjectAltName=DNS:${HOST}`}`.quiet();
const html = readFileSync(join(here, "../../landing/scripts/demo-site.html"), "utf8");
const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { cert: readFileSync(join(certs, "cert.pem"), "utf8"), key: readFileSync(join(certs, "key.pem"), "utf8") },
  fetch: () => new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
});

const port = await new Promise<number>((resolve) => {
  const srv = createServer().listen(0, "127.0.0.1", () => {
    const { port } = srv.address() as { port: number };
    srv.close(() => resolve(port));
  });
});
// The window's size: what the app restores at startup.
await Bun.write(
  join(profile, "windows.json"),
  JSON.stringify({ version: 1, open: [{ id: "w-screenshots0", bounds: SIZE, maximized: false }], closed: [] }),
);
process.chdir(join(here, ".."));
const electron = await launchElectron(
  {
    RUNE_USER_DATA_DIR: profile,
    RUNE_OFFSCREEN: "1",
    RUNE_EXTENSION_UPDATES: "0",
    RUNE_BROWSER_DIRS: "",
    // The demo site is local: no proxy in between.
    HTTPS_PROXY: undefined,
    HTTP_PROXY: undefined,
    https_proxy: undefined,
    http_proxy: undefined,
  },
  [
    "--ozone-platform=headless",
    "--ozone-override-screen-size=1920,1080",
    "--password-store=basic",
    `--remote-debugging-port=${port}`,
    "--no-proxy-server",
    // The demo site's certificate is self-signed.
    "--ignore-certificate-errors",
    `--host-resolver-rules=MAP ${HOST}:443 127.0.0.1:${site.port}`,
  ],
);

const page = await Page.connect(port, 30_000);
const ev = <T>(code: string) => page.eval<T>(code);
const click = (selector: string, text?: string) =>
  ev(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = ${text ? `els.find((e) => e.textContent.includes(${JSON.stringify(text)}))` : "els[0]"};
    if (!el) throw new Error(${JSON.stringify(`not found: ${selector} ${text ?? ""}`)});
    el.click();
    return true;
  })()`);
/** Authenticated request to the Rune Browser server, made from the renderer. */
const api = <T>(path: string, init: { method?: string; body?: unknown } = {}) =>
  ev<T>(`window.rune.serverReady().then(() => fetch(window.rune.serverUrl + ${JSON.stringify(path)}, {
    method: ${JSON.stringify(init.method ?? "GET")},
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + window.rune.token },
    ${init.body !== undefined ? `body: ${JSON.stringify(JSON.stringify(init.body))},` : ""}
  }).then(async (r) => { if (!r.ok) throw new Error(r.status + " " + (await r.text())); return r.status === 204 ? null : r.json(); }))`);
/** Runs code in the webview inside `root` (an app preview or web tab). */
const inView = <T>(root: string, code: string) =>
  ev<T>(`document.querySelector(${JSON.stringify(`${root} webview`)}).executeJavaScript(${JSON.stringify(code)})`);
/** Picks an item of a ⋯ menu: the browser's (in the top row) or a tab's. */
const fromMenu = async (menu: string, id: string) => {
  await click(menu);
  await page.waitFor(`!!document.querySelector('[data-context-menu] [data-menu-item="${id}"]:not(:disabled)')`, {
    label: `the ⋯ menu's ${id}`,
  });
  await click(`[data-context-menu] [data-menu-item="${id}"]`);
};
/** Opens the "New tab" button's menu (a right-click) and picks an entry; resolves to the new tab's id. */
const newTab = async (label: "New app" | "New web tab") => {
  const before = await ev<string[]>(`[...document.querySelectorAll("[data-app-id]")].map((e) => e.dataset.appId)`);
  await ev(
    `document.querySelector("[data-new-tab]").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })), true`,
  );
  await page.waitFor(`!!document.querySelector("[data-context-menu]")`, { label: "new tab menu" });
  await click("[data-context-menu] button", label);
  return page.waitFor<string>(
    `[...document.querySelectorAll("[data-app-id]")].map((e) => e.dataset.appId).find((id) => !${JSON.stringify(before)}.includes(id))`,
    { label: `the ${label}`, timeoutMs: 30_000 },
  );
};
const settle = () => Bun.sleep(1200);
async function shot(name: string, take: () => Promise<void>) {
  if (only && !name.includes(only)) return;
  // Each starts from a window without tabs.
  for (const app of await api<{ id: string }[]>("/api/apps")) await api(`/api/apps/${app.id}`, { method: "DELETE" });
  await take().catch(async (err) => {
    const failed = join(tmpdir(), `rune-shots-failed-${name}`);
    await page.screenshot(failed);
    console.error(`✗ ${name}: what the window showed is in ${failed}`);
    throw err;
  });
  await settle();
  await page.screenshot(join(out, name));
  console.log(`✓ ${join(out, name)}`);
}

try {
  await page.send("Runtime.enable");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.waitFor(`!!window.rune && !!document.querySelector("[data-new-tab]")`, {
    timeoutMs: 60_000,
    label: "boot",
  });
  await Bun.sleep(1000);
  mkdirSync(out, { recursive: true });

  await shot("new-app.png", async () => {
    const id = await newTab("New app");
    await page.waitFor(`document.body.innerText.includes("What do you want to build?")`, { label: "new app screen" });
    await page.waitFor(`!!document.querySelector('[data-agent-for="${id}"] textarea')`, { label: "agent sidebar" });
  });

  await shot("snapshots.png", async () => {
    const id = await newTab("New app");
    const tab = `[data-app-tab="${id}"]`;
    await page.waitFor(`!!document.querySelector('[data-agent-for="${id}"] textarea')`, { label: "agent sidebar" });
    await click(`${tab} [data-template="vanilla"]`);
    await page.waitFor(`!!document.querySelector('${tab}[data-runtime-state="running"] webview')`, {
      timeoutMs: 120_000,
      label: "the app running",
    });
    await page.waitFor(
      `document.querySelector('${tab} webview').executeJavaScript('!!document.querySelector("h1")?.textContent')`,
      {
        timeoutMs: 30_000,
        label: "the app's page",
      },
    );
    await api(`/api/apps/${id}`, { method: "PATCH", body: { name: "Weekly notes" } });
    // A change, as the agent would make it, and some data.
    const file = join(profile, "data", "apps", id, "src", "main.ts");
    const source = await Bun.file(file).text();
    await Bun.write(
      file,
      source
        .replace(
          "A starting point: notes saved in SQLite, live in every open window.",
          "Notes for the week, saved in SQLite and live in every open window.",
        )
        .replace("Write a note…", "What's on your mind?")
        .replace(
          `root.querySelector("h1")!.textContent = document.title;`,
          `root.querySelector("h1")!.textContent = "Weekly notes";`,
        ),
    );
    await page.waitFor(
      `document.querySelector('${tab} webview').executeJavaScript('document.body.innerText.includes("Notes for the week")')`,
      {
        timeoutMs: 30_000,
        label: "the change, live",
      },
    );
    for (const text of [
      "Book the train to Lyon",
      "Call the plumber about the kitchen tap",
      "Try the tomato soup recipe",
    ])
      await inView(
        tab,
        `fetch("/api/notes", { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ text }))} }).then((r) => r.ok)`,
      );
    await page.waitFor(
      `document.querySelector('${tab} webview').executeJavaScript('document.querySelectorAll("li").length === 3')`,
      {
        label: "the notes",
      },
    );
    await fromMenu(`[data-tab-chrome="${id}"] [data-more-menu]`, "snapshots");
    const panel = `${tab} [data-history-panel]`;
    await page.waitFor(`!!document.querySelector('${panel} [data-snapshot]')`, { label: "snapshots" });
    await click(`${panel} [data-save-snapshot]`);
    await page.waitFor(`document.querySelectorAll('${panel} [data-snapshot]').length >= 2`, { label: "new snapshot" });
    await click(`${panel} [data-snapshot] button`);
    await page.waitFor(`!!document.querySelector('${panel} [data-history-file="src/main.ts"]')`, { label: "its diff" });
    // The change to the app's code rather than its lockfile.
    await click(`${panel} [data-history-file="bun.lock"] button`);
    const changed = `[...document.querySelectorAll('${panel} [data-history-file="src/main.ts"] div')].some((d) => d.textContent.includes("Notes for the week"))`;
    if (!(await ev<boolean>(changed))) await click(`${panel} [data-history-file="src/main.ts"] button`);
    await page.waitFor(changed, { label: "the diff of src/main.ts" });
  });

  await shot("page-changes.png", async () => {
    const id = await newTab("New web tab");
    const chrome = `[data-tab-chrome="${id}"]`;
    const agent = `[data-agent-for="${id}"]`;
    await Bun.sleep(500);
    await ev(`(() => {
      const input = document.activeElement?.matches("input") ? document.activeElement : document.querySelector('${chrome} [data-address]');
      input.value = ${JSON.stringify(PAGE)};
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.form.requestSubmit();
      return true;
    })()`);
    await page.waitFor(
      `document.querySelector('[data-web-tab="${id}"] webview')?.executeJavaScript('!!document.querySelector(".card")')`,
      { timeoutMs: 20_000, label: "the demo site" },
    );
    if (!(await ev<boolean>(`!!document.querySelector('${agent}')`))) await click(`${chrome} [data-agent-show]`);
    await page.waitFor(`!!document.querySelector('${agent} textarea')`, { label: "agent sidebar" });
    for (const change of CHANGES)
      await api("/api/page-changes", { method: "POST", body: { scope: { type: "site", value: HOST }, ...change } });
    await page.waitFor(`!!document.querySelector('${chrome} [data-customized]')`, { label: "changes applied" });
    await click(`${chrome} [data-customized]`);
    await page.waitFor(
      `document.querySelectorAll("[data-page-changes] [data-page-change]").length === ${CHANGES.length}`,
      { label: "changes listed" },
    );
  });

  await shot("mods-gallery.png", async () => {
    await fromMenu(`[data-titlebar] [data-more-menu]`, "settings");
    await page.waitFor(`!!document.querySelector('[data-settings-nav="mods"]')`, { label: "settings" });
    await click('[data-settings-nav="mods"]');
    await page.waitFor(`!!document.querySelector("[data-mods]")`, { label: "mods page" });
    await click(`[data-mods-tab="gallery"]`);
    await page.waitFor(`document.querySelectorAll("[data-gallery-mod]").length >= 3`, { label: "gallery" });
  });
} finally {
  page.close();
  electron.kill();
  await electron.exited;
  site.stop(true);
  rmSync(profile, { recursive: true, force: true });
  rmSync(certs, { recursive: true, force: true });
}
