// AI for this app, through Rune Browser: it answers with the user's own AI
// subscription (chosen in Rune Browser's Settings), so the app needs no API key.
//
// SERVER-SIDE ONLY. RUNE_AI_TOKEN is this app's key: never send it to the
// browser, log it or write it to a file. Rune Browser rejects requests from browsers;
// let the frontend call your own API route, and call `ai` from there.
//
//   const { text } = await ai.chat("Summarize: " + note);
//   const tags = await ai.json<string[]>("Three tags for: " + note);
//   for await (const chunk of ai.stream([{ role: "user", content: question }])) send(chunk);

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface Options {
  /** Instructions for the model (how to answer, format, tone). */
  system?: string;
  /** A model id from `ai.models()`; default: the one picked in Rune Browser's Settings. */
  model?: string;
  effort?: string;
}

export class AiError extends Error {
  constructor(
    message: string,
    /** 401 bad token, 403 turned off, 429 daily limit reached, 503 provider unavailable, 504 timeout. */
    readonly status: number,
  ) {
    super(message);
  }
}

const url = process.env.RUNE_AI_URL;
const token = process.env.RUNE_AI_TOKEN;

async function call(path: string, init?: { body: unknown }) {
  if (!url || !token) throw new AiError("AI isn't available: the app isn't running inside Rune Browser", 503);
  const res = await fetch(`${url}${path}`, {
    method: init ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new AiError(body?.error ?? `AI request failed (${res.status})`, res.status);
  }
  return res;
}

const toMessages = (input: string | Message[]): Message[] => (typeof input === "string" ? [{ role: "user", content: input }] : input);

export const ai = {
  /** Whether AI is on, which model answers, and today's usage. */
  async models(): Promise<{ enabled: boolean; provider: string; model: string | null; models: { id: string; name: string }[]; usage: { today: number; limit: number } }> {
    return (await call("/models")).json();
  },

  /** One answer. Pass a string or a conversation (ending with a user message). */
  async chat(input: string | Message[], options: Options = {}): Promise<{ text: string; provider: string; model: string | null }> {
    return (await call("/chat", { body: { messages: toMessages(input), ...options } })).json();
  },

  /** An answer as JSON (the model is asked for a single JSON value; parse errors throw). */
  async json<T = unknown>(input: string | Message[], options: Options = {}): Promise<T> {
    const res = (await (await call("/chat", { body: { messages: toMessages(input), ...options, json: true } })).json()) as { text: string; json?: T };
    if (res.json === undefined) throw new AiError(`The model didn't reply with JSON: ${res.text.slice(0, 200)}`, 502);
    return res.json;
  },

  /** The answer as it's written, chunk by chunk. */
  async *stream(input: string | Message[], options: Options = {}): AsyncGenerator<string> {
    const res = await call("/chat", { body: { messages: toMessages(input), ...options, stream: true } });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as { type: string; text?: string; message?: string; status?: number };
        if (event.type === "delta") yield event.text!;
        else if (event.type === "error") throw new AiError(event.message!, event.status ?? 503);
      }
    }
  },
};
