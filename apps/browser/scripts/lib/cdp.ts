// Minimal Chrome DevTools Protocol client for driving the Electron renderer.

/** Every wait is this many times longer (E2E_TIMEOUT_SCALE), for slow machines like CI's Windows runners. */
export const TIMEOUT_SCALE = Math.max(Number(process.env.E2E_TIMEOUT_SCALE) || 1, 1);

export class Page {
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, ((params: any) => void)[]>();

  /** Out-of-process iframes (custom components), by URL, once attachChildren() ran. */
  readonly children = new Map<string, { sessionId: string; url: string; type: string }>();

  private constructor(private ws: WebSocket) {
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.method === "Target.attachedToTarget") {
        const { sessionId, targetInfo } = msg.params;
        this.children.set(sessionId, { sessionId, url: targetInfo.url, type: targetInfo.type });
      } else if (msg.method === "Target.detachedFromTarget") {
        this.children.delete(msg.params.sessionId);
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
      } else {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    };
  }

  /** Connects to the first app page exposed on the remote debugging port (or the first target `pick` picks). */
  static async connect(
    port: number,
    timeoutMs = 20_000,
    pick?: (target: { type: string; url: string }) => boolean,
  ): Promise<Page> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
          type: string;
          url: string;
          webSocketDebuggerUrl: string;
        }[];
        // Extensions' offscreen documents are pages too: the app's own comes first.
        const pages = targets.filter(
          (t) => t.type === "page" && !t.url.startsWith("devtools://") && !t.url.startsWith("chrome-extension://"),
        );
        const target = pick ? targets.find(pick) : (pages.find((t) => t.url.startsWith("app://")) ?? pages[0]);
        if (target) {
          const ws = new WebSocket(target.webSocketDebuggerUrl);
          await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
          });
          return new Page(ws);
        }
      } catch {
        // not up yet
      }
      await Bun.sleep(200);
    }
    throw new Error(`No page on debugging port ${port}`);
  }

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      // A blocked renderer would otherwise hang the caller forever.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no response within 30s`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Tracks cross-origin iframes as child sessions (see `children`, `evalIn`). */
  attachChildren() {
    return this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  /** Evaluates in the first child frame whose URL contains `urlPart`. */
  async evalIn<T = unknown>(urlPart: string, expression: string): Promise<T> {
    const child = [...this.children.values()].find((c) => c.url.includes(urlPart));
    if (!child) throw new Error(`no child frame matching ${urlPart}`);
    const res = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      child.sessionId,
    );
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value as T;
  }

  on(method: string, fn: (params: any) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), fn]);
  }

  /** Accepts confirm()/alert() dialogs automatically (requires Page.enable). */
  acceptDialogs() {
    this.on("Page.javascriptDialogOpening", () => {
      void this.send("Page.handleJavaScriptDialog", { accept: true });
    });
  }

  /** Evaluates an expression (awaiting promises) and returns its JSON value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const res = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result.value as T;
  }

  /** Polls an expression until it is truthy. */
  async waitFor<T>(expression: string, { timeoutMs = 10_000, label = expression } = {}): Promise<T> {
    const deadline = Date.now() + timeoutMs * TIMEOUT_SCALE;
    for (;;) {
      const value = await this.eval<T>(expression).catch(() => undefined);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
      await Bun.sleep(150);
    }
  }

  async screenshot(path: string, { fullPage = false } = {}) {
    const res = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
    });
    await Bun.write(path, Buffer.from(res.data, "base64"));
  }

  close() {
    this.ws.close();
  }
}
