// Ranking Lucide icons for a search (the server's search_icons tool and the icon picker).

/** Icon names ranked by how well their name and tags match the query words. */
export function rankIcons(tags: Record<string, string[]>, query: string, limit = 30): string[] {
  const words = query
    .toLowerCase()
    .split(/[\s,-]+/)
    .filter(Boolean);
  if (!words.length) return [];
  const scored: [string, number][] = [];
  for (const [name, keywords] of Object.entries(tags)) {
    let score = 0;
    for (const word of words) {
      if (name === word) score += 10;
      else if (name.split("-").includes(word)) score += 6;
      else if (name.includes(word)) score += 3;
      if (keywords.some((k) => k === word)) score += 4;
      else if (keywords.some((k) => k.includes(word))) score += 1;
    }
    if (score) scored.push([name, score]);
  }
  return scored
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([name]) => name);
}
