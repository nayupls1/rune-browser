// Lucide icon names and search tags (from lucide-static, kept at the same
// version as lucide-solid, which renders them).
import tags from "lucide-static/tags.json" with { type: "json" };
import { rankIcons } from "../shared/icons";

const iconTags = tags as Record<string, string[]>;
const names = new Set(Object.keys(iconTags));

export const isIcon = (name: string) => names.has(name);

/** Ranks icons by how well their name and tags match the query words. */
export const searchIcons = (query: string, limit = 30): string[] => rankIcons(iconTags, query, limit);
