// The frontend: plain TypeScript and DOM. Bun bundles it (see index.html).
import { onReconnect, subscribe } from "./live";

interface Note {
  id: number;
  text: string;
  created_at: string;
}

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
  return (res.status === 204 ? undefined : await res.json()) as T;
};

const root = document.getElementById("root")!;
root.innerHTML = `
  <main class="page">
    <h1></h1>
    <p class="muted">A starting point: notes saved in SQLite, live in every open window.</p>
    <form class="row"><input placeholder="Write a note…" /><button type="submit">Add</button></form>
    <ul class="list"></ul>
  </main>`;
root.querySelector("h1")!.textContent = document.title;
const form = root.querySelector("form")!;
const input = root.querySelector("input")!;
const list = root.querySelector("ul")!;

async function render() {
  const notes = await api<Note[]>("/api/notes");
  list.replaceChildren(
    ...notes.map((note) => {
      const li = document.createElement("li");
      li.className = "card";
      const text = document.createElement("span");
      text.textContent = note.text;
      const remove = document.createElement("button");
      remove.className = "ghost";
      remove.textContent = "Delete";
      remove.onclick = () => api(`/api/notes/${note.id}`, { method: "DELETE" });
      li.append(text, remove);
      return li;
    }),
  );
}

form.onsubmit = async (e) => {
  e.preventDefault();
  if (!input.value.trim()) return;
  await api("/api/notes", { method: "POST", body: JSON.stringify({ text: input.value }) });
  input.value = "";
};

subscribe("notes", render);
onReconnect(render);
void render();
