// Page changes: scopes, validation, the CSS they make, and the API with
// snapshots. Applying them to real pages is covered by e2e.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { HistoryEntry, PageChange, PageChangeSpec } from "../src/shared/api";
import { pageChangeProblem, pageChangesCss, pageKey, scopeMatches } from "../src/shared/web";
import { pageChangeError } from "../src/server/db/PageChanges";
import { startServer } from "./lib/server";

describe("scopes", () => {
  test("a page is its host and path; query and hash don't matter", () => {
    expect(pageKey("https://example.com/news/?page=2#top")).toBe("example.com/news");
    expect(scopeMatches({ type: "page", value: "example.com/news" }, "https://example.com/news?page=2")).toBe(true);
    expect(scopeMatches({ type: "page", value: "example.com/news" }, "https://example.com/news/today")).toBe(false);
    expect(scopeMatches({ type: "page", value: "example.com" }, "https://example.com/")).toBe(true);
  });

  test("a site is its host", () => {
    expect(scopeMatches({ type: "site", value: "example.com" }, "https://example.com/a/b")).toBe(true);
    expect(scopeMatches({ type: "site", value: "example.com" }, "https://www.example.com/")).toBe(false);
    expect(scopeMatches({ type: "site", value: "example.com" }, "file:///example.com")).toBe(false);
  });

  test("patterns: * anywhere, *. also the bare domain, no path means the whole site", () => {
    const like = (pattern: string, url: string) => scopeMatches({ type: "pattern", value: pattern }, url);
    expect(like("*.example.com", "https://example.com/x")).toBe(true);
    expect(like("*.example.com", "https://docs.example.com/x/y")).toBe(true);
    expect(like("*.example.com", "https://badexample.com/")).toBe(false);
    expect(like("example.com/docs/*", "https://example.com/docs/intro")).toBe(true);
    expect(like("example.com/docs/*", "https://example.com/blog")).toBe(false);
    expect(like("https://*/admin*", "http://anything.test/admin/users")).toBe(true);
    expect(like("*", "https://example.org/")).toBe(true);
    expect(like("a.com", "https://a.com.evil.net/")).toBe(false);
  });
});

describe("validation", () => {
  const base: PageChangeSpec = {
    title: "Hide the banner",
    scope: { type: "site", value: "example.com" },
    action: "hide",
    selector: ".banner",
  };

  test("each action needs its fields", () => {
    expect(pageChangeProblem(base)).toBeNull();
    expect(pageChangeProblem({ ...base, selector: "" })).toBe("hide needs a selector");
    expect(pageChangeProblem({ ...base, action: "style" })).toBe("style needs a value");
    expect(pageChangeProblem({ ...base, action: "text", value: "" })).toBeNull();
    expect(pageChangeProblem({ ...base, action: "attribute", value: "x" })).toBe("attribute needs a name");
    expect(pageChangeProblem({ ...base, action: "attribute", name: "onclick", value: "x" })).toContain("button");
    expect(pageChangeProblem({ ...base, action: "button", value: "Go" })).toContain("onClick");
    expect(pageChangeProblem({ ...base, action: "css", selector: undefined, value: "body{}" })).toBeNull();
    expect(pageChangeProblem({ ...base, title: " " })).toBe("Give it a short title");
  });

  test("scopes are checked", () => {
    expect(pageChangeProblem({ ...base, scope: { type: "site", value: "https://example.com/x" } })).toContain(
      "host name",
    );
    expect(pageChangeProblem({ ...base, scope: { type: "page", value: "example.com" } })).toBeNull();
    expect(pageChangeProblem({ ...base, scope: { type: "page", value: "not a page" } })).toContain("host and path");
    expect(pageChangeProblem({ ...base, scope: { type: "page", value: "example.com/news" } })).toBeNull();
    expect(pageChangeProblem({ ...base, scope: { type: "pattern", value: "*.example.com/*" } })).toBeNull();
    expect(pageChangeProblem({ ...base, scope: { type: "pattern", value: "a b" } })).toContain("Patterns");
  });

  test("JavaScript has to parse", () => {
    const button: PageChangeSpec = {
      ...base,
      action: "button",
      value: "Copy",
      onClick: "navigator.clipboard.writeText(document.title)",
    };
    expect(pageChangeError(button)).toBeNull();
    expect(pageChangeError({ ...button, onClick: "if (" })).toContain("syntax error");
    expect(
      pageChangeError({ ...base, action: "script", selector: undefined, value: "onElement('a', (el) => el.remove())" }),
    ).toBeNull();
  });
});

test("hide, style and css become one stylesheet; buttons get a default look", () => {
  const change = (fields: Partial<PageChange>): PageChange =>
    ({
      id: "x",
      title: "t",
      scope: { type: "site", value: "a.com" },
      enabled: true,
      createdBy: "user",
      createdAt: "",
      updatedAt: "",
      ...fields,
    }) as PageChange;
  const css = pageChangesCss([
    change({ id: "h", action: "hide", selector: ".ad" }),
    change({ id: "s", action: "style", selector: "h1", value: "color: red" }),
    change({ id: "c", action: "css", value: "body { margin: 0 }" }),
    change({ id: "t", action: "text", selector: "h1", value: "Hi" }),
  ]);
  expect(css).toContain(".ad { display: none !important; }");
  expect(css).toContain("h1 { color: red }");
  expect(css).toContain("body { margin: 0 }");
  expect(css).not.toContain("Hi");
  expect(css).not.toContain("rune-button");
  expect(pageChangesCss([change({ action: "button", selector: "h1", value: "Go", onClick: "1" })])).toContain(
    "button.rune-button",
  );
});

describe("API", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.stop());
  const history = () => server.api<HistoryEntry[]>("/api/history?target=sites");

  test("add, turn off, change and remove; each a snapshot that can be undone", async () => {
    const spec: PageChangeSpec = {
      title: "Hide ads",
      scope: { type: "pattern", value: "*.example.com" },
      action: "hide",
      selector: ".ad",
      value: "ignored",
    };
    const added = await server.api<PageChange>("/api/page-changes", { method: "POST", json: spec });
    // Fields an action doesn't use are dropped.
    expect(added).toMatchObject({
      title: "Hide ads",
      action: "hide",
      selector: ".ad",
      enabled: true,
      createdBy: "user",
    });
    expect(added.value).toBeUndefined();
    expect(await server.api<PageChange[]>("/api/page-changes")).toHaveLength(1);
    await expect(server.api("/api/page-changes", { method: "POST", json: { ...spec, selector: "" } })).rejects.toThrow(
      "400",
    );

    const off = await server.api<PageChange>(`/api/page-changes/${added.id}`, {
      method: "PATCH",
      json: { enabled: false },
    });
    expect(off.enabled).toBe(false);
    const renamed = await server.api<PageChange>(`/api/page-changes/${added.id}`, {
      method: "PATCH",
      json: { change: { ...spec, title: "Hide all ads" } },
    });
    expect(renamed).toMatchObject({ title: "Hide all ads", enabled: false });

    await server.api(`/api/page-changes/${added.id}`, { method: "DELETE" });
    expect(await server.api<PageChange[]>("/api/page-changes")).toEqual([]);
    const [removed] = await history();
    expect(removed).toMatchObject({
      summary: "Removed the page change “Hide all ads”",
      removed: [`@changes/${added.id}.json`],
    });

    // Undoing the removal brings it back as it was.
    await server.api(`/api/history/${removed!.id}/undo`, { method: "POST", json: {} });
    expect(await server.api<PageChange[]>("/api/page-changes")).toEqual([renamed]);
  });

  test("restoring the first version of the site customizations removes later changes", async () => {
    const first = (await history()).at(-1)!;
    await server.api(`/api/history/${first.id}/restore`, { method: "POST", json: {} });
    expect(await server.api<PageChange[]>("/api/page-changes")).toEqual([]);
  });
});
