// The website's screenshots (src/assets/screens/), taken of the real browser: the built app is launched
// headless on a throwaway profile, opens a demo recipe site (demo-site.html, served here under a made-up
// host), and page changes are added through the app's own API, as the agent would add them.
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
const browserDir = join(here, "../../browser");
const HOST = "www.slowcooked.blog";
const PAGE = `https://${HOST}/recipes/weeknight-tomato-soup`;
const DRAFT = "Hide everything except the recipe, and make the ingredients bigger";
const CHANGES = [
  { title: "Hide the ads", action: "hide", selector: ".ad, .promo" },
  { title: "Hide the life story", action: "hide", selector: ".story, .jump, .meta" },
  { title: "Hide the newsletter pop-up", action: "hide", selector: ".newsletter" },
  { title: "Larger ingredients", action: "style", selector: ".card li", value: "font-size: 20px; line-height: 1.8" },
];

// The demo site, over HTTPS (Rune Browser warns on plain HTTP), with a few JSON endpoints for the API map.
const certs = mkdtempSync(join(tmpdir(), "rune-shots-cert-"));
await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${join(certs, "key.pem")} -out ${join(certs, "cert.pem")} -days 2 -subj ${`/CN=${HOST}`} -addext ${`subjectAltName=DNS:${HOST}`}`.quiet();
const html = readFileSync(join(here, "demo-site.html"), "utf8");
const site = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { cert: readFileSync(join(certs, "cert.pem"), "utf8"), key: readFileSync(join(certs, "key.pem"), "utf8") },
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (/^\/api\/recipes\/\d+$/.test(path))
      return Response.json({
        id: 42,
        title: "Weeknight Tomato Soup",
        servings: 4,
        minutes: 35,
        published: "2025-03-03",
        author: { id: 7, name: "Marta" },
        ingredients: [{ name: "olive oil", amount: "2 tbsp" }],
        tags: ["soup", "weeknight"],
      });
    if (path.endsWith("/comments"))
      return Response.json({
        comments: [
          { id: 901, author: "sam_k", body: "Made this twice!", likes: 12, created_at: "2025-03-04T10:00:00Z" },
        ],
        next_page: 2,
      });
    if (path === "/api/me/saved")
      return Response.json({
        recipes: [{ id: 12, title: "Lentil stew", saved_at: "2025-02-01T08:00:00Z" }],
        total: 31,
      });
    if (path.endsWith("/rating")) return Response.json({ average: 4.8, count: 2481 });
    if (path === "/api/search")
      return Response.json({ results: [{ id: 42, title: "Tomato soup" }], page: 2, total: 118 });
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });

type Shot = {
  /** "ask": the cluttered page with a request typed in; "changes": the changes applied, their menu open; "api-map": the map. */
  scene: "ask" | "changes" | "api-map";
  /** The window's size in pixels; with zoom 2, the app is laid out at half that (a 2x screenshot). */
  size: [number, number];
  zoom?: number;
  draft?: string;
  /** Full screenshot to save, and close-ups of the app's own UI (rendered at 2x). */
  file?: string;
  crops?: Record<string, string>;
};

async function shoot({ scene, size: [width, height], zoom = 1, draft, file, crops = {} }: Shot) {
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "rune-shots-"));
  // The window's size: what the app restores at startup.
  await Bun.write(
    join(profile, "windows.json"),
    JSON.stringify({
      version: 1,
      open: [{ id: "w-screenshots0", bounds: { width, height }, maximized: false }],
      closed: [],
    }),
  );
  process.chdir(browserDir);
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
      "--ozone-override-screen-size=3000,2000",
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
  const click = (selector: string, text: string) =>
    ev(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)}));
      if (!el) throw new Error(${JSON.stringify(`not found: ${selector} ${text}`)});
      el.click();
      return true;
    })()`);
  const api = (path: string, body: unknown) =>
    ev(`fetch(window.rune.serverUrl + ${JSON.stringify(path)}, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + window.rune.token },
      body: ${JSON.stringify(JSON.stringify(body))},
    }).then((r) => r.ok)`);
  const go = (url: string, chrome: string) =>
    ev(`(() => {
      const input = document.activeElement?.matches("input") ? document.activeElement : document.querySelector('${chrome} [data-address]');
      input.value = ${JSON.stringify(url)};
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.form.requestSubmit();
      return true;
    })()`);
  try {
    await page.send("Runtime.enable");
    await page.waitFor(`!!window.rune && !!document.querySelector("[data-new-tab]")`, {
      timeoutMs: 60_000,
      label: "boot",
    });
    await Bun.sleep(1000);
    // Laid out at 1/zoom of the window and drawn at zoom x: a sharp screenshot (web pages follow).
    if (zoom !== 1) await ev(`document.documentElement.style.zoom = "${zoom}", true`);
    await click("button", "New web tab");
    const tab = await page.waitFor<string>(`document.querySelector("[data-web-tab]")?.dataset.webTab`, {
      label: "web tab",
    });
    const chrome = `[data-tab-chrome="${tab}"]`;
    const agent = `[data-agent-for="${tab}"]`;
    const inPage = <T>(code: string) =>
      ev<T>(`document.querySelector('[data-web-tab="${tab}"] webview').executeJavaScript(${JSON.stringify(code)})`);
    await Bun.sleep(500);
    await go(PAGE, chrome);
    for (let i = 0; i < 100 && !(await inPage<boolean>(`!!document.querySelector(".card")`).catch(() => false)); i++)
      await Bun.sleep(200);

    if (scene !== "api-map") {
      if (!(await ev<boolean>(`!!document.querySelector('${agent}')`)))
        await ev(`document.querySelector('${chrome} [data-agent-show]').click(), true`);
      await page.waitFor(`!!document.querySelector('${agent} textarea')`, { label: "composer" });
    }
    if (draft)
      await ev(`(() => {
        const t = document.querySelector('${agent} textarea');
        t.value = ${JSON.stringify(draft)};
        t.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return true;
      })()`);
    if (scene === "changes") {
      for (const change of CHANGES) await api("/api/page-changes", { scope: { type: "site", value: HOST }, ...change });
      await page.waitFor(`!!document.querySelector('${chrome} [data-customized]')`, { label: "changes applied" });
      await ev(`document.querySelector('${chrome} [data-customized]').click(), true`);
      await page.waitFor(
        `document.querySelectorAll("[data-page-changes] [data-page-change]").length === ${CHANGES.length}`,
        {
          label: "changes listed",
        },
      );
    }
    if (scene === "api-map") {
      // A few visits, so the map has seen every endpoint more than once.
      for (let i = 0; i < 4; i++) {
        await inPage(`location.reload(), true`).catch(() => {});
        await Bun.sleep(1500);
      }
      await ev(`document.querySelector('${chrome} [data-address]').focus(), true`);
      await go("rune://api-map", chrome);
      await Bun.sleep(2500);
      await click("button", HOST);
      await Bun.sleep(500);
      await ev(
        `[...document.querySelectorAll("button")].find((b) => /\\/api\\/recipes\\/\\{id\\}(\\s|$)/.test(b.innerText)).click(), true`,
      );
    }
    await Bun.sleep(1200);

    if (file) await page.screenshot(join(out, file));
    for (const [selector, name] of Object.entries(crops)) {
      const box = await ev<{ x: number; y: number; width: number; height: number }>(`(() => {
        const b = document.querySelector(${JSON.stringify(selector.replaceAll("{agent}", agent))}).getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      })()`);
      const { data } = await page.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        clip: { ...box, scale: 2 },
      });
      await Bun.write(join(out, name), Buffer.from(data, "base64"));
    }
    console.log(`✓ ${[file, ...Object.values(crops)].filter(Boolean).join(", ")}`);
  } finally {
    page.close();
    electron.kill();
    await electron.exited;
    rmSync(profile, { recursive: true, force: true });
  }
}

mkdirSync(out, { recursive: true });
try {
  // The changes menu is placed wrongly under zoom, so this one is 1x; the close-ups are 2x anyway.
  await shoot({ scene: "changes", size: [1280, 800], file: "changes.png" });
  await shoot({
    scene: "changes",
    size: [1280, 800],
    draft: DRAFT,
    crops: { "[data-page-changes]": "changes-menu.png", "{agent} [data-composer]": "composer.png" },
  });
  await shoot({ scene: "ask", size: [2560, 1600], zoom: 2, draft: DRAFT, file: "ask.png" });
  await shoot({ scene: "api-map", size: [2560, 1600], zoom: 2, file: "api-map.png" });
} finally {
  site.stop(true);
  rmSync(certs, { recursive: true, force: true });
}
