// Plain HTTP in web tabs (docs/browsing.md: Insecure sites). A page over http://
// is opened over HTTPS when it can be (the same address, upgraded), and Rune
// Browser warns before showing it unencrypted when it can't. Local addresses
// (this computer, the private network) and the sites the user allowed are left
// alone. The renderer decides (components/WebTab.tsx); the main process holds
// back the navigations pages start themselves and their redirects
// (main/web.ts) and hands them to the renderer.

/** What web tabs go by: the switch, and the hosts allowed over HTTP (saved ones and those allowed until restart). */
export interface InsecurePolicy {
  enabled: boolean;
  allowed: readonly string[];
}

export type InsecureAction =
  /** Opens as it is. */
  | { kind: "allow" }
  /** Try the HTTPS version first; warn if it fails. */
  | { kind: "upgrade"; url: string }
  /** Warn first (no HTTPS version to try: a port of its own). */
  | { kind: "warn" };

const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain"];

function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const bytes = parts.map(Number);
  return bytes.every((b) => b <= 255) ? bytes : null;
}

/** This computer or the private network: loopback, private and link-local addresses, and names only a local network has. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (host.startsWith("[")) {
    const ip = host.slice(1, -1);
    // Loopback, unique local (fc00::/7), link-local (fe80::/10), and IPv4 written as IPv6.
    if (ip === "::1" || ip === "::") return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(ip) || /^fe[89ab][0-9a-f]?:/.test(ip)) return true;
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (dotted) return isLocalHost(dotted[1]!);
    // URLs write it in hex: [::ffff:c0a8:1] is 192.168.0.1.
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
    if (!hex) return false;
    const [high, low] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    return isLocalHost([high >> 8, high & 255, low >> 8, low & 255].join("."));
  }
  const bytes = ipv4(host);
  if (bytes) {
    const [a, b] = bytes as [number, number, number, number];
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      // Carrier-grade NAT, where VPNs like Tailscale put their devices.
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host === "localhost" || !host.includes(".")) return true;
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** The host a site is allowed as (lowercase, without a trailing dot). */
export const insecureHostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
};

/** What to do before opening `url` in a web tab. */
export function insecureAction(url: string, policy: InsecurePolicy): InsecureAction {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "allow" };
  }
  if (parsed.protocol !== "http:" || !policy.enabled) return { kind: "allow" };
  const host = insecureHostOf(url);
  if (!host || isLocalHost(host) || policy.allowed.includes(host)) return { kind: "allow" };
  // A port of its own has no HTTPS version on the same port to try.
  if (parsed.port) return { kind: "warn" };
  parsed.protocol = "https:";
  return { kind: "upgrade", url: parsed.toString() };
}

/** Shown over plain HTTP, and not a local address: the address bar says it isn't secure. */
export const isInsecureUrl = (url: string) => insecureAction(url, { enabled: true, allowed: [] }).kind !== "allow";
