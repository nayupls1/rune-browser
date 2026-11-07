// Presets: starting points for an app's project, picked by the agent. Each is
// a Bun server (API routes, SQLite, realtime) with or without a frontend; the
// agent can change anything afterwards, or write its own rune.json for a
// different stack. Templates are bundled as text (`{{…}}` placeholders).
import type { Manifest, PresetInfo } from "../../shared/api";
import apiPackage from "./templates/api/package.json.tpl" with { type: "text" };
import apiServer from "./templates/api/server.ts.tpl" with { type: "text" };
import reactApp from "./templates/react/App.tsx.tpl" with { type: "text" };
import reactIndex from "./templates/react/index.html.tpl" with { type: "text" };
import reactMain from "./templates/react/main.tsx.tpl" with { type: "text" };
import reactPackage from "./templates/react/package.json.tpl" with { type: "text" };
import reactServer from "./templates/react/server.ts.tpl" with { type: "text" };
import reactUseLive from "./templates/react/useLive.ts.tpl" with { type: "text" };
import agents from "./templates/shared/AGENTS.md.tpl" with { type: "text" };
import aiClient from "./templates/shared/ai.ts.tpl" with { type: "text" };
import db from "./templates/shared/db.ts.tpl" with { type: "text" };
import gitignore from "./templates/shared/gitignore.tpl" with { type: "text" };
import live from "./templates/shared/live.ts.tpl" with { type: "text" };
import realtime from "./templates/shared/realtime.ts.tpl" with { type: "text" };
import styles from "./templates/shared/styles.css.tpl" with { type: "text" };
import tsconfig from "./templates/shared/tsconfig.json.tpl" with { type: "text" };
import vanillaIndex from "./templates/vanilla/index.html.tpl" with { type: "text" };
import vanillaMain from "./templates/vanilla/main.ts.tpl" with { type: "text" };
import vanillaPackage from "./templates/vanilla/package.json.tpl" with { type: "text" };
import vanillaServer from "./templates/vanilla/server.ts.tpl" with { type: "text" };

export interface Preset extends PresetInfo {
  manifest: Manifest;
  files: Record<string, string>;
}

const scripts: Manifest = { dev: "bun run dev", build: "bun run build", start: "bun run start" };

const backend = {
  "src/db.ts": db,
  "src/ai.ts": aiClient,
  "src/realtime.ts": realtime,
  ".gitignore": gitignore,
  "AGENTS.md": agents,
  "tsconfig.json": tsconfig,
};

export const presets: Preset[] = [
  {
    id: "react",
    name: "React",
    description: "A React single-page app with a Bun server for the API, a SQLite database and realtime updates.",
    stack: "React · Bun API · SQLite · realtime",
    manifest: { preset: "react", ...scripts },
    files: {
      ...backend,
      "package.json": reactPackage,
      "src/server.ts": reactServer,
      "src/index.html": reactIndex,
      "src/main.tsx": reactMain,
      "src/App.tsx": reactApp,
      "src/useLive.ts": reactUseLive,
      "src/live.ts": live,
      "src/styles.css": styles,
    },
  },
  {
    id: "vanilla",
    name: "Vanilla",
    description:
      "Plain HTML, CSS and TypeScript (no framework) with a Bun server, a SQLite database and realtime updates.",
    stack: "HTML/CSS/TS · Bun API · SQLite · realtime",
    manifest: { preset: "vanilla", ...scripts },
    files: {
      ...backend,
      "package.json": vanillaPackage,
      "src/server.ts": vanillaServer,
      "src/index.html": vanillaIndex,
      "src/main.ts": vanillaMain,
      "src/live.ts": live,
      "src/styles.css": styles,
    },
  },
  {
    id: "api",
    name: "API only",
    description: "A JSON API on a Bun server with a SQLite database and realtime updates, without a frontend.",
    stack: "Bun API · SQLite · realtime",
    manifest: { preset: "api", ...scripts },
    files: { ...backend, "package.json": apiPackage, "src/server.ts": apiServer },
  },
];

export const presetInfo = (p: Preset): PresetInfo => ({
  id: p.id,
  name: p.name,
  description: p.description,
  stack: p.stack,
});

export const findPreset = (id: string) => presets.find((p) => p.id === id);

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "app";

/** Fills in the placeholders of a template. */
export function render(template: string, vars: { name: string }) {
  return template
    .replaceAll("{{nameHtml}}", escapeHtml(vars.name))
    .replaceAll("{{slug}}", slugify(vars.name))
    .replaceAll("{{name}}", vars.name.replace(/[\r\n]/g, " "));
}
