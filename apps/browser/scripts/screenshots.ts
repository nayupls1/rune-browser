// The README's screenshots (docs/screenshots/), taken of the real browser: the built app is launched headless
// on a throwaway profile, with the settings a new profile starts with, and driven over the DevTools protocol.
// The website in every one of them is the website's demo recipe site (apps/landing/scripts/demo-site.html),
// served here under a made-up host. Its page changes are added through Rune Browser's own API, as the agent
// would add them, and the agent's chat in agent.png is written into the database (no model is asked).
//
//   bun run build          (once, or after changing the browser)
//   bun run screenshots
//
// Needs openssl (for the demo site's certificate).
import { Database } from "bun:sqlite";
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
    // A throwaway profile: no first-run setup in the way (honored only by unpackaged builds).
    RUNE_SKIP_ONBOARDING: "1",
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
/** Picks an item of a ⋯ menu: the browser's (in the top row) or a tab's. */
const fromMenu = async (menu: string, id: string) => {
  await click(menu);
  await page.waitFor(`!!document.querySelector('[data-context-menu] [data-menu-item="${id}"]:not(:disabled)')`, {
    label: `the ⋯ menu's ${id}`,
  });
  await click(`[data-context-menu] [data-menu-item="${id}"]`);
};
/** Opens the demo site in a new tab, with the agent sidebar open; resolves to the tab's id. */
const demoTab = async () => {
  const tab = await api<{ id: string }>("/api/apps", { method: "POST", body: { url: PAGE } });
  await page.waitFor(`!!document.querySelector('[data-app-id="${tab.id}"]')`, { label: "the tab", timeoutMs: 30_000 });
  await click(`[data-app-id="${tab.id}"]`);
  await page.waitFor(
    `document.querySelector('[data-web-tab="${tab.id}"] webview')?.executeJavaScript('!!document.querySelector(".card")')`,
    { timeoutMs: 20_000, label: "the demo site" },
  );
  return tab.id;
};
/** The agent sidebar of a tab, opened. */
const showAgent = async (id: string) => {
  const agent = `[data-agent-for="${id}"]`;
  if (!(await ev<boolean>(`!!document.querySelector('${agent}')`)))
    await click(`[data-tab-chrome="${id}"] [data-agent-show]`);
  await page.waitFor(`!!document.querySelector('${agent} textarea')`, { label: "agent sidebar" });
  return agent;
};
const addChanges = async () => {
  for (const change of CHANGES)
    await api("/api/page-changes", { method: "POST", body: { scope: { type: "site", value: HOST }, ...change } });
};
const settle = () => Bun.sleep(1200);
async function shot(name: string, take: () => Promise<void>) {
  if (only && !name.includes(only)) return;
  // Each starts from a window without tabs.
  for (const tab of await api<{ id: string }[]>("/api/apps")) await api(`/api/apps/${tab.id}`, { method: "DELETE" });
  // ...and without page changes.
  for (const change of await api<{ id: string }[]>("/api/page-changes"))
    await api(`/api/page-changes/${change.id}`, { method: "DELETE" });
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

  await shot("agent.png", async () => {
    // The tab and the chat that made the changes, as the agent would have written it, before the window opens the
    // tab (it reads the chat then).
    const { id } = await api<{ id: string }>("/api/apps", { method: "POST", body: { url: PAGE } });
    const db = new Database(join(profile, "data", "rune.sqlite"));
    db.run("PRAGMA busy_timeout = 5000");
    const say = (role: string, content: string) =>
      db.run("INSERT INTO messages (app_id, role, content) VALUES (?, ?, ?)", [id, role, content]);
    say("user", "Hide the ads, the life story and the newsletter pop-up, and make the ingredients easier to read.");
    say("tool", JSON.stringify({ kind: "screenshot", title: "Took a screenshot" }));
    say("tool", JSON.stringify({ kind: "inspect", title: "Inspected .card li" }));
    for (const change of CHANGES)
      say("tool", JSON.stringify({ kind: "customize", title: `Added a page change “${change.title}”` }));
    say(
      "assistant",
      "Done: the ads, the life story and the newsletter pop-up are hidden on every page of the blog, and the ingredients are larger. Each change has its own switch under the paintbrush in the address bar.",
    );
    db.close();
    await addChanges();
    await page.waitFor(`!!document.querySelector('[data-app-id="${id}"]')`, { label: "the tab", timeoutMs: 30_000 });
    await click(`[data-app-id="${id}"]`);
    await page.waitFor(
      `document.querySelector('[data-web-tab="${id}"] webview')?.executeJavaScript('!!document.querySelector(".card")')`,
      { timeoutMs: 20_000, label: "the demo site" },
    );
    const agent = await showAgent(id);
    await page.waitFor(`document.querySelector('${agent}').innerText.includes("Each change has its own switch")`, {
      label: "the chat",
    });
  });

  await shot("snapshots.png", async () => {
    const id = await demoTab();
    await addChanges();
    await fromMenu(`[data-tab-chrome="${id}"] [data-more-menu]`, "settings");
    await page.waitFor(`!!document.querySelector('[data-settings-nav="snapshots"]')`, { label: "settings" });
    await click('[data-settings-nav="snapshots"]');
    const entry = `[...document.querySelectorAll("[data-history-page] [data-snapshot]")].find((e) => e.innerText.includes("Larger ingredients"))`;
    await page.waitFor(`!!${entry}`, { label: "the snapshot of the last change" });
    await ev(`${entry}.querySelector("button").click(), true`);
    await page.waitFor(`!!document.querySelector("[data-history-page] [data-history-file]")`, { label: "its diff" });
  });

  await shot("page-changes.png", async () => {
    const id = await demoTab();
    const chrome = `[data-tab-chrome="${id}"]`;
    await showAgent(id);
    await addChanges();
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
