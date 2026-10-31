// Files given to the agent with a message (agent/Attachments.ts): uploaded per
// tab, served back for the chat (images inline, others as downloads), and
// turned into what the provider gets: text files in the prompt, images and
// PDFs as files, the rest by path.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { Attachments } from "../src/server/agent/Attachments";
import { Apps } from "../src/server/db/Apps";
import { readConfig } from "../src/server/Config";
import { core } from "../src/server/services";
import { startServer } from "./lib/server";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("attachments over the API", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => (server = await startServer()));
  afterAll(() => server.stop());

  test("an image is uploaded and served inline; other files only as downloads", async () => {
    const tab = await server.api<{ id: string }>("/api/apps", {
      method: "POST",
      json: { kind: "web", url: "https://example.com" },
    });
    const image = await server.api<{ id: string; name: string; mime: string; size: number }>(
      `/api/apps/${tab.id}/attachments`,
      {
        method: "POST",
        json: { name: "shot.png", mime: "image/png", data: PNG.toString("base64") },
      },
    );
    expect(image).toMatchObject({ name: "shot.png", mime: "image/png", size: PNG.length });
    const res = await fetch(`${server.url}/api/apps/${tab.id}/attachments/${image.id}?token=${server.token}`);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PNG));

    const html = await server.api<{ id: string }>(`/api/apps/${tab.id}/attachments`, {
      method: "POST",
      json: { name: "page.html", mime: "text/html", data: Buffer.from("<script>alert(1)</script>").toString("base64") },
    });
    const download = await fetch(`${server.url}/api/apps/${tab.id}/attachments/${html.id}?token=${server.token}`);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    // Another tab can't reach it, and without the token nothing is served.
    const other = await server.api<{ id: string }>("/api/apps", { method: "POST", json: { kind: "app" } });
    expect(
      (await fetch(`${server.url}/api/apps/${other.id}/attachments/${image.id}?token=${server.token}`)).status,
    ).toBe(404);
    expect((await fetch(`${server.url}/api/apps/${tab.id}/attachments/${image.id}`)).status).toBe(401);
    await expect(
      server.api(`/api/apps/${tab.id}/attachments`, {
        method: "POST",
        json: { name: "empty.txt", mime: "text/plain", data: "" },
      }),
    ).rejects.toThrow("empty");
  });
});

describe("what the provider gets", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rune-attachments-"));
  const runtime = ManagedRuntime.make(core(readConfig({ RUNE_DATA_DIR: dataDir, PORT: "1" })));
  afterAll(async () => {
    await runtime.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("text files go into the prompt, images and PDFs as files, the rest by path", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const attachments = yield* Attachments;
        const apps = yield* Apps;
        const tab = (yield* apps.create("default", "app", null)).id;
        const other = (yield* apps.create("default", "app", null)).id;
        const save = (name: string, mime: string, data: Uint8Array) => attachments.save(tab, { name, mime, data });
        const ids = [
          (yield* save("notes.md", "text/markdown", new TextEncoder().encode("# Ideas\nDark mode"))).id,
          (yield* save("shot.png", "image/png", PNG)).id,
          (yield* save("spec.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.4"))).id,
          (yield* save("data.zip", "application/zip", new Uint8Array([80, 75, 3, 4]))).id,
        ];
        const files = [];
        for (const id of ids) files.push((yield* attachments.get(tab, id))!);
        expect(yield* attachments.get(other, ids[0]!)).toBeNull();
        expect(yield* attachments.get(tab, "../../etc/passwd")).toBeNull();
        // In the chat's folder, by name (a taken name gets a number).
        expect(files[1]!.path).toEndWith(join("attachments", "shot.png"));
        expect((yield* save("shot.png", "image/png", PNG)).name).toBe("shot (2).png");
        return yield* attachments.forTurn("Make it like this", files);
      }),
    );
    expect(result.prompt).toStartWith(
      '<attached-file name="notes.md">\n# Ideas\nDark mode\n</attached-file>\n\nMake it like this',
    );
    expect(result.prompt).toContain("- attachments/data.zip (");
    expect(result.files.map((f) => f.name)).toEqual(["shot.png", "spec.pdf", "data.zip"]);
  });
});
