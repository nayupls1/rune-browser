// Minimal Markdown → HTML for agent replies. Input is
// escaped first, so the agent (or data) can never inject markup; only the
// constructs below are produced. Links must be http(s) or mailto.

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function inline(text: string): string {
  const codes: string[] = [];
  let out = escape(text).replace(/`([^`]+)`/g, (_, code: string) => `\u0000${codes.push(code) - 1}\u0000`);
  out = out
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(
      /\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

export function markdownToHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++; // closing fence
      html.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html.push("<hr>");
      i++;
      continue;
    }

    const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (!m || /\d/.test(m[1]!) !== ordered) break;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(m[2]!);
        items.push(
          task
            ? `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${inline(task[2]!)}</li>`
            : `<li>${inline(m[2]!)}</li>`,
        );
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) quote.push(lines[i++]!.replace(/^>\s?/, ""));
      html.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]!))
      para.push(lines[i++]!);
    html.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }
  return html.join("\n");
}
