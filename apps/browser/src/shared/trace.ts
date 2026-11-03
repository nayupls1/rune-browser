// What a performance trace says, the way DevTools' Performance panel would:
// web vitals, long tasks and what ran in them, where the main thread's time
// went, layout shifts, forced reflows, the heaviest requests and the hottest
// functions. Used on traces the agent records (main/devtools.ts); the trace
// itself is saved too, for Chrome DevTools.

/** A Chrome trace event (the parts used here). Times are in microseconds. */
export interface TraceEvent {
  name: string;
  cat?: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  id?: string | number;
  args?: { data?: any; frame?: string; name?: string; [key: string]: any };
}

export interface TraceAnalysis {
  url: string | null;
  durationMs: number;
  vitals: {
    /** Since the navigation started, when the trace has one. */
    ttfbMs: number | null;
    fcpMs: number | null;
    lcpMs: number | null;
    lcpElement: string | null;
    domContentLoadedMs: number | null;
    loadMs: number | null;
    cls: number;
    totalBlockingTimeMs: number;
    /** The slowest interaction (Interaction to Next Paint), if there was one. */
    inpMs: number | null;
  };
  mainThread: { busyMs: number; byCategory: Record<string, number> };
  longTasks: { startMs: number; durationMs: number; work: string[] }[];
  layoutShifts: { atMs: number; score: number; nodes: string[] }[];
  forcedReflows: { count: number; totalMs: number; by: string[] };
  requests: {
    count: number;
    transferKb: number;
    slowest: RequestInfo[];
    largest: RequestInfo[];
    renderBlocking: string[];
    failed: string[];
  };
  hotFunctions: { name: string; where: string; selfMs: number }[];
  gcMs: number;
}

interface RequestInfo {
  url: string;
  ms: number;
  kb: number;
  status: number | null;
  type: string;
}

const ms = (us: number) => Math.round(us / 100) / 10;
const kb = (bytes: number) => Math.round(bytes / 102.4) / 10;

const categoryOf = (name: string): string | null => {
  if (
    /^(FunctionCall|EvaluateScript|v8\.compile|v8\.compileModule|v8\.evaluateModule|v8\.produceCache|TimerFire|EventDispatch|FireAnimationFrame|FireIdleCallback|XHRReadyStateChange|XHRLoad|RunMicrotasks|V8\.Execute|v8\.run|CompileScript|CompileCode|ParseOnBackground|V8\.ScriptCompiler|StreamingCompileScript|CacheScript|MajorGC|MinorGC|V8\.GC_.*|BlinkGC\..*)$/.test(
      name,
    )
  )
    return "scripting";
  if (
    /^(Layout|UpdateLayoutTree|RecalculateStyles|ScheduleStyleRecalculation|InvalidateLayout|UpdateLayerTree|HitTest|IntersectionObserverController::computeIntersections|PrePaint)$/.test(
      name,
    )
  )
    return "rendering";
  if (
    /^(Paint|PaintImage|CompositeLayers|Layerize|RasterTask|Decode Image|ImageDecodeTask|Commit|UpdateLayer|PaintSetup)$/.test(
      name,
    )
  )
    return "painting";
  if (
    /^(ParseHTML|ParseAuthorStyleSheet|ResourceSendRequest|ResourceReceivedData|ResourceReceiveResponse|ResourceFinish)$/.test(
      name,
    )
  )
    return "loading";
  return null;
};

/** Work worth naming in a long task. */
const meaningful = (e: TraceEvent) => categoryOf(e.name) !== null && !/^Resource/.test(e.name);

const isGc = (name: string) => /^(MajorGC|MinorGC|V8\.GC_.*|BlinkGC\..*)$/.test(name);

/** What a piece of work was: a function and its script, an event, a layout… */
function describe(e: TraceEvent): string {
  const d = e.args?.data ?? {};
  const where = (url?: string, line?: number) =>
    url ? `${shortUrl(url)}${typeof line === "number" && line >= 0 ? `:${line + 1}` : ""}` : "";
  switch (e.name) {
    case "FunctionCall":
      return `${d.functionName || "(anonymous)"} ${where(d.url, d.lineNumber)}`.trim();
    case "EvaluateScript":
      return `Evaluate script ${where(d.url, d.lineNumber)}`.trim();
    case "v8.compile":
    case "v8.compileModule":
      return `Compile script ${where(d.url ?? e.args?.fileName)}`.trim();
    case "EventDispatch":
      return `Event: ${d.type ?? "?"}`;
    case "TimerFire":
      return "Timer fired";
    case "FireAnimationFrame":
      return "requestAnimationFrame callback";
    case "ParseHTML":
      return `Parse HTML ${where(d.url)}`.trim();
    case "UpdateLayoutTree":
    case "RecalculateStyles":
      return `Recalculate styles${d.elementCount ? ` (${d.elementCount} elements)` : ""}`;
    case "Layout":
      return `Layout${e.args?.beginData?.dirtyObjects ? ` (${e.args.beginData.dirtyObjects} of ${e.args.beginData.totalObjects} objects)` : ""}`;
    default:
      return e.name;
  }
}

const shortUrl = (url: string) => {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 60 ? `…${u.pathname.slice(-58)}` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url.slice(0, 80);
  }
};

/** The renderer process and main thread of the page that was traced. */
function pageThread(events: TraceEvent[], url: string | null) {
  let pid: number | undefined;
  for (const e of events) {
    if (e.name !== "TracingStartedInBrowser") continue;
    const frames: { processId?: number; url?: string; isOutermostMainFrame?: boolean; parent?: string }[] =
      e.args?.data?.frames ?? [];
    const main = frames.filter((f) => !f.parent && f.processId);
    const match = main.find((f) => url && f.url === url) ?? main.find((f) => f.isOutermostMainFrame) ?? main[0];
    if (match) pid = match.processId;
  }
  // Without that, the renderer whose main thread did the most work.
  const mains = events.filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain");
  if (pid === undefined) {
    const work = new Map<number, number>();
    for (const e of events)
      if (e.ph === "X" && e.name === "RunTask") work.set(e.pid, (work.get(e.pid) ?? 0) + (e.dur ?? 0));
    pid = mains.map((m) => m.pid).sort((a, b) => (work.get(b) ?? 0) - (work.get(a) ?? 0))[0];
  }
  const tid = mains.find((m) => m.pid === pid)?.tid;
  return { pid, tid };
}

/** Self time of complete events on one thread (their own time, without what's nested in them), with their ancestors. */
function walk(events: TraceEvent[], visit: (e: TraceEvent, self: number, ancestors: TraceEvent[]) => void) {
  const sorted = events
    .filter((e) => e.ph === "X" && typeof e.dur === "number")
    .sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  const stack: { e: TraceEvent; children: number }[] = [];
  const close = (until: number) => {
    while (stack.length && stack.at(-1)!.e.ts + (stack.at(-1)!.e.dur ?? 0) <= until) {
      const top = stack.pop()!;
      visit(
        top.e,
        Math.max(0, (top.e.dur ?? 0) - top.children),
        stack.map((s) => s.e),
      );
    }
  };
  for (const e of sorted) {
    close(e.ts);
    if (stack.length) stack.at(-1)!.children += e.dur ?? 0;
    stack.push({ e, children: 0 });
  }
  close(Infinity);
}

/** CLS: the largest burst of layout shifts (shifts less than 1 s apart, at most 5 s), without those right after input. */
function cumulativeShift(shifts: { ts: number; score: number }[]) {
  let best = 0;
  let windowSum = 0;
  let windowStart = 0;
  let last = -Infinity;
  for (const s of shifts) {
    if (s.ts - last > 1_000_000 || s.ts - windowStart > 5_000_000) {
      windowSum = 0;
      windowStart = s.ts;
    }
    windowSum += s.score;
    last = s.ts;
    best = Math.max(best, windowSum);
  }
  return Math.round(best * 1000) / 1000;
}

/** Self time per function from the V8 sampling profiler's chunks in the trace. */
function hotFunctions(events: TraceEvent[], pid: number | undefined) {
  const nodes = new Map<number, { name: string; url: string; line: number }>();
  const self = new Map<number, number>();
  for (const e of events) {
    if (e.name !== "ProfileChunk" || (pid !== undefined && e.pid !== pid)) continue;
    const profile = e.args?.data?.cpuProfile;
    const deltas: number[] = e.args?.data?.timeDeltas ?? [];
    for (const node of profile?.nodes ?? []) {
      const frame = node.callFrame ?? {};
      nodes.set(node.id, {
        name: frame.functionName || "(anonymous)",
        url: frame.url ?? "",
        line: frame.lineNumber ?? -1,
      });
    }
    (profile?.samples ?? []).forEach((id: number, i: number) =>
      self.set(id, (self.get(id) ?? 0) + Math.max(0, deltas[i + 1] ?? deltas[i] ?? 0)),
    );
  }
  const byFunction = new Map<string, { name: string; where: string; self: number }>();
  for (const [id, time] of self) {
    const node = nodes.get(id);
    if (!node || /^\((idle|program|root|garbage collector)\)$/.test(node.name)) continue;
    const where = node.url ? `${shortUrl(node.url)}${node.line >= 0 ? `:${node.line + 1}` : ""}` : "(native)";
    const key = `${node.name} ${where}`;
    const entry = byFunction.get(key) ?? { name: node.name, where, self: 0 };
    entry.self += time;
    byFunction.set(key, entry);
  }
  return [...byFunction.values()]
    .sort((a, b) => b.self - a.self)
    .filter((f) => f.self >= 1000)
    .slice(0, 15)
    .map((f) => ({ name: f.name, where: f.where, selfMs: ms(f.self) }));
}

export function analyzeTrace(events: TraceEvent[], options: { url?: string | null } = {}): TraceAnalysis {
  const url = options.url ?? null;
  const { pid, tid } = pageThread(events, url);
  const ofPage = events.filter((e) => pid === undefined || e.pid === pid);
  const main = ofPage.filter((e) => tid === undefined || e.tid === tid);
  const timed = events.filter((e) => e.ph !== "M" && e.ts > 0);
  const start = timed.length ? Math.min(...timed.map((e) => e.ts)) : 0;
  const end = timed.length ? Math.max(...timed.map((e) => e.ts + (e.dur ?? 0))) : 0;

  // Web vitals, from the main frame's navigation.
  const mainFrame = (e: TraceEvent) => e.args?.data?.isOutermostMainFrame ?? e.args?.data?.isMainFrame ?? true;
  const navigation = ofPage
    .filter(
      (e) => e.name === "navigationStart" && mainFrame(e) && (e.args?.data?.documentLoaderURL ?? "").startsWith("http"),
    )
    .at(-1);
  const since = (name: string) => {
    const mark = ofPage.filter((e) => e.name === name && mainFrame(e) && (!navigation || e.ts >= navigation.ts)).at(-1);
    return mark && navigation ? ms(mark.ts - navigation.ts) : null;
  };
  const lcp = ofPage
    .filter(
      (e) => e.name === "largestContentfulPaint::Candidate" && mainFrame(e) && (!navigation || e.ts >= navigation.ts),
    )
    .at(-1);
  // TTFB: the response to the request for the navigated document.
  const documentRequest =
    navigation &&
    events.find(
      (e) =>
        e.name === "ResourceSendRequest" &&
        e.ts >= navigation.ts - 5000 &&
        e.args?.data?.url === navigation.args?.data?.documentLoaderURL,
    );
  const response =
    documentRequest &&
    events.find(
      (e) => e.name === "ResourceReceiveResponse" && e.args?.data?.requestId === documentRequest.args?.data?.requestId,
    );
  const interactions = ofPage.filter(
    (e) => e.name === "EventTiming" && e.ph === "b" && (e.args?.data?.interactionId ?? 0) > 0,
  );

  // The main thread: where its time went, long tasks and what ran in them, reflows forced by scripts.
  const byCategory: Record<string, number> = { scripting: 0, rendering: 0, painting: 0, loading: 0, other: 0 };
  let gc = 0;
  const forced = { count: 0, total: 0, by: new Map<string, number>() };
  const tasks = new Map<TraceEvent, Map<string, number>>();
  walk(main, (e, self, ancestors) => {
    const task = ancestors.find((a) => a.name === "RunTask");
    if (task) byCategory[categoryOf(e.name) ?? "other"]! += self;
    if (isGc(e.name)) gc += self;
    if (
      (e.name === "Layout" || e.name === "UpdateLayoutTree") &&
      ancestors.some(
        (a) =>
          a.name === "FunctionCall" ||
          a.name === "EvaluateScript" ||
          a.name === "EventDispatch" ||
          a.name === "TimerFire",
      )
    ) {
      forced.count++;
      forced.total += e.dur ?? 0;
      const script = [...ancestors].reverse().find((a) => a.name === "FunctionCall" || a.name === "EvaluateScript");
      if (script) forced.by.set(describe(script), (forced.by.get(describe(script)) ?? 0) + (e.dur ?? 0));
    }
    // What a long task spent its time on: the outermost meaningful work in it (a function, an event, a layout…).
    if (
      task &&
      (task.dur ?? 0) > 50_000 &&
      meaningful(e) &&
      !ancestors.slice(ancestors.indexOf(task) + 1).some(meaningful)
    ) {
      const work = tasks.get(task) ?? new Map<string, number>();
      work.set(describe(e), (work.get(describe(e)) ?? 0) + (e.dur ?? 0));
      tasks.set(task, work);
    }
  });
  const runTasks = main.filter((e) => e.ph === "X" && e.name === "RunTask");
  const busy = runTasks.reduce((sum, e) => sum + (e.dur ?? 0), 0);
  const long = runTasks.filter((e) => (e.dur ?? 0) > 50_000);
  const blocking = long.reduce((sum, e) => sum + (e.dur ?? 0) - 50_000, 0);
  byCategory.other = Math.max(
    0,
    busy - byCategory.scripting! - byCategory.rendering! - byCategory.painting! - byCategory.loading!,
  );

  // Layout shifts.
  const shifts = ofPage
    .filter((e) => e.name === "LayoutShift" && !e.args?.data?.had_recent_input)
    .map((e) => ({
      ts: e.ts,
      score: Number(e.args?.data?.weighted_score_delta ?? e.args?.data?.score ?? 0),
      nodes: (e.args?.data?.impacted_nodes ?? []).map(
        (n: { debug_name?: string; node_id?: number }) => n.debug_name ?? `node ${n.node_id}`,
      ),
    }))
    .filter((s) => s.score > 0);

  // Requests.
  const requests = new Map<
    string,
    {
      url: string;
      start: number;
      end: number | null;
      bytes: number;
      status: number | null;
      type: string;
      blocking: boolean;
      failed: boolean;
    }
  >();
  for (const e of events) {
    const d = e.args?.data;
    if (!d?.requestId) continue;
    if (e.name === "ResourceSendRequest") {
      requests.set(d.requestId, {
        url: d.url,
        start: e.ts,
        end: null,
        bytes: 0,
        status: null,
        type: d.resourceType ?? "",
        blocking: d.renderBlocking === "blocking" || d.renderBlocking === "in_body_parser_blocking",
        failed: false,
      });
    } else {
      const r = requests.get(d.requestId);
      if (!r) continue;
      if (e.name === "ResourceReceiveResponse") {
        r.status = d.statusCode ?? null;
        r.type ||= d.mimeType ?? "";
      } else if (e.name === "ResourceFinish") {
        r.end = d.finishTime ? d.finishTime * 1_000_000 : e.ts;
        r.bytes = d.encodedDataLength ?? 0;
        r.failed = !!d.didFail;
      }
    }
  }
  const finished = [...requests.values()].filter((r) => r.end !== null && /^https?:/.test(r.url));
  const info = (r: (typeof finished)[number]): RequestInfo => ({
    url: shortUrl(r.url),
    ms: ms(Math.max(0, r.end! - r.start)),
    kb: kb(r.bytes),
    status: r.status,
    type: r.type,
  });

  return {
    url,
    durationMs: ms(end - start),
    vitals: {
      ttfbMs: response && navigation ? ms(response.ts - navigation.ts) : null,
      fcpMs: since("firstContentfulPaint"),
      lcpMs: lcp && navigation ? ms(lcp.ts - navigation.ts) : null,
      lcpElement: lcp?.args?.data?.type
        ? `${lcp.args.data.type}${lcp.args.data.size ? ` (${lcp.args.data.size} px²)` : ""}`
        : null,
      domContentLoadedMs: since("MarkDOMContent"),
      loadMs: since("MarkLoad"),
      cls: cumulativeShift(shifts),
      totalBlockingTimeMs: ms(blocking),
      inpMs: interactions.length ? Math.max(...interactions.map((e) => Number(e.args?.data?.duration ?? 0))) : null,
    },
    mainThread: {
      busyMs: ms(busy),
      byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, ms(v)])),
    },
    longTasks: long
      .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
      .slice(0, 10)
      .map((t) => ({
        startMs: ms(t.ts - start),
        durationMs: ms(t.dur ?? 0),
        work: [...(tasks.get(t) ?? new Map<string, number>()).entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([label, time]) => `${label} (${ms(time)} ms)`),
      })),
    layoutShifts: shifts
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((s) => ({ atMs: ms(s.ts - start), score: Math.round(s.score * 1000) / 1000, nodes: s.nodes.slice(0, 4) })),
    forcedReflows: {
      count: forced.count,
      totalMs: ms(forced.total),
      by: [...forced.by.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([label, time]) => `${label} (${ms(time)} ms)`),
    },
    requests: {
      count: finished.length,
      transferKb: kb(finished.reduce((sum, r) => sum + r.bytes, 0)),
      slowest: [...finished]
        .sort((a, b) => b.end! - b.start - (a.end! - a.start))
        .slice(0, 6)
        .map(info),
      largest: [...finished]
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 6)
        .map(info),
      renderBlocking: finished
        .filter((r) => r.blocking)
        .map((r) => shortUrl(r.url))
        .slice(0, 10),
      failed: finished
        .filter((r) => r.failed || (r.status ?? 0) >= 400)
        .map((r) => `${r.status ?? "failed"} ${shortUrl(r.url)}`)
        .slice(0, 10),
    },
    hotFunctions: hotFunctions(events, pid),
    gcMs: ms(gc),
  };
}

/** The analysis as text for an agent: the numbers that matter, then the details. */
export function describeTrace(a: TraceAnalysis): string {
  const v = a.vitals;
  const rate = (value: number | null, good: number, poor: number, unit = " ms") =>
    value === null
      ? "n/a"
      : `${value}${unit} (${value <= good ? "good" : value <= poor ? "needs improvement" : "poor"})`;
  const lines = [
    `Trace of ${a.url ?? "the page"}: ${a.durationMs} ms recorded.`,
    "",
    "Web vitals:",
    `- LCP ${rate(v.lcpMs, 2500, 4000)}${v.lcpElement ? `, ${v.lcpElement}` : ""}`,
    `- FCP ${rate(v.fcpMs, 1800, 3000)} · TTFB ${rate(v.ttfbMs, 800, 1800)} · DOMContentLoaded ${v.domContentLoadedMs ?? "n/a"} ms · load ${v.loadMs ?? "n/a"} ms`,
    `- CLS ${rate(v.cls, 0.1, 0.25, "")} · Total blocking time ${rate(v.totalBlockingTimeMs, 200, 600)}${v.inpMs !== null ? ` · INP ${rate(v.inpMs, 200, 500)}` : ""}`,
    "",
    `Main thread busy ${a.mainThread.busyMs} ms: ${Object.entries(a.mainThread.byCategory)
      .filter(([, t]) => t > 0)
      .map(([k, t]) => `${k} ${t} ms`)
      .join(", ")}${a.gcMs ? ` (garbage collection ${a.gcMs} ms)` : ""}.`,
  ];
  if (a.longTasks.length) {
    lines.push("", `Long tasks (over 50 ms): ${a.longTasks.length}${a.longTasks.length === 10 ? "+" : ""}`);
    for (const t of a.longTasks)
      lines.push(`- ${t.durationMs} ms at ${t.startMs} ms: ${t.work.join("; ") || "(no detail)"}`);
  }
  if (a.hotFunctions.length) {
    lines.push("", "Most time in (self time, sampled):");
    for (const f of a.hotFunctions.slice(0, 10)) lines.push(`- ${f.selfMs} ms ${f.name} ${f.where}`);
  }
  if (a.forcedReflows.count)
    lines.push(
      "",
      `Layouts forced by scripts: ${a.forcedReflows.count}, ${a.forcedReflows.totalMs} ms${a.forcedReflows.by.length ? `, by ${a.forcedReflows.by.join("; ")}` : ""}`,
    );
  if (a.layoutShifts.length) {
    lines.push("", "Largest layout shifts:");
    for (const s of a.layoutShifts)
      lines.push(`- ${s.score} at ${s.atMs} ms${s.nodes.length ? `: ${s.nodes.join(", ")}` : ""}`);
  }
  const r = a.requests;
  lines.push("", `Requests: ${r.count}, ${r.transferKb} kB transferred.`);
  if (r.slowest.length) lines.push(`Slowest: ${r.slowest.map((q) => `${q.url} ${q.ms} ms`).join(" · ")}`);
  if (r.largest.length) lines.push(`Largest: ${r.largest.map((q) => `${q.url} ${q.kb} kB`).join(" · ")}`);
  if (r.renderBlocking.length) lines.push(`Render-blocking: ${r.renderBlocking.join(" · ")}`);
  if (r.failed.length) lines.push(`Failed: ${r.failed.join(" · ")}`);
  return lines.join("\n");
}
