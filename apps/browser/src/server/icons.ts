// Lucide icon names (from lucide-static, kept at the same version as
// lucide-solid, which renders them): a tab's own icon must be one of them.
import tags from "lucide-static/tags.json" with { type: "json" };

const names = new Set(Object.keys(tags as Record<string, string[]>));

export const isIcon = (name: string) => names.has(name);
