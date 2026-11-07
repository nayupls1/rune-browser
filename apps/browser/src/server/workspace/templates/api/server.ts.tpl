// The app's server: a JSON API with realtime updates (no frontend).
import { serve } from "bun";
import { db } from "./db";
import { realtime } from "./realtime";

const server = serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": () =>
      Response.json({
        name: "{{slug}}",
        endpoints: ["GET /api/notes", "POST /api/notes { text }", "DELETE /api/notes/:id", "WS /api/live"],
      }),
    "/api/notes": {
      GET: () => Response.json(db.query("SELECT * FROM notes ORDER BY id DESC").all()),
      POST: async (req) => {
        const { text } = (await req.json()) as { text?: string };
        if (!text?.trim()) return Response.json({ error: "text is required" }, { status: 400 });
        const note = db.query("INSERT INTO notes (text) VALUES (?) RETURNING *").get(text.trim());
        realtime.publish("notes", note);
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
  },
  websocket: realtime.websocket,
  fetch: () => Response.json({ error: "Not found" }, { status: 404 }),
});

realtime.attach(server);
console.log(`Listening on ${server.url}`);
