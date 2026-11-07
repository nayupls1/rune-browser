// What every page says about the product: links, the version (from the browser's own package.json, so
// it's always the released one), and the agents it runs on.
import browser from "../../../browser/package.json";

export const version = browser.version;
export const repo = "https://github.com/nayupls1/rune-browser";
export const download = `${repo}/releases/latest`;
export const harnesses = ["Claude Code", "Codex", "OpenCode"] as const;
