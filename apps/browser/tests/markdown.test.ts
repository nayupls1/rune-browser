import { expect, test } from "bun:test";
import { markdownToHtml } from "../src/shared/markdown";

test("renders the supported subset", () => {
  expect(markdownToHtml("# Title\n\nSome **bold**, *em*, `code` and [a link](https://x.dev).")).toBe(
    '<h1>Title</h1>\n<p>Some <strong>bold</strong>, <em>em</em>, <code>code</code> and <a href="https://x.dev" target="_blank" rel="noreferrer">a link</a>.</p>',
  );
  expect(markdownToHtml("- one\n- [x] done\n1. first")).toBe(
    '<ul><li>one</li><li class="task"><input type="checkbox" disabled checked> done</li></ul>\n<ol><li>first</li></ol>',
  );
  expect(markdownToHtml("```\n<b>x</b>\n```")).toBe("<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>");
  expect(markdownToHtml("> quoted\n\n---")).toBe("<blockquote>quoted</blockquote>\n<hr>");
});

test("never lets markup or script links through", () => {
  const html = markdownToHtml("<img src=x onerror=alert(1)> [x](javascript:alert(1)) **<script>**");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script");
  expect(html).not.toContain('href="javascript');
});

test("keeps code spans literal", () => {
  expect(markdownToHtml("`**not bold**`")).toBe("<p><code>**not bold**</code></p>");
});

test("renders tables, with their alignment", () => {
  const html = markdownToHtml(
    "| Article | Time |\n| --- | ---: |\n| The **small** web | 8 min |\n| <b> | 6 |\n\nAfter.",
  );
  expect(html).toContain('<table><thead><tr><th>Article</th><th style="text-align:right">Time</th></tr></thead>');
  expect(html).toContain("<td>The <strong>small</strong> web</td>");
  expect(html).toContain("<td>&lt;b&gt;</td>");
  expect(html).toContain("<p>After.</p>");
  // Pipes in code or escaped stay in their cell; a table right under a paragraph line still is one.
  const tricky = markdownToHtml("Results:\n| Expr | Means |\n| --- | --- |\n| `a | b` | either \\| or |");
  expect(tricky).toContain("<p>Results:</p>");
  expect(tricky).toContain("<td><code>a | b</code></td><td>either | or</td>");
  // A lone row of pipes isn't a table.
  expect(markdownToHtml("| just text |")).toBe("<p>| just text |</p>");
});

test("links to local files and folders become file links; web links stay links", () => {
  expect(markdownToHtml("See [report.csv](<exports/My report.csv>) and [notes](notes.md).")).toBe(
    '<p>See <span class="rune-file-link" data-file-link="exports/My report.csv">report.csv</span> and <span class="rune-file-link" data-file-link="notes.md">notes</span>.</p>',
  );
  expect(markdownToHtml("[the folder](</home/me/My Files/>) [`a.ts`](C:\\work\\a.ts) [x](file:///tmp/x.json)")).toBe(
    '<p><span class="rune-file-link" data-file-link="/home/me/My Files/">the folder</span> <span class="rune-file-link" data-file-link="C:\\work\\a.ts"><code>a.ts</code></span> <span class="rune-file-link" data-file-link="file:///tmp/x.json">x</span></p>',
  );
  // Web links (also in <…>) are links, never chips.
  expect(markdownToHtml("[docs](<https://x.dev/a>)")).toBe(
    '<p><a href="https://x.dev/a" target="_blank" rel="noreferrer">docs</a></p>',
  );
  // Other schemes and anchors stay text; quotes can't leave the attribute.
  for (const target of ["javascript:alert(1)", "data:text/html,x", "#top", "//evil.example/x"])
    expect(markdownToHtml(`[x](${target})`)).not.toContain("data-file-link");
  const quoted = markdownToHtml('[x](<a" onclick="alert(1)>)');
  expect(quoted).toContain('data-file-link="a&quot; onclick=&quot;alert(1)"');
  expect(quoted).not.toContain('" onclick="');
});
