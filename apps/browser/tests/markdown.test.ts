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
