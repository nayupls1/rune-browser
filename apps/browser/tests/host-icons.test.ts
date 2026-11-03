import { expect, test } from "bun:test";
import { Glob } from "bun";
import { isIcon } from "../src/server/icons";

// The host UI refers to Lucide icons by string name; a typo renders nothing.
test("every icon name used in the renderer exists", async () => {
  const unknown: string[] = [];
  for await (const file of new Glob("src/renderer/**/*.tsx").scan()) {
    const source = await Bun.file(file).text();
    // <Icon name="x" …>, icon="x" props and { icon: "x" } entries
    for (const [, a, b] of source.matchAll(/<Icon\b[^>]*?\bname="([a-z0-9-]+)"|\bicon(?:=|: )"([a-z0-9-]+)"/g)) {
      const name = a ?? b!;
      if (!isIcon(name)) unknown.push(`${file}: ${name}`);
    }
  }
  expect(unknown).toEqual([]);
});
