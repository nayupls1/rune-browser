import stylex from "@stylexjs/unplugin";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  root: "src/renderer",
  plugins: [stylex.vite({ useCSSLayers: true }), solid()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    // Desktop app: one bundle is fine (it includes every Lucide icon on purpose).
    chunkSizeWarningLimit: 2000,
  },
});
