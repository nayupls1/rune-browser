// Chrome extensions: the pure helpers (match patterns, shortcuts, Chrome's
// profile data, network rules as DNR rules) and the CRX/zip reader. Loading
// extensions, their APIs and the import run in Electron and are covered by the
// e2e checks.
import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { parseCrx, readZip, extractZip } from "../src/main/extensions/crx";
import type { NetworkRule } from "../src/shared/api";
import {
  compareVersions,
  extensionIdFromHash,
  extensionIdOf,
  iconPath,
  localeCandidates,
  localize,
  matchPattern,
  networkRulesToDnr,
  parseColor,
  parseShortcut,
  patternCondition,
  profileCommands,
  profileExtensions,
  profilePinned,
  shortcutMatches,
  suggestedKey,
  unsupportedPermissions,
  permissionAbout,
  idSourceForPath,
  webStoreId,
} from "../src/shared/extensions";

const ID = "ghmbeldphafepmbegfdlkpapadhbakde";
const OTHER = "ddkjiahejlhfcafbddmgiahcphecmpfh";

describe("match patterns", () => {
  const matches = (pattern: string, url: string) => matchPattern(pattern)!(url);

  test("schemes, hosts and paths", () => {
    expect(matches("<all_urls>", "https://a.example/x")).toBe(true);
    expect(matches("<all_urls>", "chrome://settings")).toBe(false);
    expect(matches("*://*/*", "http://a.example/")).toBe(true);
    expect(matches("*://*/*", "file:///etc/passwd")).toBe(false);
    expect(matches("https://*.example.com/*", "https://example.com/")).toBe(true);
    expect(matches("https://*.example.com/*", "https://a.b.example.com/x")).toBe(true);
    expect(matches("https://*.example.com/*", "https://notexample.com/")).toBe(false);
    expect(matches("https://*.example.com/*", "http://example.com/")).toBe(false);
    expect(matches("https://example.com/app/*", "https://example.com/app/page?q=1")).toBe(true);
    expect(matches("https://example.com/app/*", "https://example.com/other")).toBe(false);
    expect(matches("http://127.0.0.1/*", "http://127.0.0.1:4000/x")).toBe(true);
  });

  test("invalid patterns", () => {
    expect(matchPattern("https://a*.example.com/*")).toBeNull();
    expect(matchPattern("example.com")).toBeNull();
    expect(matchPattern("gopher://x/*")).toBeNull();
  });
});

describe("shortcuts", () => {
  const input = (code: string, mods: Partial<Record<"control" | "alt" | "shift" | "meta", boolean>> = {}) => ({
    control: false,
    alt: false,
    shift: false,
    meta: false,
    code,
    ...mods,
  });

  test("Chrome's key syntax", () => {
    expect(parseShortcut("Ctrl+Shift+X", "linux")).toEqual({
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      code: "KeyX",
    });
    // Ctrl means Command on a Mac; MacCtrl is the real Control key.
    expect(parseShortcut("Ctrl+Shift+X", "mac")).toEqual({
      ctrl: false,
      alt: false,
      shift: true,
      meta: true,
      code: "KeyX",
    });
    expect(parseShortcut("MacCtrl+Comma", "mac")?.ctrl).toBe(true);
    expect(parseShortcut("Alt+Shift+L", "linux")?.code).toBe("KeyL");
    expect(parseShortcut("Alt+7", "linux")?.code).toBe("Digit7");
    expect(parseShortcut("Ctrl+Up", "linux")?.code).toBe("ArrowUp");
    expect(parseShortcut("MediaPlayPause", "linux")?.code).toBe("MediaPlayPause");
    // Plain keys and unknown modifiers aren't shortcuts.
    expect(parseShortcut("Shift+X", "linux")).toBeNull();
    expect(parseShortcut("X", "linux")).toBeNull();
    expect(parseShortcut("Hyper+X", "linux")).toBeNull();
    expect(parseShortcut("Ctrl+", "linux")).toBeNull();
  });

  test("matching key presses", () => {
    const s = parseShortcut("Alt+Shift+L", "linux")!;
    expect(shortcutMatches(s, input("KeyL", { alt: true, shift: true }))).toBe(true);
    expect(shortcutMatches(s, input("KeyL", { alt: true }))).toBe(false);
    expect(shortcutMatches(s, input("KeyL", { alt: true, shift: true, control: true }))).toBe(false);
  });

  test("suggested keys per platform", () => {
    expect(suggestedKey("Alt+Y", "linux")).toBe("Alt+Y");
    expect(suggestedKey({ default: "Ctrl+Y", mac: "Command+Y" }, "mac")).toBe("Command+Y");
    expect(suggestedKey({ default: "Ctrl+Y", mac: "Command+Y" }, "linux")).toBe("Ctrl+Y");
    expect(suggestedKey({ mac: "Command+Y" }, "linux")).toBeNull();
    expect(suggestedKey(undefined, "linux")).toBeNull();
  });
});

describe("Chrome's profile data", () => {
  const prefs = {
    extensions: {
      settings: {
        [ID]: { location: 1, path: `${ID}/1.42.0_0`, from_webstore: true, disable_reasons: [] },
        [OTHER]: { location: 1, path: `${OTHER}/1.0_0`, disable_reasons: [1] },
        cccccccccccccccccccccccccccccccc: { location: 8, path: "/home/someone/copy-url" },
        // The browser's own components, themes and hosted apps aren't offered.
        mhjfbmdgcfjbbpaeojofohoefgiehjai: { location: 5, path: "/usr/lib/chromium/resources/pdf" },
        aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {
          location: 1,
          path: "theme",
          manifest: { manifest_version: 3, name: "Dark", version: "1", theme: {} },
        },
        "not-an-id": { location: 1, path: "x" },
      },
      pinned_extensions: [ID, "nonsense"],
      commands: {
        "linux:Ctrl+Shift+X": { command_name: "_execute_action", extension: ID, global: false },
        "mac:Command+Shift+X": { command_name: "_execute_action", extension: ID, global: false },
        "linux:Alt+Shift+L": { command_name: "copy", extension: "cccccccccccccccccccccccccccccccc" },
      },
    },
  };

  test("extensions, with their state there", () => {
    const list = profileExtensions(prefs);
    expect(list.map((e) => e.id).sort()).toEqual([ID, OTHER, "cccccccccccccccccccccccccccccccc"].sort());
    expect(list.find((e) => e.id === ID)).toMatchObject({ enabled: true, unpacked: false, fromWebStore: true });
    expect(list.find((e) => e.id === OTHER)?.enabled).toBe(false);
    expect(list.find((e) => e.id === "cccccccccccccccccccccccccccccccc")).toMatchObject({
      unpacked: true,
      path: "/home/someone/copy-url",
    });
  });

  test("Secure Preferences can disable what Preferences lists", () => {
    const secure = { extensions: { settings: { [ID]: { location: 1, path: `${ID}/1.42.0_0`, disable_reasons: 1 } } } };
    expect(profileExtensions(prefs, secure).find((e) => e.id === ID)?.enabled).toBe(false);
  });

  test("shortcuts for this platform, and pinned buttons", () => {
    expect(profileCommands(prefs, "linux")).toEqual({
      [ID]: { _execute_action: "Ctrl+Shift+X" },
      cccccccccccccccccccccccccccccccc: { copy: "Alt+Shift+L" },
    });
    expect(profileCommands(prefs, "mac")).toEqual({ [ID]: { _execute_action: "Command+Shift+X" } });
    expect(profilePinned(prefs)).toEqual([ID]);
    expect(profilePinned({})).toEqual([]);
  });
});

describe("manifests", () => {
  test("messages, locales and icons", () => {
    const messages = { appName: { message: "Proton Pass" } };
    expect(localize("__MSG_appname__", messages)).toBe("Proton Pass");
    expect(localize("__MSG_missing__ (beta)", messages)).toBe("__MSG_missing__ (beta)");
    expect(localize("Plain", null)).toBe("Plain");
    expect(localeCandidates("de-DE", "en")).toEqual(["de_DE", "de", "en"]);
    expect(iconPath({ 16: "16.png", 48: "48.png", 128: "128.png" }, 32)).toBe("48.png");
    expect(iconPath({ 16: "16.png" }, 32)).toBe("16.png");
    expect(iconPath("icon.png")).toBe("icon.png");
    expect(iconPath(undefined)).toBeNull();
  });

  test("permissions Rune Browser doesn't provide", () => {
    expect(
      unsupportedPermissions({
        manifest_version: 3,
        name: "x",
        version: "1",
        permissions: ["storage", "privacy", "userScripts", "https://*/*", "tabs"],
      }),
    ).toEqual(["privacy", "userScripts"]);
    // Each one says what it's for and what's different; unknown ones too.
    expect(permissionAbout("storage")).toEqual({ description: "Store its settings and data", limited: null });
    expect(permissionAbout("history").limited).toContain("empty");
    expect(permissionAbout("fileSystem.write").limited).toContain("Chrome apps");
    expect(permissionAbout("somethingNew")).toMatchObject({
      description: "somethingNew",
      limited: expect.stringContaining("keeps working"),
    });
  });

  test("the ID of an extension without a key, like Chromium derives it", () => {
    expect(idSourceForPath("/home/me/ext", "linux")).toEqual({ text: "/home/me/ext", encoding: "utf8" });
    // Windows: UTF-16, drive letter upper-cased.
    expect(idSourceForPath("c:\\Users\\me\\ext", "windows")).toEqual({
      text: "C:\\Users\\me\\ext",
      encoding: "utf16le",
    });
    const { text, encoding } = idSourceForPath("C:\\ext", "windows");
    expect(Buffer.from(text, encoding)).toEqual(Buffer.from([0x43, 0, 0x3a, 0, 0x5c, 0, 0x65, 0, 0x78, 0, 0x74, 0]));
  });

  test("IDs, versions, links", () => {
    const hash = createHash("sha256").update("key").digest("hex");
    const id = extensionIdFromHash(hash);
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(id[0]).toBe(String.fromCharCode(97 + Number.parseInt(hash[0]!, 16)));
    expect(extensionIdOf(`chrome-extension://${ID}/popup.html`)).toBe(ID);
    expect(extensionIdOf("https://example.com/")).toBeNull();
    expect(compareVersions("1.10.0", "1.9.2")).toBe(1);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
    expect(webStoreId(`https://chromewebstore.google.com/detail/proton-pass/${ID}`)).toBe(ID);
    expect(webStoreId(`https://chrome.google.com/webstore/detail/${ID}?hl=de`)).toBe(ID);
    expect(webStoreId(` ${ID} `)).toBe(ID);
    expect(webStoreId("https://example.com/")).toBeNull();
  });

  test("badge colors", () => {
    expect(parseColor("#16a34a")).toEqual([22, 163, 74, 255]);
    expect(parseColor("#f00")).toEqual([255, 0, 0, 255]);
    expect(parseColor("#ff000080")).toEqual([255, 0, 0, 128]);
    expect(parseColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3, 128]);
    expect(parseColor("Green")).toEqual([0, 128, 0, 255]);
    expect(parseColor([300, -1, 10])).toEqual([255, 0, 10, 255]);
    expect(parseColor("nope")).toBeNull();
  });
});

describe("network rules as DNR rules", () => {
  const rule = (r: Partial<NetworkRule>): NetworkRule => ({
    id: "r",
    workspaceId: null,
    pattern: "",
    action: "block",
    requestHeaders: {},
    responseHeaders: {},
    enabled: true,
    createdAt: "",
    ...r,
  });

  test("patterns", () => {
    expect(patternCondition("doubleclick.net")).toEqual({ urlFilter: "doubleclick.net" });
    expect(patternCondition("*://*.doubleclick.net/*")).toEqual({ urlFilter: "|*://*.doubleclick.net/*|" });
    // DNR's own special characters need a regular expression.
    expect(patternCondition("a|b")).toEqual({ regexFilter: "a\\|b" });
    expect(patternCondition("https://x/^*")).toEqual({ regexFilter: "^https://x/\\^.*$" });
    expect(patternCondition("  ")).toBeNull();
    expect(patternCondition("ünïcode")).toBeNull();
  });

  test("the workspace's enabled rules", () => {
    const rules = [
      rule({ pattern: "ads.example" }),
      rule({ pattern: "elsewhere.example", workspaceId: "other" }),
      rule({ pattern: "off.example", enabled: false }),
      rule({
        pattern: "api.example",
        action: "modify",
        requestHeaders: { "X-Debug": "1", Cookie: null },
        workspaceId: "ws",
      }),
      rule({ pattern: "nothing.example", action: "modify" }),
    ];
    const dnr = networkRulesToDnr(rules, "ws");
    expect(dnr.map((r) => [r.id, r.priority, r.action.type, r.condition.urlFilter])).toEqual([
      [1, 3, "block", "ads.example"],
      [2, 2, "modifyHeaders", "api.example"],
    ]);
    expect(dnr[1]!.action).toEqual({
      type: "modifyHeaders",
      requestHeaders: [
        { header: "X-Debug", operation: "set", value: "1" },
        { header: "Cookie", operation: "remove" },
      ],
    });
    expect(dnr[0]!.condition.resourceTypes).toContain("main_frame");
  });

  test("Google's sign-in gets the user agent that names Electron, below the rules", () => {
    const ua =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Electron/44.0.0 Safari/537.36";
    const dnr = networkRulesToDnr([rule({ pattern: "ads.example" })], "ws", ua);
    expect(dnr).toHaveLength(2);
    const signIn = dnr[1]!;
    expect(signIn.id).toBe(2);
    expect(signIn.condition.requestDomains).toEqual(["accounts.google.com"]);
    expect(signIn.condition.resourceTypes).toContain("main_frame");
    expect(signIn.condition.resourceTypes).toContain("xmlhttprequest");
    expect(signIn.action).toEqual({
      type: "modifyHeaders",
      requestHeaders: [{ header: "User-Agent", operation: "set", value: ua }],
    });
    expect(signIn.priority).toBeLessThan(dnr[0]!.priority);
  });
});

// --- CRX packages -----------------------------------------------------------------------

function zipOf(files: Record<string, string>) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [i, [name, text]] of Object.entries(files).entries()) {
    const data = Buffer.from(text);
    // Every other file deflated, to cover both methods.
    const method = i % 2 ? 8 : 0;
    const stored = method ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(stored.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, stored);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + stored.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const varint = (n: number) => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
};
const field = (n: number, value: Buffer) => Buffer.concat([varint(n * 8 + 2), varint(value.length), value]);

const keyPair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

/** A CRX3 file, signed with `signer` (the extension's own key unless given). */
function crx3(zip: Buffer, opts: { tamper?: boolean; signer?: ReturnType<typeof keyPair> } = {}) {
  const own = keyPair();
  const signer = opts.signer ?? own;
  const crxId = createHash("sha256").update(own.publicKey).digest().subarray(0, 16);
  const signedData = field(1, crxId);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedData.length);
  const signature = sign(
    "sha256",
    Buffer.concat([Buffer.from("CRX3 SignedData\x00", "latin1"), length, signedData, zip]),
    {
      key: signer.privateKey,
      format: "der",
      type: "pkcs8",
    },
  );
  const header = Buffer.concat([
    field(2, Buffer.concat([field(1, own.publicKey), field(2, signature)])),
    field(10000, signedData),
  ]);
  const head = Buffer.alloc(12);
  head.write("Cr24", 0, "latin1");
  head.writeUInt32LE(3, 4);
  head.writeUInt32LE(header.length, 8);
  const body = opts.tamper ? Buffer.concat([zip.subarray(0, -1), Buffer.from([zip[zip.length - 1]! ^ 1])]) : zip;
  return {
    file: Buffer.concat([head, header, body]),
    id: extensionIdFromHash(createHash("sha256").update(own.publicKey).digest("hex")),
    key: own.publicKey,
  };
}

describe("CRX packages", () => {
  const zip = zipOf({
    "manifest.json": '{"manifest_version":3,"name":"x","version":"1"}',
    "js/background.js": "console.log('hi')".repeat(20),
  });

  test("a signed CRX3 gives its ID, key and files", () => {
    const { file, id, key } = crx3(zip);
    const crx = parseCrx(file);
    expect(crx.id).toBe(id);
    expect(crx.key).toBe(key.toString("base64"));
    const entries = readZip(crx.zip);
    expect(entries.map((e) => e.name)).toEqual(["manifest.json", "js/background.js"]);
    expect(entries[1]!.data().toString()).toBe("console.log('hi')".repeat(20));
  });

  test("tampered or wrongly signed packages are refused", () => {
    expect(() => parseCrx(crx3(zip, { tamper: true }).file)).toThrow("signature");
    expect(() => parseCrx(crx3(zip, { signer: keyPair() }).file)).toThrow("signature");
    expect(() => parseCrx(zip)).toThrow("zip");
    expect(() => parseCrx(Buffer.from("hello world, not a package"))).toThrow("Not an extension package");
  });

  test("unpacking stays inside the folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "rune-crx-"));
    try {
      extractZip(zip, dir);
      expect(readFileSync(join(dir, "js/background.js"), "utf8")).toStartWith("console.log");
      expect(() => extractZip(zipOf({ "../escape.js": "x" }), join(dir, "inner"))).toThrow("outside");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
