// The app's database: SQLite, in the file Rune Browser provides (DATABASE_PATH).
import { Database } from "bun:sqlite";

export const db = new Database(process.env.DATABASE_PATH ?? "data.sqlite", { create: true, strict: true });
db.run("PRAGMA journal_mode = WAL");

// The schema. Add tables and columns here; this runs on every start, so keep
// it idempotent (IF NOT EXISTS, check columns before ALTER TABLE).
db.run(`CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
