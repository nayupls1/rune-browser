// What the benchmarks measure inside a page: installed before the page's own scripts run (in Rune's web tab
// and in Chrome's tab alike, over the DevTools protocol), it records what the user would feel:
//
//   - paints: first contentful paint, largest contentful paint, layout shifts;
//   - the main thread: long tasks (> 50 ms, where input waits) and long animation frames;
//   - input: for every click, key and wheel event, the time from the input to the next frame painted after
//     its handlers ran (what "it reacted" feels like), and the Event Timing API's own measure of it;
//   - frames: the time between frames while something animates or scrolls (smoothness).
//
// Everything is plain data on window.__bench, read back with readProbe().

/** The script itself. It runs in the page's main world, before any of the page's scripts. */
export const PROBE = String.raw`(() => {
  if (window.__bench) return;
  const b = (window.__bench = {
    fcp: 0, lcp: 0, cls: 0,
    longTasks: [],
    loafs: [],
    events: [],
    inputs: [],
    frames: null,
    shows: [],
  });
  // Back/forward: whether the page came back from the back-forward cache (instant) or loaded again.
  addEventListener("pageshow", (e) => b.shows.push({ persisted: e.persisted, at: performance.timeOrigin + performance.now() }));
  const observe = (type, fn, extra) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(fn)).observe({ type, buffered: true, ...extra });
    } catch {}
  };
  observe("paint", (e) => { if (e.name === "first-contentful-paint") b.fcp = e.startTime; });
  observe("largest-contentful-paint", (e) => { b.lcp = e.renderTime || e.loadTime || e.startTime; });
  observe("layout-shift", (e) => { if (!e.hadRecentInput) b.cls += e.value; });
  observe("longtask", (e) => b.longTasks.push({ start: e.startTime, duration: e.duration }));
  observe("long-animation-frame", (e) =>
    b.loafs.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration || 0 }));
  observe("event", (e) => {
    if (e.interactionId || e.name === "wheel")
      b.events.push({ name: e.name, start: e.startTime, duration: e.duration,
        delay: e.processingStart - e.startTime, processing: e.processingEnd - e.processingStart });
  }, { durationThreshold: 16 });

  // Input to the next painted frame. A frame is painted right after its requestAnimationFrame callbacks; a
  // task posted from one runs once that frame is out, so its time is (just after) when the user saw it.
  // One measurement per kind of event at a time (a key held down repeats); one that never finished
  // (its frame never came) stops counting after a second.
  const pending = new Map();
  const onInput = (e) => {
    if (performance.now() - (pending.get(e.type) ?? -Infinity) < 1000) return;
    pending.set(e.type, performance.now());
    const started = e.timeStamp;
    const handlerStart = performance.now();
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        pending.delete(e.type);
        b.inputs.push({ type: e.type, latency: performance.now() - started, delay: handlerStart - started });
      };
      channel.port2.postMessage(0);
    });
  };
  for (const type of ["pointerdown", "click", "keydown", "wheel"])
    addEventListener(type, onInput, { capture: true, passive: true });

  b.startFrames = () => {
    const stamps = [];
    b.frames = stamps;
    const tick = (t) => { if (b.frames === stamps) { stamps.push(t); requestAnimationFrame(tick); } };
    requestAnimationFrame(tick);
  };
  b.stopFrames = () => {
    const stamps = b.frames || [];
    b.frames = null;
    const out = [];
    for (let i = 1; i < stamps.length; i++) out.push(stamps[i] - stamps[i - 1]);
    return out;
  };
  b.reset = () => { b.longTasks = []; b.loafs = []; b.events = []; b.inputs = []; };
})()`;

export interface ProbeData {
  fcp: number;
  lcp: number;
  cls: number;
  longTasks: { start: number; duration: number }[];
  loafs: { start: number; duration: number; blocking: number }[];
  events: { name: string; start: number; duration: number; delay: number; processing: number }[];
  inputs: { type: string; latency: number; delay: number }[];
  nav: { ttfb: number; dcl: number; load: number; transferKB: number; resources: number; type: string } | null;
}

/** Reads what the probe recorded so far, with the navigation's own timings. */
export const READ_PROBE = `(() => {
  const b = window.__bench;
  const n = performance.getEntriesByType("navigation")[0];
  const resources = performance.getEntriesByType("resource");
  const transfer = resources.reduce((a, r) => a + (r.transferSize || 0), n ? n.transferSize || 0 : 0);
  return {
    fcp: b ? b.fcp : 0, lcp: b ? b.lcp : 0, cls: b ? b.cls : 0,
    longTasks: b ? b.longTasks : [], loafs: b ? b.loafs : [], events: b ? b.events : [], inputs: b ? b.inputs : [],
    nav: n ? { ttfb: n.responseStart - n.startTime, dcl: n.domContentLoadedEventEnd - n.startTime,
      load: n.loadEventEnd - n.startTime, transferKB: transfer / 1024, resources: resources.length, type: n.type } : null,
  };
})()`;

/** Total blocking time: how much of the long tasks after the first paint was beyond 50 ms (input waits). */
export function totalBlockingTime(data: ProbeData, from = data.fcp, until = Infinity) {
  return data.longTasks
    .filter((t) => t.start >= from && t.start < until)
    .reduce((a, t) => a + Math.max(0, t.duration - 50), 0);
}
