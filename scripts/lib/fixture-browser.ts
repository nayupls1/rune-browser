// A fake Chromium profile for the e2e checks: one store-installed extension
// (with a key, so it keeps its ID) that uses the APIs Rune Browser provides, and its
// chrome.storage.local data in a real LevelDB folder, written by hand (a log
// file with one write batch, and a manifest that points at it).
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { extensionIdFromHash, type ShortcutPlatform } from "../../src/shared/extensions";

const shortcutPlatform: ShortcutPlatform =
  process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux";

// --- LevelDB ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32c(data: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const mask = (crc: number) => ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;

function varint(n: number) {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

const lengthPrefixed = (b: Buffer) => Buffer.concat([varint(b.length), b]);

/** One record in LevelDB's log format (small enough for one block). */
function logRecord(data: Buffer) {
  const head = Buffer.alloc(7);
  const typed = Buffer.concat([Buffer.from([1]), data]); // FULL
  head.writeUInt32LE(mask(crc32c(typed)), 0);
  head.writeUInt16LE(data.length, 4);
  head[6] = 1;
  return Buffer.concat([head, data]);
}

/** A LevelDB folder holding these keys and values (Chrome's extension storage: values are JSON). */
export function writeLevelDb(dir: string, entries: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true });
  const items = Object.entries(entries);
  const seq = Buffer.alloc(8);
  seq.writeBigUInt64LE(1n);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(items.length);
  const batch = Buffer.concat([
    seq,
    count,
    ...items.map(([k, v]) =>
      Buffer.concat([Buffer.from([1]), lengthPrefixed(Buffer.from(k)), lengthPrefixed(Buffer.from(JSON.stringify(v)))]),
    ),
  ]);
  writeFileSync(join(dir, "000003.log"), logRecord(batch));
  const edit = Buffer.concat([
    varint(1),
    lengthPrefixed(Buffer.from("leveldb.BytewiseComparator")),
    varint(2),
    varint(3), // log number
    varint(3),
    varint(4), // next file number
    varint(4),
    varint(0), // last sequence
  ]);
  writeFileSync(join(dir, "MANIFEST-000002"), logRecord(edit));
  writeFileSync(join(dir, "CURRENT"), "MANIFEST-000002\n");
}

// --- The extension ---------------------------------------------------------------------------

const files = (): Record<string, string> => ({
  "background.js": `
chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.set({ installed: details });
  chrome.contextMenus.create({ id: "say", title: "Say %s", contexts: ["selection"] });
});
// Real extensions read these at the top level.
chrome.permissions.onAdded.addListener(() => {});
// Ones Rune Browser only stands in for (no history, no policies): the worker still starts.
chrome.history.onVisited.addListener(() => {});
chrome.extension.isAllowedIncognitoAccess();
chrome.storage.managed.get(null);
// Like a password manager: fills in a site's sign-in.
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => callback(details.url.endsWith("/auth/extension") ? { authCredentials: { username: "fixture", password: "from-extension" } } : {}),
  { urls: ["http://127.0.0.1/*"] },
  ["asyncBlocking"],
);
chrome.action.setBadgeText({ text: "7" });
chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
chrome.storage.sync.set({ fromWorker: 1 });
chrome.commands.onCommand.addListener((command, tab) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    chrome.storage.local.set({ command, tabUrl: (tabs[0] && tabs[0].url) || null, commandTab: (tab && tab.url) || null });
  });
});
// Rune Browser's bookmarks: what was made last (by anyone) is noted.
chrome.bookmarks.onCreated.addListener((id, node) => chrome.storage.local.set({ bookmarked: node.title }));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "complete" && tab.url && tab.url.includes("/second")) chrome.action.setBadgeText({ tabId, text: "2nd" });
});
`,
  "content.js": `
document.documentElement.dataset.crx = "ok";
chrome.storage.local.get("greeting").then(({ greeting }) => (document.documentElement.dataset.greeting = greeting || "none"));
`,
  "popup.html": `<!doctype html><meta charset="utf-8"><body style="width: 260px; height: 110px; margin: 12px; font: 14px sans-serif"><h1 style="font-size: 16px">Fixture popup</h1><p id="url">…</p><script src="popup.js"></script></body>`,
  "popup.js": `chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => (document.getElementById("url").textContent = (tabs[0] && tabs[0].url) || "none"));`,
  "options.html": `<!doctype html><meta charset="utf-8"><title>Fixture options</title><h1>Fixture options</h1>`,
  "rules.json": JSON.stringify([
    {
      id: 1,
      priority: 1,
      action: { type: "block" },
      condition: {
        urlFilter: "/blocked-by-extension",
        resourceTypes: ["xmlhttprequest", "main_frame", "sub_frame", "other"],
      },
    },
  ]),
});

/** A solid-color square PNG. */
function png(size: number, [r, g, b]: [number, number, number]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface FixtureBrowser {
  /** For RUNE_BROWSER_DIRS. */
  dirs: string;
  extensionId: string;
  name: string;
}

/** Writes a Chromium user data folder with one profile ("Work"): the fixture extension, pinned, with a changed shortcut and saved data, and bookmarks. */
export function writeFixtureBrowser(root: string): FixtureBrowser {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  const id = extensionIdFromHash(createHash("sha256").update(der).digest("hex"));
  const name = "Rune Browser Fixture";
  const profile = join(root, "Default");
  const dir = join(profile, "Extensions", id, "1.0_0");
  mkdirSync(dir, { recursive: true });
  const manifest = {
    manifest_version: 3,
    name,
    version: "1.0",
    description: "Exercises the extension APIs in the e2e checks",
    key: der.toString("base64"),
    update_url: "https://clients2.google.com/service/update2/crx",
    icons: { 16: "icon.png", 48: "icon.png" },
    action: { default_popup: "popup.html", default_title: "Fixture", default_icon: { 16: "icon.png" } },
    options_page: "options.html",
    background: { service_worker: "background.js" },
    permissions: [
      "storage",
      "tabs",
      "contextMenus",
      "declarativeNetRequest",
      "history",
      "bookmarks",
      "webRequest",
      "webRequestAuthProvider",
    ],
    host_permissions: ["http://127.0.0.1/*"],
    content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_start" }],
    declarative_net_request: { rule_resources: [{ id: "fixture", enabled: true, path: "rules.json" }] },
    commands: { bump: { suggested_key: { default: "Alt+Shift+Y" }, description: "Bump" } },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  for (const [file, content] of Object.entries(files())) writeFileSync(join(dir, file), content);
  writeFileSync(join(dir, "icon.png"), png(32, [22, 163, 74]));

  writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Work" } } } }));
  writeFileSync(
    join(profile, "Preferences"),
    JSON.stringify({
      extensions: {
        settings: {
          [id]: { location: 1, path: `${id}/1.0_0`, from_webstore: true, disable_reasons: [], manifest },
          // A component of the browser itself: never offered.
          mhjfbmdgcfjbbpaeojofohoefgiehjai: { location: 5, path: "/usr/lib/chromium/resources/pdf" },
        },
        pinned_extensions: [id],
        // The shortcut was changed in the browser (from Alt+Shift+Y).
        // Chrome keeps one per platform ("linux:", "windows:", "mac:").
        commands: { [`${shortcutPlatform}:Alt+Shift+U`]: { command_name: "bump", extension: id, global: false } },
      },
      // Browser settings to import (Settings → Browser → Import bookmarks and settings).
      default_search_provider_data: {
        template_url_data: { short_name: "Google", url: "{google:baseURL}search?q={searchTerms}" },
      },
      profile: {
        content_settings: {
          exceptions: { notifications: { "https://imported.example.com:443,*": { setting: 1 } } },
        },
      },
      webkit: { webprefs: { default_font_size: 18 } },
      intl: { accept_languages: "de-DE,en-US" },
    }),
  );
  writeLevelDb(join(profile, "Local Extension Settings", id), { greeting: "hello from chrome" });
  // Its bookmarks, to import: one on the bar, a folder in other bookmarks.
  writeFileSync(
    join(profile, "Bookmarks"),
    JSON.stringify({
      roots: {
        bookmark_bar: { children: [{ type: "url", name: "Chrome docs", url: "https://developer.chrome.com/docs" }] },
        other: {
          children: [
            {
              type: "folder",
              name: "Reading list",
              children: [{ type: "url", name: "An essay", url: "https://essay.example/" }],
            },
          ],
        },
      },
    }),
  );
  return { dirs: `Chromium=${root}`, extensionId: id, name };
}
