// The website: a single static page with no JavaScript. Images (the icon,
// screenshots) come from the browser's package, so there's one copy of each.
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * What the page may load: its own stylesheet and images, nothing else. No
 * scripts at all, so an injected tag can't run. Added to the built page only,
 * since the dev server needs its own client script. Hosts that support headers
 * also get it from public/_headers, with frame-ancestors (ignored in a meta tag).
 */
const csp = [
  "default-src 'none'",
  "img-src 'self'",
  "style-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "upgrade-insecure-requests",
].join("; ");

const contentSecurityPolicy = (): Plugin => ({
  name: "content-security-policy",
  apply: "build",
  transformIndexHtml: () => [
    { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: csp }, injectTo: "head-prepend" },
  ],
});

export default defineConfig({
  plugins: [contentSecurityPolicy()],
  build: {
    // Every asset is a file of its own: no data: URLs for the CSP to allow.
    assetsInlineLimit: 0,
    // Nothing for anyone to read but the page itself.
    sourcemap: false,
  },
  server: {
    // Only what the page uses, not the whole repo (Vite's default is the workspace root).
    fs: { strict: true, allow: [here("."), here("../browser/build"), here("../browser/docs/screenshots")] },
  },
});
