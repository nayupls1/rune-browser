// The homepage's screenshot (src/assets/screens/changes.png), taken of the real browser: the built app is
// launched headless on a throwaway profile, opens a demo recipe site (demo-site.html, served here under a
// made-up host), and page changes are added through the app's own API, as the agent would add them.
//
//   bun run --cwd apps/browser build    (once, or after changing the browser)
//   bun run --cwd apps/landing screenshots
//
// Needs openssl (for the demo site's certificate).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchElectron } from "../../browser/scripts/electron";
import { Page } from "../../browser/scripts/lib/cdp";

const here = import.meta.dir;
const out = join(here, "../src/assets/screens");
const HOST = "www.slowcooked.blog";
const PAGE = `https://${HOST}/recipes/weeknight-tomato-soup`;
/** The window's size. The changes menu is placed wrongly when the app is zoomed, so this is a 1x screenshot. */
const SIZE = { width: 1280, height: 800 };
const CHANGES = [
  { title: "Hide the ads", action: "hide", selector: ".ad, .promo" },
  { title: "Hide the life story", action: "hide", selector: ".story, .jump, .meta" },
  { title: "Hide the newsletter pop-up", action: "hide", selector: ".newsletter" },
  { title: "Larger ingredients", action: "style", selector: ".card li", value: "font-size: 20px; line-height: 1.8" },
];

// The demo site, over HTTPS: Rune Browser warns before showing a site over plain HTTP.
const certs = mkdtempSync(join(tmpdir(), "rune-shots-cert-"));
const profile = mkdtempSync(join(tmpdir(), "rune-shots-"));
await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${join(certs, "key.pem")} -out ${join(certs, "cert.pem")} -days 2 -subj ${`/CN=${HOST}`} -addext ${`subjectAltName=DNS:${HOST}`}`.quiet();
const html = readFileSync(join(here, "demo-site.html"), "utf8");
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
process.chdir(join(here, "../../browser"));
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
try {
  await page.send("Runtime.enable");
  await page.waitFor(`!!window.rune && !!document.querySelector("[data-new-tab]")`, {
    timeoutMs: 60_000,
    label: "boot",
  });
  await Bun.sleep(1000);
  await ev(`document.querySelector("[data-new-tab]").click(), true`);
  const tab = await page.waitFor<string>(`document.querySelector("[data-web-tab]")?.dataset.webTab`, {
    label: "web tab",
  });
  const chrome = `[data-tab-chrome="${tab}"]`;
  const agent = `[data-agent-for="${tab}"]`;
  await Bun.sleep(500);
  await ev(`(() => {
    const input = document.activeElement?.matches("input") ? document.activeElement : document.querySelector('${chrome} [data-address]');
    input.value = ${JSON.stringify(PAGE)};
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`);
  await page.waitFor(
    `document.querySelector('[data-web-tab="${tab}"] webview')?.executeJavaScript('!!document.querySelector(".card")')`,
    { timeoutMs: 20_000, label: "the demo site" },
  );

  // The agent's sidebar, the changes (as the agent adds them), and the menu listing them.
  if (!(await ev<boolean>(`!!document.querySelector('${agent}')`)))
    await ev(`document.querySelector('${chrome} [data-agent-show]').click(), true`);
  await page.waitFor(`!!document.querySelector('${agent} textarea')`, { label: "agent sidebar" });
  for (const change of CHANGES)
    await ev(`fetch(window.rune.serverUrl + "/api/page-changes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + window.rune.token },
      body: ${JSON.stringify(JSON.stringify({ scope: { type: "site", value: HOST }, ...change }))},
    }).then((r) => r.ok)`);
  await page.waitFor(`!!document.querySelector('${chrome} [data-customized]')`, { label: "changes applied" });
  await ev(`document.querySelector('${chrome} [data-customized]').click(), true`);
  await page.waitFor(
    `document.querySelectorAll("[data-page-changes] [data-page-change]").length === ${CHANGES.length}`,
    { label: "changes listed" },
  );
  await Bun.sleep(1200);

  mkdirSync(out, { recursive: true });
  await page.screenshot(join(out, "changes.png"));
  console.log(`✓ ${join(out, "changes.png")}`);
} finally {
  page.close();
  electron.kill();
  await electron.exited;
  site.stop(true);
  rmSync(profile, { recursive: true, force: true });
  rmSync(certs, { recursive: true, force: true });
}
