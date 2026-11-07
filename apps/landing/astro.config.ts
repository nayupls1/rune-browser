import stylex from "@stylexjs/unplugin";
import { defineConfig } from "astro/config";

export default defineConfig({
  vite: { plugins: [stylex.vite({ useCSSLayers: true })] },
  build: { inlineStylesheets: "never" },
});
