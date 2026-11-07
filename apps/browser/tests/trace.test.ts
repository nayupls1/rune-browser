// The analysis of performance traces the agents record (shared/trace.ts), on
// a small trace made by hand: vitals, long tasks, forced reflows, layout
// shifts, requests and hot functions, only from the page's own thread.
import { describe, expect, test } from "bun:test";
import { analyzeTrace, describeTrace, type TraceEvent } from "../src/shared/trace";

const PID = 10;
const TID = 1;
const ms = (n: number) => n * 1000;
const at = (name: string, ts: number, extra: Partial<TraceEvent> = {}): TraceEvent => ({
  name,
  ph: "X",
  ts: ms(ts),
  pid: PID,
  tid: TID,
  ...extra,
});

const events: TraceEvent[] = [
  { name: "thread_name", ph: "M", ts: 0, pid: PID, tid: TID, args: { name: "CrRendererMain" } },
  // Another renderer (Rune Browser's own window) that must not count.
  { name: "thread_name", ph: "M", ts: 0, pid: 99, tid: 1, args: { name: "CrRendererMain" } },
  { name: "RunTask", ph: "X", ts: ms(1), dur: ms(500), pid: 99, tid: 1 },
  {
    name: "TracingStartedInBrowser",
    ph: "I",
    ts: ms(1),
    pid: 1,
    tid: 1,
    args: { data: { frames: [{ processId: PID, url: "https://shop.test/", isOutermostMainFrame: true }] } },
  },
  at("navigationStart", 1000, {
    ph: "R",
    args: { frame: "F", data: { documentLoaderURL: "https://shop.test/", isOutermostMainFrame: true } },
  }),
  at("ResourceSendRequest", 1001, {
    ph: "I",
    args: { data: { requestId: "1", url: "https://shop.test/", resourceType: "Document" } },
  }),
  at("ResourceReceiveResponse", 1120, {
    ph: "I",
    args: { data: { frame: "F", requestId: "1", statusCode: 200, mimeType: "text/html" } },
  }),
  at("ResourceFinish", 1150, {
    ph: "I",
    args: { data: { requestId: "1", encodedDataLength: 20_000, finishTime: 1.15 } },
  }),
  at("ResourceSendRequest", 1160, {
    ph: "I",
    args: { data: { requestId: "2", url: "https://shop.test/app.js?v=1", renderBlocking: "blocking" } },
  }),
  at("ResourceFinish", 1900, {
    ph: "I",
    args: { data: { requestId: "2", encodedDataLength: 400_000, finishTime: 1.9 } },
  }),
  at("ResourceSendRequest", 1200, {
    ph: "I",
    args: { data: { requestId: "3", url: "https://shop.test/missing.png" } },
  }),
  at("ResourceReceiveResponse", 1250, { ph: "I", args: { data: { requestId: "3", statusCode: 404 } } }),
  at("ResourceFinish", 1260, { ph: "I", args: { data: { requestId: "3", encodedDataLength: 100, finishTime: 1.26 } } }),
  at("firstContentfulPaint", 1400, { ph: "R", args: { data: { isOutermostMainFrame: true } } }),
  at("largestContentfulPaint::Candidate", 2600, {
    ph: "R",
    args: { data: { isOutermostMainFrame: true, type: "image", size: 90_000 } },
  }),
  at("MarkDOMContent", 1500, { ph: "R", args: { data: { isOutermostMainFrame: true } } }),
  at("MarkLoad", 2000, { ph: "R", args: { data: { isOutermostMainFrame: true } } }),
  // A 300 ms task: a click handler that forces a layout, then a script evaluation.
  at("RunTask", 2100, { dur: ms(300) }),
  at("EventDispatch", 2101, { dur: ms(200), args: { data: { type: "click" } } }),
  at("FunctionCall", 2102, {
    dur: ms(198),
    args: { data: { functionName: "addToCart", url: "https://shop.test/app.js?v=1", lineNumber: 41 } },
  }),
  at("Layout", 2200, { dur: ms(60) }),
  at("EvaluateScript", 2305, { dur: ms(90), args: { data: { url: "https://shop.test/analytics.js" } } }),
  // A short one, not a long task.
  at("RunTask", 2500, { dur: ms(20) }),
  at("Paint", 2501, { dur: ms(10) }),
  // Layout shifts: one after input (ignored), two in a burst.
  at("LayoutShift", 2700, { ph: "I", args: { data: { weighted_score_delta: 0.5, had_recent_input: true } } }),
  at("LayoutShift", 2800, {
    ph: "I",
    args: { data: { weighted_score_delta: 0.12, impacted_nodes: [{ debug_name: "DIV.banner" }] } },
  }),
  at("LayoutShift", 3100, { ph: "I", args: { data: { weighted_score_delta: 0.08 } } }),
  // Sampled CPU profile: addToCart is hot.
  {
    name: "ProfileChunk",
    ph: "P",
    ts: ms(2400),
    pid: PID,
    tid: 2,
    id: "0x1",
    args: {
      data: {
        cpuProfile: {
          nodes: [
            { id: 1, callFrame: { functionName: "(root)" } },
            { id: 2, callFrame: { functionName: "addToCart", url: "https://shop.test/app.js", lineNumber: 41 } },
            { id: 3, callFrame: { functionName: "(idle)" } },
          ],
          samples: [2, 2, 2, 3],
        },
        timeDeltas: [0, 50_000, 50_000, 50_000],
      },
    },
  },
];

describe("trace analysis", () => {
  const a = analyzeTrace(events, { url: "https://shop.test/" });

  test("web vitals from the main frame's navigation", () => {
    expect(a.vitals.ttfbMs).toBe(120);
    expect(a.vitals.fcpMs).toBe(400);
    expect(a.vitals.lcpMs).toBe(1600);
    expect(a.vitals.lcpElement).toBe("image (90000 px²)");
    expect(a.vitals.domContentLoadedMs).toBe(500);
    expect(a.vitals.loadMs).toBe(1000);
    // The burst of two shifts; the one right after input doesn't count.
    expect(a.vitals.cls).toBe(0.2);
    expect(a.vitals.totalBlockingTimeMs).toBe(250);
  });

  test("long tasks say what ran in them, from the page's thread only", () => {
    expect(a.longTasks).toHaveLength(1);
    expect(a.longTasks[0]!.durationMs).toBe(300);
    expect(a.longTasks[0]!.work[0]).toBe("Event: click (200 ms)");
    expect(a.longTasks[0]!.work[1]).toBe("Evaluate script shop.test/analytics.js (90 ms)");
    expect(a.mainThread.busyMs).toBe(320);
    expect(a.mainThread.byCategory.rendering).toBe(60);
    expect(a.mainThread.byCategory.painting).toBe(10);
  });

  test("forced reflows, shifts, requests and hot functions", () => {
    expect(a.forcedReflows.count).toBe(1);
    expect(a.forcedReflows.by[0]).toBe("addToCart shop.test/app.js:42 (60 ms)");
    expect(a.layoutShifts[0]).toMatchObject({ score: 0.12, nodes: ["DIV.banner"] });
    expect(a.requests.count).toBe(3);
    expect(a.requests.slowest[0]).toMatchObject({ url: "shop.test/app.js", ms: 740 });
    expect(a.requests.largest[0]!.kb).toBe(390.6);
    expect(a.requests.renderBlocking).toEqual(["shop.test/app.js"]);
    expect(a.requests.failed).toEqual(["404 shop.test/missing.png"]);
    expect(a.hotFunctions).toEqual([{ name: "addToCart", where: "shop.test/app.js:42", selfMs: 150 }]);
  });

  test("the text for the agent rates the vitals", () => {
    const text = describeTrace(a);
    expect(text).toContain("LCP 1600 ms (good), image");
    expect(text).toContain("CLS 0.2 (needs improvement)");
    expect(text).toContain("- 150 ms addToCart shop.test/app.js:42");
    expect(text).not.toContain("?v=1");
  });
});
