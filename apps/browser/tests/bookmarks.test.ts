// Bookmarks: the formats they come in and go out as (Chrome's file, Firefox's
// places, the HTML file), searching the tree, and the API with Chrome's rules
// for creating, moving and removing, and importing from other browsers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BAR_ID,
  bookmarksHtml,
  bookmarkUrl,
  chromeBookmarks,
  firefoxBookmarks,
  OTHER_ID,
  parseBookmarksHtml,
  recentBookmarks,
  searchBookmarks,
  type BookmarkImportResult,
  type BookmarkNode,
  type BookmarkSource,
  type FirefoxRow,
} from "../src/shared/bookmarks";
import { startServer } from "./lib/server";

const node = (id: string, title: string, url?: string, children?: BookmarkNode[], dateAdded = 0): BookmarkNode => ({
  id,
  title,
  syncing: false,
  dateAdded,
  ...(url ? { url } : {}),
  ...(children ? { children } : {}),
});

const sample = node("0", "", undefined, [
  node(BAR_ID, "Bookmarks bar", undefined, [
    node("3", "Rune <docs> & more", "https://rune.example/docs", undefined, 3000),
    node("4", "Tools", undefined, [node("5", "Bun", "https://bun.sh/", undefined, 5000)]),
  ]),
  node(OTHER_ID, "Other bookmarks", undefined, [node("6", "Effect", "https://effect.website/", undefined, 4000)]),
]);

describe("formats", () => {
  test("addresses: web pages, files and extensions' pages; never scripts", () => {
    expect(bookmarkUrl("https://example.com")).toBe("https://example.com/");
    expect(bookmarkUrl(" file:///home/me/notes.txt ")).toBe("file:///home/me/notes.txt");
    expect(bookmarkUrl("javascript:alert(1)")).toBeNull();
    expect(bookmarkUrl("place:sort=8")).toBeNull();
    expect(bookmarkUrl("not a url")).toBeNull();
  });

  test("the HTML file: written like Chrome's, read back the same", () => {
    const html = bookmarksHtml(sample);
    expect(html).toStartWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>");
    expect(html).toContain('PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>');
    expect(html).toContain("Rune &lt;docs&gt; &amp; more");
    const back = parseBookmarksHtml(html);
    expect(back.bar).toEqual([
      { title: "Rune <docs> & more", url: "https://rune.example/docs", dateAdded: 3000 },
      { title: "Tools", dateAdded: undefined, children: [{ title: "Bun", url: "https://bun.sh/", dateAdded: 5000 }] },
    ]);
    expect(back.other).toEqual([{ title: "Effect", url: "https://effect.website/", dateAdded: 4000 }]);
  });

  test("Firefox's HTML: the toolbar, menu items loose, other bookmarks with the rest", () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE><H1>Bookmarks Menu</H1>
<DL><p>
    <DT><A HREF="https://menu.example/" ADD_DATE="1700000000">In the menu</A>
    <DT><H3 ADD_DATE="1" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Toolbar</H3>
    <DL><p>
        <DT><A HREF="https://bar.example/?a=1&amp;b=2">On the bar</A>
        <DT><H3>Folder</H3>
        <DL><p>
            <DT><A HREF="https://deep.example/">Deep</A>
        </DL><p>
    </DL><p>
    <DT><H3 UNFILED_BOOKMARKS_FOLDER="true">Other Bookmarks</H3>
    <DL><p>
        <DT><A HREF="https://other.example/">Other one</A>
    </DL><p>
</DL>`;
    const data = parseBookmarksHtml(html);
    expect(data.bar.map((b) => b.title)).toEqual(["On the bar", "Folder"]);
    expect(data.bar[0]!.url).toBe("https://bar.example/?a=1&b=2");
    expect(data.bar[1]!.children).toEqual([{ title: "Deep", url: "https://deep.example/", dateAdded: undefined }]);
    expect(data.other.map((b) => b.title)).toEqual(["In the menu", "Other one"]);
    expect(data.other[0]!.dateAdded).toBe(1_700_000_000_000);
  });

  test("HTML with a missing </A> or an icon in the title", () => {
    const data = parseBookmarksHtml(`<DL><p>
    <DT><A HREF="https://one.example/">One
    <DT><A HREF="https://two.example/">Two</A>
    <DT><A HREF="https://three.example/"><IMG SRC="icon.png">Three &amp; more</A>
</DL>`);
    expect(data.other.map((b) => [b.title, b.url])).toEqual([
      ["One", "https://one.example/"],
      ["Two", "https://two.example/"],
      ["Three & more", "https://three.example/"],
    ]);
  });

  test("Chrome's Bookmarks file: bar, other, mobile; times from 1601", () => {
    const data = chromeBookmarks({
      roots: {
        bookmark_bar: {
          children: [
            { type: "url", name: "Bar page", url: "https://bar.example/", date_added: "13340000000000000" },
            { type: "folder", name: "Stuff", children: [{ type: "url", name: "In it", url: "https://in.example/" }] },
          ],
        },
        other: { children: [{ type: "url", name: "Other page", url: "https://other.example/" }] },
        synced: { name: "Mobile bookmarks", children: [{ type: "url", name: "Phone", url: "https://m.example/" }] },
      },
    });
    expect(data.bar.map((b) => b.title)).toEqual(["Bar page", "Stuff"]);
    expect(data.bar[0]!.dateAdded).toBe(Math.round(13340000000000000 / 1000 - 11644473600000));
    expect(data.other.map((b) => b.title)).toEqual(["Other page", "Mobile bookmarks"]);
    expect(chromeBookmarks(null)).toEqual({ bar: [], other: [] });
  });

  test("Firefox's places: toolbar on the bar, menu and mobile as folders, no tags or separators", () => {
    const rows: FirefoxRow[] = [
      { id: 1, type: 2, parent: 0, position: 0, title: "", url: null, dateAdded: 0, guid: "root________" },
      { id: 2, type: 2, parent: 1, position: 0, title: "menu", url: null, dateAdded: 0, guid: "menu________" },
      { id: 3, type: 2, parent: 1, position: 1, title: "toolbar", url: null, dateAdded: 0, guid: "toolbar_____" },
      { id: 4, type: 2, parent: 1, position: 2, title: "tags", url: null, dateAdded: 0, guid: "tags________" },
      { id: 5, type: 2, parent: 1, position: 3, title: "unfiled", url: null, dateAdded: 0, guid: "unfiled_____" },
      {
        id: 10,
        type: 1,
        parent: 3,
        position: 1,
        title: "Second",
        url: "https://b.example/",
        dateAdded: 5e6,
        guid: "a",
      },
      {
        id: 11,
        type: 1,
        parent: 3,
        position: 0,
        title: "First",
        url: "https://a.example/",
        dateAdded: null,
        guid: "b",
      },
      { id: 12, type: 3, parent: 3, position: 2, title: null, url: null, dateAdded: null, guid: "c" },
      {
        id: 13,
        type: 1,
        parent: 2,
        position: 0,
        title: "Menu page",
        url: "https://m.example/",
        dateAdded: 0,
        guid: "d",
      },
      { id: 14, type: 2, parent: 4, position: 0, title: "a tag", url: null, dateAdded: 0, guid: "e" },
      { id: 15, type: 1, parent: 5, position: 0, title: "Loose", url: "https://l.example/", dateAdded: 0, guid: "f" },
    ];
    const data = firefoxBookmarks(rows);
    expect(data.bar).toEqual([
      { title: "First", url: "https://a.example/", dateAdded: undefined },
      { title: "Second", url: "https://b.example/", dateAdded: 5000 },
    ]);
    expect(data.other.map((b) => b.title)).toEqual(["Loose", "menu"]);
    expect(data.other[1]!.children!.map((b) => b.title)).toEqual(["Menu page"]);
  });
});

describe("the tree", () => {
  test("search: every word in the title or address, or exact url and title", () => {
    expect(searchBookmarks(sample, "rune docs").map((n) => n.id)).toEqual(["3"]);
    expect(searchBookmarks(sample, "BUN.SH").map((n) => n.id)).toEqual(["5"]);
    expect(searchBookmarks(sample, "tools").map((n) => n.id)).toEqual(["4"]);
    expect(searchBookmarks(sample, { url: "https://effect.website" }).map((n) => n.id)).toEqual(["6"]);
    expect(searchBookmarks(sample, { title: "Bun" }).map((n) => n.id)).toEqual(["5"]);
    expect(searchBookmarks(sample, "")).toEqual([]);
    expect(searchBookmarks(sample, "bookmarks")).toEqual([]);
  });

  test("recent: newest first, pages only", () => {
    expect(recentBookmarks(sample, 2).map((n) => n.id)).toEqual(["5", "6"]);
  });
});

describe("the API", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let browsers: string;

  beforeAll(async () => {
    browsers = mkdtempSync(join(tmpdir(), "rune-bookmark-browsers-"));
    // A Chromium profile with a Bookmarks file.
    const chrome = join(browsers, "chrome");
    mkdirSync(join(chrome, "Default"), { recursive: true });
    writeFileSync(
      join(chrome, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Work" } } } }),
    );
    writeFileSync(
      join(chrome, "Default", "Bookmarks"),
      JSON.stringify({
        roots: {
          bookmark_bar: { children: [{ type: "url", name: "From Chrome", url: "https://chrome.example/" }] },
          other: {
            children: [
              { type: "url", name: "A bookmarklet", url: "javascript:void(0)" },
              {
                type: "folder",
                name: "Reading",
                children: [{ type: "url", name: "Essay", url: "https://e.example/" }],
              },
            ],
          },
        },
      }),
    );
    // A Firefox profile with places.sqlite.
    const firefox = join(browsers, "firefox");
    mkdirSync(join(firefox, "abc.default-release"), { recursive: true });
    writeFileSync(
      join(firefox, "profiles.ini"),
      "[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=abc.default-release\n",
    );
    const db = new Database(join(firefox, "abc.default-release", "places.sqlite"));
    db.run("CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT)");
    db.run(
      "CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, dateAdded INTEGER, guid TEXT)",
    );
    db.run("INSERT INTO moz_places VALUES (1, 'https://firefox.example/'), (2, 'place:sort=8')");
    db.run(`INSERT INTO moz_bookmarks VALUES
      (1, 2, NULL, 0, 0, '', 0, 'root________'),
      (2, 2, NULL, 1, 0, 'toolbar', 0, 'toolbar_____'),
      (3, 1, 1, 2, 0, 'From Firefox', 1700000000000000, 'x1'),
      (4, 1, 2, 2, 1, 'Most visited', 0, 'x2')`);
    db.close();
    server = await startServer({
      env: { RUNE_BROWSER_DIRS: `Chromium=${chrome}`, RUNE_FIREFOX_DIRS: `Firefox=${firefox}` },
    });
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(browsers, { recursive: true, force: true });
  });

  const tree = () => server.api<BookmarkNode>("/api/bookmarks");
  const titles = async (folder: string) =>
    (await tree()).children!.find((n) => n.id === folder)!.children!.map((n) => n.title);
  const create = (body: Record<string, unknown>) =>
    server.api<BookmarkNode>("/api/bookmarks", { method: "POST", json: body });
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => "",
      (e: Error) => e.message,
    );

  test("starts with the bookmarks bar and other bookmarks", async () => {
    const root = await tree();
    expect(root.id).toBe("0");
    expect(root.children!.map((n) => [n.id, n.title, n.folderType])).toEqual([
      [BAR_ID, "Bookmarks bar", "bookmarks-bar"],
      [OTHER_ID, "Other bookmarks", "other"],
    ]);
  });

  test("create: other bookmarks by default, at an index, folders; addresses checked", async () => {
    const a = await create({ title: "A", url: "https://a.example" });
    expect(a).toMatchObject({ parentId: OTHER_ID, index: 0, url: "https://a.example/" });
    await create({ title: "C", url: "https://c.example/", parentId: OTHER_ID });
    const b = await create({ title: "B", url: "https://b.example/", parentId: OTHER_ID, index: 1 });
    expect(b.index).toBe(1);
    expect(await titles(OTHER_ID)).toEqual(["A", "B", "C"]);
    const folder = await create({ title: "Folder", parentId: BAR_ID });
    expect(folder.url).toBeUndefined();
    expect(folder.children).toEqual([]);
    expect(await failure(create({ title: "x", url: "javascript:alert(1)" }))).toContain("Invalid URL");
    expect(await failure(create({ title: "x", parentId: a.id }))).toContain("does not specify a folder");
    expect(await failure(create({ title: "x", parentId: "0" }))).toContain("root bookmark folders");
    expect(await failure(create({ title: "x", parentId: OTHER_ID, index: 9 }))).toContain("Index out of bounds");
  });

  test("move: Chrome's index (moving down in a folder is one less), into folders, never into itself", async () => {
    const other = (await tree()).children!.find((n) => n.id === OTHER_ID)!.children!;
    const [a, , c] = other;
    // A before the node at index 2 (C): A goes after B.
    await server.api(`/api/bookmarks/${a!.id}`, { method: "PATCH", json: { index: 2 } });
    expect(await titles(OTHER_ID)).toEqual(["B", "A", "C"]);
    await server.api(`/api/bookmarks/${c!.id}`, { method: "PATCH", json: { index: 0 } });
    expect(await titles(OTHER_ID)).toEqual(["C", "B", "A"]);
    const folder = (await tree()).children!.find((n) => n.id === BAR_ID)!.children!.find((n) => n.title === "Folder")!;
    const moved = await server.api<BookmarkNode>(`/api/bookmarks/${c!.id}`, {
      method: "PATCH",
      json: { parentId: folder.id },
    });
    expect(moved).toMatchObject({ parentId: folder.id, index: 0 });
    expect(await titles(OTHER_ID)).toEqual(["B", "A"]);
    const inner = await create({ title: "Inner", parentId: folder.id });
    expect(
      await failure(server.api(`/api/bookmarks/${folder.id}`, { method: "PATCH", json: { parentId: inner.id } })),
    ).toContain("into itself");
    expect(await failure(server.api(`/api/bookmarks/${BAR_ID}`, { method: "PATCH", json: { index: 1 } }))).toContain(
      "root bookmark folders",
    );
    // Not by another way of writing its id either.
    expect(await failure(server.api(`/api/bookmarks/01`, { method: "PATCH", json: { index: 1 } }))).toContain("404");
    expect(await failure(server.api(`/api/bookmarks/01`, { method: "DELETE" }))).toContain("404");
  });

  test("update and remove: titles and addresses; a folder with things in it only recursively", async () => {
    const other = (await tree()).children!.find((n) => n.id === OTHER_ID)!.children!;
    const b = other[0]!;
    const changed = await server.api<BookmarkNode>(`/api/bookmarks/${b.id}`, {
      method: "PATCH",
      json: { title: "Bee", url: "https://bee.example/" },
    });
    expect(changed).toMatchObject({ title: "Bee", url: "https://bee.example/" });
    // A new title and a new place go together, or not at all.
    expect(
      await failure(
        server.api(`/api/bookmarks/${b.id}`, { method: "PATCH", json: { title: "Lost", parentId: "99999" } }),
      ),
    ).toContain("parent");
    expect((await tree()).children!.find((n) => n.id === OTHER_ID)!.children![0]!.title).toBe("Bee");
    const folder = (await tree()).children!.find((n) => n.id === BAR_ID)!.children!.find((n) => n.title === "Folder")!;
    expect(
      await failure(
        server.api(`/api/bookmarks/${folder.id}`, { method: "PATCH", json: { url: "https://x.example/" } }),
      ),
    ).toContain("Can't set URL of a bookmark folder");
    expect(await failure(server.api(`/api/bookmarks/${folder.id}`, { method: "DELETE" }))).toContain("non-empty");
    await server.api(`/api/bookmarks/${folder.id}?recursive=1`, { method: "DELETE" });
    await server.api(`/api/bookmarks/${b.id}`, { method: "DELETE" });
    expect(await titles(BAR_ID)).toEqual([]);
    expect(await titles(OTHER_ID)).toEqual(["A"]);
    expect(await failure(server.api(`/api/bookmarks/${b.id}`, { method: "DELETE" }))).toContain("404");
  });

  test("changes go out on the hub, for the renderer and extensions", async () => {
    const ws = new WebSocket(server.wsUrl);
    const got: { kind: string }[] = [];
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "bookmarks") got.push(msg.change);
    };
    ws.send(JSON.stringify({ type: "subscribe", topic: "bookmarks" }));
    await Bun.sleep(100);
    const x = await create({ title: "X", url: "https://x.example/" });
    await server.api(`/api/bookmarks/${x.id}`, { method: "PATCH", json: { title: "Y" } });
    await server.api(`/api/bookmarks/${x.id}`, { method: "PATCH", json: { parentId: BAR_ID } });
    await server.api(`/api/bookmarks/${x.id}`, { method: "DELETE" });
    for (let i = 0; i < 50 && got.length < 4; i++) await Bun.sleep(20);
    ws.close();
    expect(got.map((c) => c.kind)).toEqual(["created", "changed", "moved", "removed"]);
    expect(got[2]).toMatchObject({ parentId: BAR_ID, oldParentId: OTHER_ID, index: 0 });
  });

  test("import: other browsers' profiles; the bar on the bar, into a folder where there's something already", async () => {
    const sources = await server.api<BookmarkSource[]>("/api/bookmarks/sources");
    expect(sources.map((s) => [s.browser, s.profile, s.count])).toEqual([
      ["Chromium", "Work", 2],
      ["Firefox", "default-release", 1],
    ]);
    const fromChrome = await server.api<BookmarkImportResult>("/api/bookmarks/import", {
      method: "POST",
      json: { source: sources[0]!.id },
    });
    expect(fromChrome).toEqual({ added: 2, skipped: 1 });
    // The bar was empty: its bookmarks go right there; other bookmarks had "A": a folder.
    expect(await titles(BAR_ID)).toEqual(["From Chrome"]);
    expect(await titles(OTHER_ID)).toEqual(["A", "Imported from Chromium"]);
    const fromFirefox = await server.api<BookmarkImportResult>("/api/bookmarks/import", {
      method: "POST",
      json: { source: sources[1]!.id },
    });
    expect(fromFirefox).toEqual({ added: 1, skipped: 1 });
    expect(await titles(BAR_ID)).toEqual(["From Chrome", "Imported from Firefox"]);
  });

  test("import an HTML file, export one", async () => {
    const html = `<DL><p><DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bar</H3><DL><p><DT><A HREF="https://html.example/">From a file</A></DL><p></DL>`;
    const result = await server.api<BookmarkImportResult>("/api/bookmarks/import", { method: "POST", json: { html } });
    expect(result.added).toBe(1);
    expect(
      await failure(server.api("/api/bookmarks/import", { method: "POST", json: { html: "<p>hi</p>" } })),
    ).toContain("no bookmarks");
    const res = await fetch(`${server.url}/api/bookmarks/export`, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    expect(res.headers.get("content-disposition")).toContain("bookmarks.html");
    const exported = parseBookmarksHtml(await res.text());
    expect(exported.bar.map((b) => b.title)).toEqual(["From Chrome", "Imported from Firefox", "Imported from a file"]);
    expect(exported.other.map((b) => b.title)).toEqual(["A", "Imported from Chromium"]);
  });
});
