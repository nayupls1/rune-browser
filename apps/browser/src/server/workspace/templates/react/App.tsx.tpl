import { useState } from "react";
import { useLive } from "./useLive";

interface Note {
  id: number;
  text: string;
  created_at: string;
}

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
  return (res.status === 204 ? undefined : await res.json()) as T;
};

export function App() {
  const notes = useLive("notes", () => api<Note[]>("/api/notes"));
  const [text, setText] = useState("");

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    await api("/api/notes", { method: "POST", body: JSON.stringify({ text }) });
    setText("");
  };

  return (
    <main className="page">
      <h1>{document.title}</h1>
      <p className="muted">A starting point: notes saved in SQLite, live in every open window.</p>
      <form className="row" onSubmit={add}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a note…" />
        <button type="submit">Add</button>
      </form>
      <ul className="list">
        {notes.data?.map((note) => (
          <li key={note.id} className="card">
            <span>{note.text}</span>
            <button className="ghost" onClick={() => api(`/api/notes/${note.id}`, { method: "DELETE" })}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
