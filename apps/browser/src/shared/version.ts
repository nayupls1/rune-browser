// Rune Browser's version, from package.json (bundled in at build time).
import pkg from "../../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
