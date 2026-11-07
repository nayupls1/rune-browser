// The mods Rune Browser's gallery always shows, next to the galleries the user
// added (Settings → Mods): small examples of what a mod can be.
import type { Mod } from "../../shared/mods";

const mod = (
  fields: Omit<Mod, "format" | "version" | "author" | "modVersion" | "theme" | "extensions"> &
    Partial<Pick<Mod, "theme" | "extensions">>,
): Mod => ({
  format: "rune-mod",
  version: 1,
  author: "Rune Browser",
  modVersion: "1",
  theme: null,
  extensions: [],
  ...fields,
});

export const builtInMods: Mod[] = [
  mod({
    id: "rune-quiet-youtube",
    name: "Quiet YouTube",
    description: "Hides Shorts and the comments, so a video is just the video.",
    pageChanges: [
      {
        title: "Hide Shorts",
        scope: { type: "site", value: "www.youtube.com" },
        action: "hide",
        selector: "ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts], a[title='Shorts']",
      },
      {
        title: "Hide comments",
        scope: { type: "site", value: "www.youtube.com" },
        action: "hide",
        selector: "ytd-comments#comments",
      },
    ],
  }),
  mod({
    id: "rune-readable-hacker-news",
    name: "Readable Hacker News",
    description: "Bigger text and a narrower column on Hacker News.",
    pageChanges: [
      {
        title: "Bigger text, narrower column",
        scope: { type: "site", value: "news.ycombinator.com" },
        action: "css",
        value:
          "#hnmain { max-width: 860px; margin: 0 auto; } .title, .comment, .commtext { font-size: 15px !important; line-height: 1.5; } .subtext { font-size: 12px !important; }",
      },
    ],
  }),
  mod({
    id: "rune-wikipedia-focus",
    name: "Wikipedia focus",
    description: "Hides donation banners and lets articles use a comfortable reading width.",
    pageChanges: [
      {
        title: "Hide donation banners",
        scope: { type: "pattern", value: "*.wikipedia.org/*" },
        action: "hide",
        selector: "#centralNotice, .frb, .cn-fundraising",
      },
      {
        title: "Comfortable reading width",
        scope: { type: "pattern", value: "*.wikipedia.org/wiki/*" },
        action: "style",
        selector: "#bodyContent",
        value: "max-width: 52rem; font-size: 1.05rem",
      },
    ],
  }),
  mod({
    id: "rune-sunset-theme",
    name: "Sunset",
    description: "A dark Rune Browser with a warm orange accent and rounded corners.",
    pageChanges: [],
    theme: { mode: "dark", accent: "#f97316", radius: "lg", font: "rounded" },
  }),
];
