// The websites the benchmarks load: local, generated, and the same on every run (seeded), so a change in a
// number is a change in the browser, not in the internet. Each one stands for a kind of site people use:
// an article with images, a huge table, a JavaScript app, an infinite feed, animations, a page made of many
// files, one that calls its API a lot, one made of frames from other sites, and pages that measure the
// engine itself (JavaScript, DOM, canvas/WebGL, storage).
//
// Two names point at the server: 127.0.0.1 (the sites) and localhost (another site, for cross-site frames
// and resources). Both are local addresses, which Rune Browser opens over plain HTTP without a warning.
//
// Pages that build themselves after loading set window.__benchReady = false first and true when done; ones
// with work to measure expose window.__run(), whose result (milliseconds per test) the benchmark reads.
import { deflateSync } from "node:zlib";

// --- Deterministic content ----------------------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "the of and to in is for on that with as by at from this be are or an it was which have not has but its they more their about can will one all also new would other when there into some time been only than these could after first over most like years such through where many make made people work just because before well while state city world between under know back during life part both each since same right long great still last own good public high however system way take order small large place point local".split(
    " ",
  );

function words(r: () => number, n: number) {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)]!);
  return out.join(" ");
}
const sentence = (r: () => number) => {
  const s = words(r, 8 + Math.floor(r() * 14));
  return s[0]!.toUpperCase() + s.slice(1) + ".";
};
const paragraph = (r: () => number, sentences = 5) => Array.from({ length: sentences }, () => sentence(r)).join(" ");
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// --- Images: real PNGs (decoded like photos are), generated --------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
const pngCache = new Map<string, Uint8Array<ArrayBuffer>>();
/** A w×h picture: gradients, shapes and grain, so it compresses about like a photo saved as PNG. */
function png(w: number, h: number, seed: number) {
  const key = `${w}x${h}:${seed}`;
  const cached = pngCache.get(key);
  if (cached) return cached;
  const r = rng(seed);
  const [r0, g0, b0] = [r() * 255, r() * 255, r() * 255];
  const circles = Array.from({ length: 6 }, () => ({ x: r() * w, y: r() * h, rad: 20 + r() * h * 0.4, c: r() * 255 }));
  const raw = new Uint8Array((w * 3 + 1) * h);
  let i = 0;
  for (let y = 0; y < h; y++) {
    raw[i++] = 0;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (const c of circles) if ((x - c.x) ** 2 + (y - c.y) ** 2 < c.rad ** 2) v = c.c;
      const grain = (r() - 0.5) * 6;
      raw[i++] = (r0 * (x / w) + v * 0.5 + grain) & 255;
      raw[i++] = (g0 * (y / h) + v * 0.3 + grain) & 255;
      raw[i++] = (b0 + v * 0.2 + grain) & 255;
    }
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, w);
  hv.setUint32(4, h);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  pngCache.set(key, out);
  return out;
}

// --- Pages --------------------------------------------------------------------------------------------

/** A function's source as a script that calls it (its code is type-checked here, and runs in the page). */
const script = (fn: (...args: any[]) => unknown, ...args: unknown[]) =>
  `<script>(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")})</script>`;

const page = (title: string, body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><link rel="icon" href="data:,">${head}</head><body>${body}</body></html>`;

const BASE_CSS = `<style>
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; color: #222; background: #fafafa; }
  header.top { position: sticky; top: 0; background: #fff; border-bottom: 1px solid #ddd; padding: 12px 24px; z-index: 5; display: flex; gap: 16px; }
  header.top nav a { margin-right: 12px; color: #335; }
  main { max-width: 760px; margin: 0 auto; padding: 24px; }
  img { max-width: 100%; height: auto; display: block; }
</style>`;

const topBar = (r: () => number) =>
  `<header class="top"><strong>${escape(words(r, 2))}</strong><nav>${Array.from({ length: 6 }, () => `<a href="#">${words(r, 1)}</a>`).join("")}</nav></header>`;

function article() {
  const r = rng(1);
  let body =
    topBar(r) +
    `<div id="progress" style="position:fixed;top:0;left:0;height:3px;background:#36c;width:0"></div><main><h1>${escape(sentence(r))}</h1>`;
  for (let s = 0; s < 24; s++) {
    body += `<h2>${escape(words(r, 5))}</h2>`;
    body += `<figure><img src="/img/${s}.png?w=760&h=428" width="760" height="428" alt="" ${s > 2 ? 'loading="lazy"' : ""}><figcaption>${escape(sentence(r))}</figcaption></figure>`;
    for (let p = 0; p < 4; p++) body += `<p>${escape(paragraph(r))}</p>`;
    if (s % 6 === 3) body += `<blockquote>${escape(paragraph(r, 2))}</blockquote>`;
    if (s % 8 === 5)
      body += `<table>${Array.from({ length: 8 }, () => `<tr>${Array.from({ length: 4 }, () => `<td>${words(r, 2)}</td>`).join("")}</tr>`).join("")}</table>`;
  }
  body += `</main><footer style="padding:40px;background:#eee">${escape(paragraph(r))}</footer>`;
  // A reading progress bar, as many articles have: a scroll listener that writes a style.
  body += script(() => {
    const bar = document.getElementById("progress")!;
    addEventListener("scroll", () => {
      bar.style.width = `${(100 * scrollY) / (document.documentElement.scrollHeight - innerHeight)}%`;
    });
  });
  return page("Article", body, BASE_CSS);
}

function bigTable() {
  const r = rng(2);
  const rows = Array.from(
    { length: 5000 },
    (_, i) =>
      `<tr><td>${i}</td><td>${words(r, 2)}</td><td>${words(r, 1)}</td><td>${(r() * 10000).toFixed(2)}</td><td>${Math.floor(r() * 100)}%</td><td><a href="#">${words(r, 1)}</a></td><td><span class="tag">${words(r, 1)}</span></td><td>${words(r, 3)}</td></tr>`,
  ).join("");
  const css = `<style>
    body { font: 13px system-ui, sans-serif; margin: 0; }
    table { border-collapse: collapse; width: 100%; }
    th { position: sticky; top: 0; background: #234; color: #fff; cursor: pointer; padding: 6px; text-align: left; }
    td { padding: 4px 6px; border-bottom: 1px solid #eee; }
    tr:nth-child(even) td { background: #f6f8fa; }
    .tag { background: #def; border-radius: 4px; padding: 0 4px; }
  </style>`;
  const body =
    `<table><thead><tr>${["#", "Name", "Kind", "Amount", "Share", "Link", "Tag", "Notes"].map((h, i) => `<th data-col="${i}">${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>` +
    // Sorting by a column (clicking its header): what a data table does, in one long task.
    script(() => {
      const tbody = document.querySelector("tbody")!;
      let asc = true;
      document.querySelector("thead")!.addEventListener("click", (e) => {
        const col = Number((e.target as HTMLElement).dataset.col ?? 3);
        const rows = [...tbody.rows];
        rows.sort((a, b) => {
          const x = a.cells[col]!.textContent!;
          const y = b.cells[col]!.textContent!;
          const n = parseFloat(x) - parseFloat(y);
          return (Number.isNaN(n) ? x.localeCompare(y) : n) * (asc ? 1 : -1);
        });
        asc = !asc;
        tbody.append(...rows);
      });
    });
  return page("Big table", body, css);
}

/** A framework-sized bundle: thousands of functions and classes, a third of which run at startup. */
function vendorJs() {
  const r = rng(3);
  let js = "(function(){var M={};";
  for (let i = 0; i < 2500; i++) {
    const keys = Array.from({ length: 4 + Math.floor(r() * 6) }, (_, k) => `k${k}:a*${k}+b`).join(",");
    const cases = Array.from({ length: 5 }, (_, k) => `case ${k}:return o.k${k % 4}+${Math.floor(r() * 100)};`).join(
      "",
    );
    js += `M.f${i}=function(a,b){var o={${keys}};switch(a%7){${cases}}var s="${words(r, 3)}";return s.length+a*b;};`;
    if (i % 5 === 0)
      js += `M.C${i}=class{constructor(x){this.x=x;this.y=[x,x+1]}m(){return this.x*2+this.y.length}n(z){return z.map(v=>v+this.x)}};`;
  }
  js +=
    "var t=0;for(var i=0;i<2500;i+=3){t+=M['f'+i](i,2);if(M['C'+(i-i%5)])t+=new M['C'+(i-i%5)](i).m();}window.__vendor=M;window.__vendorTotal=t;})();";
  return js;
}

function spaApp() {
  // A dashboard rendered on the client: cards with charts, a list that filters and searches.
  return `(${(() => {
    (window as any).__benchReady = false;
    const seed = { v: 7 };
    const rand = () => (seed.v = (seed.v * 16807) % 2147483647) / 2147483647;
    const names = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda sigma omega".split(" ");
    const items = Array.from({ length: 1500 }, (_, i) => ({
      id: i,
      name: `${names[i % names.length]} ${names[(i * 7) % names.length]} ${i}`,
      group: names[i % 5]!,
      value: Math.round(rand() * 1000),
      trend: Array.from({ length: 12 }, () => rand()),
    }));
    const root = document.getElementById("app")!;
    root.innerHTML = `<header class="bar"><input id="q" placeholder="Search"><div id="groups"></div></header>
      <section id="cards"></section><ul id="list"></ul>`;
    const cards = root.querySelector("#cards")!;
    for (let c = 0; c < 12; c++) {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<h3>${names[c]}</h3><canvas width="220" height="80"></canvas><b>${Math.round(rand() * 1e5)}</b>`;
      cards.append(card);
      const ctx = card.querySelector("canvas")!.getContext("2d")!;
      ctx.beginPath();
      for (let x = 0; x < 220; x += 4) ctx.lineTo(x, 80 - rand() * 70);
      ctx.strokeStyle = "#36c";
      ctx.stroke();
    }
    let group = "";
    let query = "";
    const list = root.querySelector("#list")!;
    const render = () => {
      const shown = items.filter((it) => (!group || it.group === group) && it.name.includes(query));
      list.innerHTML = shown
        .map(
          (it) =>
            `<li><span class="name">${it.name}</span><span class="group">${it.group}</span><span class="spark">${it.trend.map((t) => `<i style="height:${Math.round(t * 16)}px"></i>`).join("")}</span><b>${it.value}</b></li>`,
        )
        .join("");
    };
    const groups = root.querySelector("#groups")!;
    for (const g of ["", ...names.slice(0, 5)]) {
      const b = document.createElement("button");
      b.textContent = g || "all";
      b.dataset.group = g;
      b.onclick = () => ((group = g), render());
      groups.append(b);
    }
    root.querySelector<HTMLInputElement>("#q")!.addEventListener("input", (e) => {
      query = (e.target as HTMLInputElement).value;
      render();
    });
    render();
    requestAnimationFrame(() => ((window as any).__benchReady = true));
  }).toString()})()`;
}

function spa() {
  const css = `<style>
    body { font: 14px system-ui, sans-serif; margin: 0; background: #f4f5f7; }
    .bar { position: sticky; top: 0; background: #fff; padding: 10px; display: flex; gap: 8px; box-shadow: 0 1px 4px #0002; }
    #cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; padding: 12px; }
    .card { background: #fff; border-radius: 8px; padding: 10px; box-shadow: 0 1px 3px #0001; }
    #list { list-style: none; padding: 0 12px; }
    #list li { display: flex; gap: 12px; align-items: center; background: #fff; margin: 2px 0; padding: 6px; border-radius: 4px; }
    .name { flex: 1; } .spark { display: flex; align-items: end; gap: 1px; height: 16px; }
    .spark i { width: 3px; background: #36c; display: block; }
  </style>`;
  return page(
    "Dashboard",
    `<div id="app"></div><script src="/js/vendor.js"></script><script src="/js/app.js"></script>`,
    css,
  );
}

function feed() {
  const css = `<style>
    body { font: 15px system-ui, sans-serif; margin: 0; background: #eef0f3; }
    #feed { max-width: 600px; margin: 0 auto; padding: 12px; }
    .post { background: #fff; border-radius: 10px; margin: 12px 0; padding: 12px; box-shadow: 0 1px 2px #0002; }
    .post header { display: flex; gap: 8px; align-items: center; font-weight: 600; }
    .avatar { width: 36px; height: 36px; border-radius: 50%; background: #ccd; }
    .post img { width: 100%; aspect-ratio: 600 / 340; border-radius: 6px; margin-top: 8px; background: #ddd; }
    .actions { display: flex; gap: 16px; color: #567; margin-top: 8px; }
  </style>`;
  const body =
    `<div id="feed"></div><div id="more" style="height:1px"></div>` +
    script(() => {
      (window as any).__benchReady = false;
      const feedEl = document.getElementById("feed")!;
      let page = 0;
      let loading = false;
      const load = async () => {
        if (loading) return;
        loading = true;
        const posts = (await (await fetch(`/api/feed?page=${page++}`)).json()) as {
          id: number;
          author: string;
          text: string;
          image: string | null;
          likes: number;
        }[];
        const frag = document.createDocumentFragment();
        for (const p of posts) {
          const el = document.createElement("article");
          el.className = "post";
          el.innerHTML = `<header><span class="avatar"></span>${p.author}</header><p>${p.text}</p>${p.image ? `<img loading="lazy" src="${p.image}" alt="">` : ""}<div class="actions"><span>♥ ${p.likes}</span><span>Reply</span><span>Share</span></div>`;
          frag.append(el);
        }
        feedEl.append(frag);
        loading = false;
        (window as any).__benchReady = true;
      };
      new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && load(), {
        rootMargin: "1500px",
      }).observe(document.getElementById("more")!);
    });
  return page("Feed", body, css);
}

function feedApi(n: number) {
  const r = rng(100 + n);
  return Array.from({ length: 10 }, (_, i) => ({
    id: n * 10 + i,
    author: words(r, 2),
    text: escape(paragraph(r, 1 + Math.floor(r() * 3))),
    image: r() < 0.6 ? `/img/f${n * 10 + i}.png?w=600&h=340` : null,
    likes: Math.floor(r() * 1000),
  }));
}

function animation(mode: string) {
  const css = `<style>
    body { margin: 0; overflow: hidden; background: #111; }
    .box { position: absolute; width: 24px; height: 24px; border-radius: 4px; }
    @keyframes spin { from { transform: translate(0, 0) rotate(0); } to { transform: translate(300px, 120px) rotate(360deg); } }
    .css .box { animation: spin 2s ease-in-out infinite alternate; will-change: transform; }
  </style>`;
  const body =
    `<div id="stage" class="${mode}"></div><canvas id="c" style="position:absolute;inset:0"></canvas>` +
    script((mode: string) => {
      const stage = document.getElementById("stage")!;
      const r = (() => {
        let s = 11;
        return () => (s = (s * 16807) % 2147483647) / 2147483647;
      })();
      if (mode === "css" || mode === "js") {
        const boxes: HTMLElement[] = [];
        for (let i = 0; i < (mode === "css" ? 400 : 300); i++) {
          const b = document.createElement("div");
          b.className = "box";
          b.style.left = `${r() * (innerWidth - 330)}px`;
          b.style.top = `${r() * (innerHeight - 150)}px`;
          b.style.background = `hsl(${r() * 360} 70% 60%)`;
          b.style.animationDelay = `${-r() * 2}s`;
          stage.append(b);
          boxes.push(b);
        }
        // Moved by JavaScript, with properties that need layout every frame (left/top/width), as older sites do.
        if (mode === "js") {
          const base = boxes.map((b) => [parseFloat(b.style.left), parseFloat(b.style.top)] as const);
          const step = (t: number) => {
            boxes.forEach((b, i) => {
              b.style.left = `${base[i]![0] + Math.sin(t / 300 + i) * 60}px`;
              b.style.top = `${base[i]![1] + Math.cos(t / 400 + i) * 40}px`;
              b.style.width = `${20 + Math.sin(t / 200 + i) * 8}px`;
            });
            void stage.offsetHeight;
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }
      } else {
        const canvas = document.getElementById("c") as HTMLCanvasElement;
        canvas.width = innerWidth;
        canvas.height = innerHeight;
        const ctx = canvas.getContext("2d")!;
        const ps = Array.from({ length: 4000 }, () => ({
          x: r() * canvas.width,
          y: r() * canvas.height,
          vx: r() * 4 - 2,
          vy: r() * 4 - 2,
          h: Math.floor(r() * 360),
        }));
        const step = () => {
          ctx.fillStyle = "rgba(17,17,17,0.3)";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          for (const p of ps) {
            p.x = (p.x + p.vx + canvas.width) % canvas.width;
            p.y = (p.y + p.vy + canvas.height) % canvas.height;
            ctx.fillStyle = `hsl(${p.h} 80% 60%)`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
            ctx.fill();
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
    }, mode);
  return page(`Animation (${mode})`, body, css);
}

function resources(port: number) {
  const other = `http://localhost:${port}`;
  let head = "";
  for (let i = 0; i < 40; i++) head += `<link rel="stylesheet" href="/r/s${i}.css">`;
  for (let i = 0; i < 20; i++) head += `<script src="/r/j${i}.js"></script>`;
  for (let i = 20; i < 40; i++) head += `<script defer src="/r/j${i}.js"></script>`;
  let body = `<h1>Many files</h1><div style="display:flex;flex-wrap:wrap;gap:4px">`;
  for (let i = 0; i < 40; i++) body += `<img src="/img/r${i}.png?w=64&h=64" width="64" height="64" alt="">`;
  for (let i = 0; i < 20; i++) body += `<img src="${other}/img/x${i}.png?w=64&h=64" width="64" height="64" alt="">`;
  body += `</div>`;
  return page("Many files", body, head);
}

function fetchPage() {
  const body =
    `<h1>API calls</h1><p id="out"></p>` +
    script(() => {
      (window as any).__run = async () => {
        const t: Record<string, number> = {};
        let start = performance.now();
        // Like a page loading its data: 300 calls, six at a time (one host's connections).
        for (let i = 0; i < 300; i += 6)
          await Promise.all(Array.from({ length: 6 }, (_, k) => fetch(`/api/echo?i=${i + k}`).then((r) => r.json())));
        t.sequential6 = performance.now() - start;
        start = performance.now();
        await Promise.all(Array.from({ length: 300 }, (_, i) => fetch(`/api/echo?b=${i}`).then((r) => r.json())));
        t.burst300 = performance.now() - start;
        start = performance.now();
        for (let i = 0; i < 100; i++)
          await fetch("/api/echo", { method: "POST", body: JSON.stringify({ i, pad: "x".repeat(2000) }) }).then((r) =>
            r.json(),
          );
        t.post100 = performance.now() - start;
        start = performance.now();
        await fetch("/api/big").then((r) => r.arrayBuffer());
        t.download20MB = performance.now() - start;
        return t;
      };
    });
  return page("API calls", body);
}

function iframes(port: number) {
  let body = `<h1>Frames</h1><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">`;
  for (let i = 0; i < 16; i++) {
    const origin = i % 2 ? `http://localhost:${port}` : "";
    body += `<iframe src="${origin}/frame?i=${i}" style="width:100%;height:180px;border:1px solid #ccc"></iframe>`;
  }
  return page("Frames", body + "</div>");
}

function frame(i: number) {
  const r = rng(200 + i);
  return page(
    `Frame ${i}`,
    `<h3>${escape(words(r, 3))}</h3><img src="/img/fr${i}.png?w=200&h=80" width="200" height="80"><p>${escape(paragraph(r, 2))}</p>` +
      script(() => {
        // An embed's own script: a little work and a timer, like a widget or an ad.
        let n = 0;
        for (let k = 0; k < 2e5; k++) n += Math.sqrt(k);
        setInterval(() => (document.title = String(n++)), 1000);
      }),
  );
}

/** JavaScript engine work, in tests like those of JetStream: each returns how long it took. */
function jsSuite() {
  const time = (fn: () => unknown) => {
    const s = performance.now();
    fn();
    return performance.now() - s;
  };
  let seed = 1;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const tests: Record<string, () => unknown> = {
    json: () => {
      const data = Array.from({ length: 20000 }, (_, i) => ({
        id: i,
        name: `item ${i}`,
        tags: ["a", "b", "c"],
        v: rand(),
        nested: { x: i, y: [i, i * 2] },
      }));
      for (let k = 0; k < 3; k++) JSON.parse(JSON.stringify(data));
    },
    regex: () => {
      const text = Array.from(
        { length: 30000 },
        (_, i) => `user${i}@example${i % 50}.com visited /page/${i} at 2024-0${(i % 9) + 1}-1${i % 9}`,
      ).join("\n");
      const res = [/\b[\w.]+@[\w.]+\.\w+\b/g, /\/page\/(\d+)/g, /\d{4}-\d{2}-\d{2}/g, /(\w+)\s+visited/g];
      for (const re of res) text.match(re);
      text.replace(/example(\d+)/g, (_, d) => `ex${d}`);
    },
    sort: () => {
      Float64Array.from({ length: 300000 }, rand).sort();
      Array.from({ length: 300000 }, rand).sort((a, b) => a - b);
      Array.from({ length: 100000 }, (_, i) => `k${(i * 7919) % 100000}`).sort();
    },
    objects: () => {
      const m = new Map<number, { a: number; b: string }>();
      for (let i = 0; i < 300000; i++) m.set(i, { a: i, b: "x" + i });
      let s = 0;
      for (const [, v] of m) s += v.a;
      const set = new Set<string>();
      for (let i = 0; i < 200000; i++) set.add("k" + (i % 50000));
      const objs = [];
      for (let i = 0; i < 1000000; i++) objs.push({ i, j: i * 2 });
      return s + set.size + objs.length;
    },
    strings: () => {
      let s = "";
      for (let i = 0; i < 200000; i++) s += String.fromCharCode(97 + (i % 26));
      const parts = s.split("a");
      return parts.join("-").toUpperCase().replaceAll("B", "bb").length;
    },
    typed: () => {
      const n = 160;
      const a = new Float64Array(n * n).map(rand);
      const b = new Float64Array(n * n).map(rand);
      const c = new Float64Array(n * n);
      for (let i = 0; i < n; i++)
        for (let k = 0; k < n; k++) {
          const x = a[i * n + k]!;
          for (let j = 0; j < n; j++) c[i * n + j]! += x * b[k * n + j]!;
        }
      const bytes = new Uint8Array(8 << 20).map((_, i) => i * 31);
      let crc = 0;
      for (let i = 0; i < bytes.length; i++) crc = ((crc << 5) - crc + bytes[i]!) | 0;
      return crc + c[0]!;
    },
    classes: () => {
      // Polymorphic calls through a small class hierarchy (like DeltaBlue/Richards).
      class Shape {
        area() {
          return 0;
        }
      }
      class Sq extends Shape {
        constructor(public s: number) {
          super();
        }
        override area() {
          return this.s * this.s;
        }
      }
      class Ci extends Shape {
        constructor(public r: number) {
          super();
        }
        override area() {
          return 3.14159 * this.r * this.r;
        }
      }
      class Tri extends Shape {
        constructor(
          public b: number,
          public h: number,
        ) {
          super();
        }
        override area() {
          return (this.b * this.h) / 2;
        }
      }
      const shapes: Shape[] = Array.from({ length: 3000 }, (_, i) =>
        i % 3 === 0 ? new Sq(i) : i % 3 === 1 ? new Ci(i) : new Tri(i, 2),
      );
      let t = 0;
      for (let k = 0; k < 1000; k++) for (const s of shapes) t += s.area();
      return t;
    },
    functional: () =>
      Array.from({ length: 1000000 }, (_, i) => i)
        .map((x) => x * 2)
        .filter((x) => x % 3 === 0)
        .reduce((a, b) => a + b, 0),
    wasm: () => {
      // A hand-assembled module: (func (param i32) (result i32) a loop of multiply-adds).
      const bytes = new Uint8Array([
        ...[0, 97, 115, 109, 1, 0, 0, 0],
        ...[1, 6, 1, 96, 1, 127, 1, 127], // type: (i32) -> i32
        ...[3, 2, 1, 0], // function 0 has it
        ...[7, 5, 1, 1, 102, 0, 0], // exported as "f"
        ...[10, 36, 1, 34, 1, 2, 127], // code: two i32 locals (i, acc)
        ...[3, 64, 32, 2, 32, 1, 32, 1, 108, 106, 65, 7, 115, 33, 2], // loop: acc = (acc + i * i) ^ 7
        ...[32, 1, 65, 1, 106, 34, 1, 32, 0, 72, 13, 0, 11], // while (++i < n)
        ...[32, 2, 11], // return acc
      ]);
      const f = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.f as (n: number) => number;
      return f(50_000_000);
    },
  };
  (window as any).__run = () => {
    const out: Record<string, number> = {};
    for (const [name, fn] of Object.entries(tests)) out[name] = time(fn);
    return out;
  };
}

/** The DOM, style and layout: the work behind every page update (like Speedometer's). */
function domSuite() {
  const time = (fn: () => unknown) => {
    const s = performance.now();
    fn();
    return performance.now() - s;
  };
  const area = document.getElementById("area")!;
  const tests: Record<string, () => unknown> = {
    create: () => {
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 20000; i++) {
        const d = document.createElement("div");
        d.className = "row";
        d.textContent = `row ${i}`;
        frag.append(d);
      }
      area.replaceChildren(frag);
      return area.offsetHeight;
    },
    innerHTML: () => {
      area.innerHTML = Array.from(
        { length: 5000 },
        (_, i) => `<section><h4>title ${i}</h4><p class="t">text <b>${i}</b> <a href="#">link</a></p></section>`,
      ).join("");
      return area.offsetHeight;
    },
    query: () => {
      let n = 0;
      for (let i = 0; i < 500; i++) n += area.querySelectorAll(`section:nth-child(${(i % 50) + 1}) p.t b, h4`).length;
      return n;
    },
    layoutThrash: () => {
      const els = [...area.querySelectorAll("section")].slice(0, 300);
      let h = 0;
      for (const el of els) {
        (el as HTMLElement).style.paddingTop = `${h % 7}px`;
        h += (el as HTMLElement).offsetHeight; // forces layout each time
      }
      return h;
    },
    styleRecalc: () => {
      let w = 0;
      for (let i = 0; i < 20; i++) {
        document.body.classList.toggle("alt");
        w += getComputedStyle(area.firstElementChild!).paddingLeft.length + area.offsetWidth;
      }
      return w;
    },
    todo: () => {
      // A to-do list as an app would do it: adding items through the input, ticking them all, deleting them.
      area.innerHTML = `<input id="new"><ul id="todos"></ul>`;
      const input = area.querySelector<HTMLInputElement>("#new")!;
      const list = area.querySelector<HTMLElement>("#todos")!;
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const li = document.createElement("li");
        li.innerHTML = `<input type="checkbox"><label>${input.value}</label><button>×</button>`;
        li.querySelector("button")!.addEventListener("click", () => li.remove());
        li.querySelector("input")!.addEventListener("change", () => li.classList.toggle("done"));
        list.append(li);
        input.value = "";
      });
      for (let i = 0; i < 400; i++) {
        input.value = `Something to do ${i}`;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        void list.offsetHeight;
      }
      for (const box of list.querySelectorAll<HTMLInputElement>("input")) box.click();
      void list.offsetHeight;
      for (const b of [...list.querySelectorAll("button")]) {
        b.click();
        void list.offsetHeight;
      }
    },
    textLayout: () => {
      area.innerHTML = `<p style="font-size:15px">${"lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(4000)}</p>`;
      let h = 0;
      for (let w = 300; w < 1000; w += 70) {
        area.style.width = `${w}px`;
        h += area.offsetHeight;
      }
      area.style.width = "";
      return h;
    },
    svg: () => {
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("width", "800");
      svg.setAttribute("height", "400");
      for (let i = 0; i < 5000; i++) {
        const c = document.createElementNS(ns, "circle");
        c.setAttribute("cx", String(i % 800));
        c.setAttribute("cy", String((i * 7) % 400));
        c.setAttribute("r", "3");
        svg.append(c);
      }
      area.replaceChildren(svg);
      let s = 0;
      for (const c of [...svg.children].slice(0, 2000)) s += (c as SVGCircleElement).getBBox().width;
      return s;
    },
  };
  (window as any).__run = () => {
    const out: Record<string, number> = {};
    for (const [name, fn] of Object.entries(tests)) out[name] = time(fn);
    area.replaceChildren();
    return out;
  };
}

/** Drawing: 2D canvas and WebGL (each test forces the drawing to finish by reading a pixel back). */
function canvasSuite() {
  (window as any).__run = () => {
    const out: Record<string, number> = {};
    const c = document.createElement("canvas");
    c.width = 1000;
    c.height = 700;
    document.body.append(c);
    const ctx = c.getContext("2d")!;
    const flush = () => ctx.getImageData(0, 0, 1, 1);
    let s = performance.now();
    for (let i = 0; i < 30000; i++) {
      ctx.fillStyle = `hsl(${i % 360} 70% 50%)`;
      ctx.fillRect((i * 13) % 1000, (i * 7) % 700, 12, 12);
    }
    flush();
    out.rects = performance.now() - s;
    s = performance.now();
    for (let i = 0; i < 6000; i++) {
      ctx.beginPath();
      ctx.arc((i * 17) % 1000, (i * 11) % 700, 8, 0, Math.PI * 2);
      ctx.stroke();
    }
    flush();
    out.paths = performance.now() - s;
    s = performance.now();
    ctx.font = "14px sans-serif";
    for (let i = 0; i < 10000; i++) ctx.fillText(`text ${i}`, (i * 37) % 1000, (i * 23) % 700);
    flush();
    out.text = performance.now() - s;
    s = performance.now();
    for (let i = 0; i < 10; i++) ctx.putImageData(ctx.getImageData(0, 0, 1000, 700), (i % 3) - 1, 0);
    out.pixels = performance.now() - s;
    // WebGL: many draw calls of a small mesh.
    const g = document.createElement("canvas");
    g.width = 800;
    g.height = 600;
    document.body.append(g);
    const gl = g.getContext("webgl2") as WebGL2RenderingContext | null;
    if (gl) {
      s = performance.now();
      const shader = (type: number, src: string) => {
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return sh;
      };
      const prog = gl.createProgram()!;
      gl.attachShader(
        prog,
        shader(gl.VERTEX_SHADER, "attribute vec2 p;uniform vec2 o;void main(){gl_Position=vec4(p*0.05+o,0,1);}"),
      );
      gl.attachShader(
        prog,
        shader(gl.FRAGMENT_SHADER, "precision mediump float;uniform vec4 c;void main(){gl_FragColor=c;}"),
      );
      gl.linkProgram(prog);
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const tri = new Float32Array(600);
      for (let i = 0; i < 600; i++) tri[i] = Math.sin(i * 1.7);
      gl.bufferData(gl.ARRAY_BUFFER, tri, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const uo = gl.getUniformLocation(prog, "o");
      const uc = gl.getUniformLocation(prog, "c");
      const px = new Uint8Array(4);
      for (let f = 0; f < 20; f++) {
        gl.clear(gl.COLOR_BUFFER_BIT);
        for (let i = 0; i < 300; i++) {
          gl.uniform2f(uo, ((i * 37) % 200) / 100 - 1, ((i * 53) % 200) / 100 - 1);
          gl.uniform4f(uc, (i % 7) / 7, (i % 5) / 5, (i % 3) / 3, 1);
          gl.drawArrays(gl.TRIANGLES, 0, 300);
        }
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      out.webgl = performance.now() - s;
    }
    c.remove();
    g.remove();
    return out;
  };
}

/** Things to click and type into, each costing the page a known amount of work. */
function inputPage() {
  const css = `<style>
    body { font: 15px system-ui, sans-serif; padding: 20px; }
    button { position: absolute; width: 160px; height: 50px; }
    #fast { left: 20px; top: 20px; } #medium { left: 200px; top: 20px; } #slow { left: 380px; top: 20px; }
    #search { position: absolute; left: 20px; top: 100px; width: 300px; height: 30px; font-size: 16px; }
    #results { position: absolute; top: 150px; left: 20px; columns: 3; }
  </style>`;
  const body =
    `<button id="fast">No work</button><button id="medium">40 ms of work</button><button id="slow">120 ms of work</button><input id="search" placeholder="Filter"><p id="status">-</p><ul id="results"></ul>` +
    script(() => {
      const busy = (ms: number) => {
        const end = performance.now() + ms;
        while (performance.now() < end);
      };
      const status = document.getElementById("status")!;
      for (const [id, ms] of [
        ["fast", 0],
        ["medium", 40],
        ["slow", 120],
      ] as const)
        document.getElementById(id)!.addEventListener("click", () => {
          busy(ms);
          status.textContent = `${id} at ${performance.now().toFixed(0)}`;
        });
      // A search box that filters a list on every key, like most sites' search.
      const items = Array.from({ length: 2000 }, (_, i) => `result ${i} ${(i * 7919).toString(36)}`);
      const results = document.getElementById("results")!;
      document.getElementById("search")!.addEventListener("input", (e) => {
        const q = (e.target as HTMLInputElement).value;
        results.innerHTML = items
          .filter((s) => s.includes(q))
          .slice(0, 300)
          .map((s) => `<li>${s}</li>`)
          .join("");
      });
    });
  return page("Input", body, css);
}

/** A page that's expensive to paint: shadows, blur, gradients, rounded corners, filters. */
function paintHeavy() {
  const r = rng(5);
  const css = `<style>
    body { margin: 0; font: 14px system-ui, sans-serif; background: linear-gradient(135deg, #a8c0ff, #3f2b96) fixed; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; padding: 24px; }
    .card { border-radius: 16px; padding: 18px; background: rgba(255,255,255,0.35); backdrop-filter: blur(12px);
      box-shadow: 0 10px 30px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.6); }
    .card h3 { filter: drop-shadow(0 2px 3px rgba(0,0,0,.4)); }
    .card .chip { display: inline-block; border-radius: 99px; padding: 2px 8px; background: radial-gradient(circle, #fff8, #fff2); opacity: .9; }
  </style>`;
  const cards = Array.from(
    { length: 240 },
    () =>
      `<div class="card"><h3>${escape(words(r, 3))}</h3><p>${escape(sentence(r))}</p><span class="chip">${words(r, 1)}</span></div>`,
  ).join("");
  return page("Heavy paint", `<div class="grid">${cards}</div>`, css);
}

function storageSuite() {
  (window as any).__run = async () => {
    const out: Record<string, number> = {};
    let s = performance.now();
    for (let i = 0; i < 3000; i++) localStorage.setItem(`k${i}`, `value ${i} `.repeat(10));
    let n = 0;
    for (let i = 0; i < 3000; i++) n += localStorage.getItem(`k${i}`)!.length;
    localStorage.clear();
    out.localStorage = performance.now() - s;
    s = performance.now();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`bench${Math.random()}`, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("items", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("items", "readwrite");
      const store = tx.objectStore("items");
      for (let i = 0; i < 5000; i++) store.put({ id: i, name: `item ${i}`, data: { a: i, b: [i, i + 1] } });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    out.indexedDBWrite = performance.now() - s;
    s = performance.now();
    await new Promise<void>((resolve) => {
      const req = db.transaction("items").objectStore("items").getAll();
      req.onsuccess = () => {
        n += req.result.length;
        resolve();
      };
    });
    out.indexedDBRead = performance.now() - s;
    const name = db.name;
    db.close();
    indexedDB.deleteDatabase(name);
    s = performance.now();
    const cache = await caches.open(`bench${Math.random()}`);
    for (let i = 0; i < 200; i++) await cache.put(`/cached/${i}`, new Response(`body ${i}`.repeat(100)));
    for (let i = 0; i < 200; i++) n += (await (await cache.match(`/cached/${i}`))!.text()).length;
    out.cacheAPI = performance.now() - s;
    return out;
  };
}

/** Pages linking to each other, for navigating: a docs site, medium-sized pages. */
function navPage(n: number) {
  const r = rng(300 + n);
  let body = topBar(r) + `<main><h1>Page ${n}: ${escape(words(r, 4))}</h1>`;
  body += `<p><a id="next" href="/nav/${n + 1}" style="display:inline-block;padding:12px 24px;background:#36c;color:#fff">Next page</a></p>`;
  for (let p = 0; p < 30; p++)
    body += `${p % 6 === 0 ? `<h2>${escape(words(r, 4))}</h2>` : ""}<p>${escape(paragraph(r))}</p>`;
  body += `<img src="/img/n${n % 5}.png?w=700&h=300" width="700" height="300" alt=""></main>`;
  return page(`Page ${n}`, body, BASE_CSS);
}

/** A page whose main thread stops for `ms` once loaded (or each time __hang() is called). */
function hang(ms: number) {
  return page(
    "Hanging page",
    `<h1>This page hangs</h1>` +
      script((ms: number) => {
        (window as any).__hang = (t = ms) => {
          const end = performance.now() + t;
          while (performance.now() < end);
        };
      }, ms),
  );
}

/** A page that keeps the browser busy around it: its title, favicon, URL, console and network, many times a second. */
function flood() {
  return page(
    "Flood",
    `<h1>Busy page</h1>` +
      script(() => {
        (window as any).__flood = (ms: number) =>
          new Promise<void>((resolve) => {
            let i = 0;
            const link = document.querySelector<HTMLLinkElement>("link[rel=icon]")!;
            const timer = setInterval(() => {
              i++;
              document.title = `(${i}) Busy page`;
              if (i % 5 === 0) link.href = `/img/fav${i % 10}.png?w=16&h=16`;
              history.replaceState(null, "", `?n=${i}`);
              if (i % 2 === 0) history.pushState(null, "", `?p=${i}`);
              console.log("tick", i, { detail: "x".repeat(200) });
              void fetch(`/api/echo?flood=${i}`);
            }, 10);
            setTimeout(() => (clearInterval(timer), resolve()), ms);
          });
      }),
  );
}

// --- The server ---------------------------------------------------------------------------------------

export interface Site {
  /** http://127.0.0.1:port */
  origin: string;
  url(path: string): string;
  stop(): void;
  /** Requests served (to check pages loaded what they should). */
  requests: number;
  /** Makes every image the pages use beforehand, so no browser waits for one to be generated. */
  warm(): Promise<void>;
}

export function serveSite(): Site {
  const vendor = vendorJs();
  const app = spaApp();
  const big = new Uint8Array(20 << 20).map((_, i) => i & 255);
  let requests = 0;
  const html = (body: string) =>
    new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
  const asset = (body: string | Uint8Array<ArrayBuffer>, type: string) =>
    new Response(body, { headers: { "Content-Type": type, "Cache-Control": "max-age=3600" } });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      requests++;
      const url = new URL(req.url);
      const path = url.pathname;
      const port: number = server.port!;
      const num = (name: string, fallback: number) => Number(url.searchParams.get(name) ?? fallback);
      if (path === "/blank") return html(page("Blank", ""));
      if (path === "/article") return html(article());
      if (path === "/table") return html(bigTable());
      if (path === "/spa") return html(spa());
      if (path === "/js/vendor.js") return asset(vendor, "text/javascript");
      if (path === "/js/app.js") return asset(app, "text/javascript");
      if (path === "/feed") return html(feed());
      if (path === "/api/feed") return Response.json(feedApi(num("page", 0)));
      if (path.startsWith("/animation/")) return html(animation(path.slice("/animation/".length)));
      if (path === "/resources") return html(resources(port));
      if (path.startsWith("/r/s")) return asset(`.c${path.slice(4, -4)} { color: #123; margin: 1px; }`, "text/css");
      if (path.startsWith("/r/j"))
        return asset(`window.__r = (window.__r || 0) + ${parseInt(path.slice(4))};`, "text/javascript");
      if (path === "/fetch") return html(fetchPage());
      if (path === "/api/echo")
        return Response.json(
          { ok: true, q: url.search, body: req.method === "POST" ? (await req.text()).length : 0 },
          { headers: { "Cache-Control": "no-store" } },
        );
      if (path === "/api/big")
        return new Response(big, {
          headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
        });
      if (path === "/iframes") return html(iframes(port));
      if (path === "/frame") return html(frame(num("i", 0)));
      if (path === "/js") return html(page("JavaScript", `<h1>JavaScript</h1>${script(jsSuite)}`));
      if (path === "/dom")
        return html(
          page(
            "DOM",
            `<div id="area"></div>${script(domSuite)}`,
            `<style>.alt section, .alt .row { padding-left: 3px; }</style>`,
          ),
        );
      if (path === "/canvas") return html(page("Canvas", script(canvasSuite)));
      if (path === "/input") return html(inputPage());
      if (path === "/paint") return html(paintHeavy());
      if (path === "/storage") return html(page("Storage", script(storageSuite)));
      if (path.startsWith("/nav/")) return html(navPage(Number(path.slice(5)) || 0));
      if (path === "/hang") return html(hang(num("ms", 3000)));
      if (path === "/flood") return html(flood());
      if (path.startsWith("/img/")) {
        const seed = [...path].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
        return asset(png(Math.min(num("w", 64), 2000), Math.min(num("h", 64), 2000), seed), "image/png");
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    url: (path) => origin + path,
    stop: () => server.stop(true),
    get requests() {
      return requests;
    },
    async warm() {
      const images = [
        ...Array.from({ length: 24 }, (_, i) => `/img/${i}.png?w=760&h=428`),
        ...Array.from({ length: 200 }, (_, i) => `/img/f${i}.png?w=600&h=340`),
        ...Array.from({ length: 40 }, (_, i) => `/img/r${i}.png?w=64&h=64`),
        ...Array.from({ length: 20 }, (_, i) => `/img/x${i}.png?w=64&h=64`),
        ...Array.from({ length: 16 }, (_, i) => `/img/fr${i}.png?w=200&h=80`),
        ...Array.from({ length: 5 }, (_, i) => `/img/n${i}.png?w=700&h=300`),
        ...Array.from({ length: 10 }, (_, i) => `/img/fav${i}.png?w=16&h=16`),
      ];
      for (const path of images) await fetch(origin + path).then((r) => r.arrayBuffer());
      requests = 0;
    },
  };
}
