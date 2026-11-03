// The app's server: API routes, realtime updates and the frontend
// (src/index.html, bundled by Bun with hot reloading in dev).
import { serve } from "bun";
import { db } from "./db";
import index from "./index.html";
import { realtime } from "./realtime";

const server = serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/api/notes": {
      GET: () => Response.json(db.query("SELECT * FROM notes ORDER BY id DESC").all()),
      POST: async (req) => {
        const { text } = (await req.json()) as { text?: string };
        if (!text?.trim()) return Response.json({ error: "text is required" }, { status: 400 });
        const note = db.query("INSERT INTO notes (text) VALUES (?) RETURNING *").get(text.trim());
        realtime.publish("notes");
        return Response.json(note, { status: 201 });
      },
    },
    "/api/notes/:id": {
      DELETE: (req) => {
        db.query("DELETE FROM notes WHERE id = ?").run(Number(req.params.id));
        realtime.publish("notes");
        return new Response(null, { status: 204 });
      },
    },
    "/api/live": realtime.upgrade,
    // Everything else is the frontend (client-side routing works too).
    "/*": index,
  },
  websocket: realtime.websocket,
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

realtime.attach(server);
console.log(`Listening on ${server.url}`);
