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
