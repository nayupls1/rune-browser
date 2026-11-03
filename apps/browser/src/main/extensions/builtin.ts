// Rune Browser's own extension, loaded into every web tab session: it applies the
// network rules (Settings → Network) as declarativeNetRequest session rules.
// Electron gives session webRequest hooks precedence over extensions, so hooks
// would switch off uBlock Origin Lite and the like; rules that are DNR rules
// work alongside theirs. The work happens in its service worker's preload
// (see src/extension-preload/shim.ts); its own script is empty.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionsDir } from "./registry";

/** Gives the extension its fixed ID (BUILTIN_EXTENSION_ID). */
const KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3MPc/a0yYL24XqOWUSPnuPS1JSbjmsmt5Xc6B4Jm1OqsuW1YFcna/BXKBr6+WSip6oiQbI8984IBXUzMYE0+9w/7C5N8bMoK9kwzyn+HR3CYcAn6irmwjplpkzHE6gxbD/CUkdkAPEawNVxFI6lO0TT6pLTms6Y34K7avllo97M4+KrEioi6eiEYFZXsgn4rm1oA3rsp4CrdBKlAYVJsi50mJ4NdklBdSpE87Bsl/OvOLrq4bkU05e9XvnvGEbhJVlRJ91CSBpbA79HdRIKTKB2itUDbPDI9y/JyMuV6DA+bYPptrlfi4TlX/i09piF3XeY88zWwlcloLdVYKN7JAwIDAQAB";

const FILES: Record<string, string> = {
  "manifest.json": JSON.stringify(
    {
      manifest_version: 3,
      name: "Rune Browser network rules",
      version: "1.0",
      key: KEY,
      permissions: ["declarativeNetRequest"],
      host_permissions: ["<all_urls>"],
      background: { service_worker: "background.js" },
    },
    null,
    2,
  ),
  "background.js": "// Rune Browser's network rules are applied by its preload.\n",
};

/** Writes the extension into Rune Browser's data (extensions can't be loaded from the app's asar). Returns its folder. */
export function builtinExtensionDir() {
  const dir = join(extensionsDir(), "builtin", "network-rules");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(FILES)) {
    const file = join(dir, name);
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) writeFileSync(file, content);
  }
  return dir;
}
