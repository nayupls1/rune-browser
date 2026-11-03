import { describe, expect, test } from "bun:test";
import { insecureAction, insecureHostOf, isInsecureUrl, isLocalHost } from "../src/shared/insecure";
import { decodeSettings } from "../src/shared/settings";

const on = { enabled: true, allowed: [] };

describe("insecure sites", () => {
  test("http:// pages are tried over HTTPS first", () => {
    expect(insecureAction("http://example.com/a?b=1#c", on)).toEqual({
      kind: "upgrade",
      url: "https://example.com/a?b=1#c",
    });
    expect(insecureAction("HTTP://Example.COM", on)).toEqual({ kind: "upgrade", url: "https://example.com/" });
    // The default port is no port of its own.
    expect(insecureAction("http://example.com:80/", on)).toEqual({ kind: "upgrade", url: "https://example.com/" });
  });

  test("a port of its own is warned about without trying HTTPS", () => {
    expect(insecureAction("http://example.com:8080/", on)).toEqual({ kind: "warn" });
  });

  test("secure pages, other schemes and broken URLs open as they are", () => {
    for (const url of [
      "https://example.com/",
      "file:///tmp/a.pdf",
      "about:blank",
      "chrome-extension://abc/options.html",
      "not a url",
      "",
    ])
      expect(insecureAction(url, on)).toEqual({ kind: "allow" });
  });

  test("local addresses are never warned about", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "127.8.9.10",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.10.20",
      "100.100.1.2",
      "[::1]",
      "[fd12:3456::1]",
      "[fe80::1]",
      "[::ffff:192.168.0.1]",
      "[::ffff:c0a8:1]",
      "router",
      "nas.local",
      "printer.lan",
      "box.home.arpa",
      "service.internal",
      "localhost.",
    ]) {
      expect(isLocalHost(host)).toBe(true);
      expect(insecureAction(`http://${host}:3000/`, on)).toEqual({ kind: "allow" });
    }
    for (const host of [
      "example.com",
      "8.8.8.8",
      "172.32.0.1",
      "192.169.0.1",
      "100.128.0.1",
      "11.0.0.1",
      "[2001:db8::1]",
      "[::ffff:8.8.8.8]",
      "[::ffff:808:808]",
      "localhost.example.com",
      "local.example",
    ])
      expect(isLocalHost(host)).toBe(false);
  });

  test("allowed sites and the switch", () => {
    const allowed = { enabled: true, allowed: ["example.com"] };
    expect(insecureAction("http://example.com/page", allowed)).toEqual({ kind: "allow" });
    expect(insecureAction("http://EXAMPLE.com./page", allowed)).toEqual({ kind: "allow" });
    // A host, not its subdomains.
    expect(insecureAction("http://www.example.com/", allowed).kind).toBe("upgrade");
    expect(insecureAction("http://example.com/", { enabled: false, allowed: [] })).toEqual({ kind: "allow" });
  });

  test("the address bar says when a page isn't secure", () => {
    expect(isInsecureUrl("http://example.com/")).toBe(true);
    expect(isInsecureUrl("http://example.com:8080/")).toBe(true);
    expect(isInsecureUrl("https://example.com/")).toBe(false);
    expect(isInsecureUrl("http://localhost:5173/")).toBe(false);
    expect(isInsecureUrl("http://192.168.1.1/")).toBe(false);
    expect(insecureHostOf("http://Example.com.:81/x")).toBe("example.com");
    expect(insecureHostOf("nope")).toBe("");
  });

  test("settings: on by default, with no allowed sites", () => {
    const { web } = decodeSettings({});
    expect(web.warnInsecure).toBe(true);
    expect(web.insecureAllowed).toEqual([]);
  });
});
