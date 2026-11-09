// What a browser costs the computer: the memory, CPU time and GPU use of its whole process tree (the browser
// process, its renderers, GPU and utility processes, and for Rune its server and the apps it runs).
//
// - Memory is PSS on Linux (shared pages split between the processes sharing them, so the many Chromium
//   processes aren't counted several times over) and the resident set (RSS) on macOS and Windows.
// - CPU is user + system time, per process, so it can be split by kind (is it the UI, the page, the GPU
//   process, Rune's server?).
// - GPU: the time the GPU's engines spent on the tree's work and the GPU memory it holds, where the OS tells
//   without admin rights: Linux's DRM fdinfo (Intel, AMD, and other DRM drivers), nvidia-smi for NVIDIA's,
//   Windows' GPU performance counters. macOS doesn't (powermetrics needs sudo). Without a GPU (software
//   rendering), the drawing is CPU time of the GPU process, which is always measured.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/** Rune's window (its UI) is a renderer too, told apart by the arguments Rune gives it. */
export type ProcKind = "browser" | "ui" | "renderer" | "gpu" | "utility" | "server" | "other";
export const KINDS: ProcKind[] = ["browser", "ui", "renderer", "gpu", "utility", "server", "other"];

interface Proc {
  pid: number;
  ppid: number;
  /** Bytes. */
  mem: number;
  /** Milliseconds of CPU time (user + system) since the process started. */
  cpu: number;
  command: string;
}

export interface TreeSample {
  at: number;
  processes: number;
  /** Megabytes. */
  memMB: number;
  byKind: Record<ProcKind, { processes: number; memMB: number }>;
  /** CPU time per process (pid → ms), to subtract one sample from another. */
  cpuByPid: Map<number, number>;
  kindByPid: Map<number, ProcKind>;
}

export interface GpuSample {
  at: number;
  /** Cumulative engine busy time of the tree's GPU clients, in ms (Linux fdinfo). */
  engineMs?: number;
  /** Utilization right now, % (nvidia-smi, Windows counters). */
  utilPct?: number;
  /** GPU memory held by the tree, MB. */
  memMB?: number;
  source: string;
}

const CLOCK_TICK_MS = 10; // USER_HZ is 100 on every Linux we run on.
const PAGE_SIZE = 4096;

function linuxProcs(): Proc[] {
  const out: Proc[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // The command name is in parentheses and may itself contain spaces or parentheses.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const cpu = (Number(fields[11]) + Number(fields[12])) * CLOCK_TICK_MS;
      out.push({ pid: Number(name), ppid: Number(fields[1]), cpu, mem: 0, command: "" });
    } catch {
      // gone already
    }
  }
  return out;
}

function linuxDetails(p: Proc) {
  try {
    p.command = readFileSync(`/proc/${p.pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    // gone
  }
  try {
    const pss = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${p.pid}/smaps_rollup`, "utf8"));
    if (pss) {
      p.mem = Number(pss[1]) * 1024;
      return;
    }
  } catch {
    // no smaps_rollup (old kernel): the resident set instead
  }
  try {
    p.mem = Number(readFileSync(`/proc/${p.pid}/statm`, "utf8").split(" ")[1]) * PAGE_SIZE;
  } catch {
    // gone
  }
}

/** "1-02:03:04.56", "02:03.45", "0:00.12" → ms. */
function parseCpuTime(s: string): number {
  const [days, rest] = s.includes("-") ? s.split("-") : ["0", s];
  let secs = 0;
  for (const part of (rest ?? "").split(":")) secs = secs * 60 + Number(part);
  return (Number(days) * 86400 + secs) * 1000;
}

async function macProcs(): Promise<Proc[]> {
  const text = await Bun.$`ps -A -o pid=,ppid=,rss=,time=,command=`.quiet().text();
  return text
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      mem: Number(m[3]) * 1024,
      cpu: parseCpuTime(m[4]!),
      command: m[5]!,
    }));
}

async function powershell(script: string) {
  return Bun.$`powershell -NoProfile -NonInteractive -Command ${script}`.quiet().text();
}

async function windowsProcs(): Promise<Proc[]> {
  const rows = JSON.parse(
    await powershell(
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress",
    ),
  ) as {
    ProcessId: number;
    ParentProcessId: number;
    WorkingSetSize: number;
    KernelModeTime: number;
    UserModeTime: number;
    CommandLine: string | null;
  }[];
  return rows.map((r) => ({
    pid: r.ProcessId,
    ppid: r.ParentProcessId,
    mem: Number(r.WorkingSetSize),
    // 100 ns units.
    cpu: (Number(r.KernelModeTime) + Number(r.UserModeTime)) / 10_000,
    command: r.CommandLine ?? "",
  }));
}

function kindOf(command: string, isRoot: boolean): ProcKind {
  if (isRoot) return "browser";
  const type = /--type=([\w-]+)/.exec(command)?.[1];
  if (type === "renderer") return command.includes("--rune-window=") ? "ui" : "renderer";
  if (type === "gpu-process") return "gpu";
  if (type) return "utility"; // utility, zygote, broker, crashpad-handler…
  // Rune's server is its own compiled binary (rune-server), which apps run on too (bun in development).
  if (/rune-server|\bbun\b/.test(command)) return "server";
  return "other";
}

/** The memory and CPU time of `root` and every process under it. */
export async function sampleTree(root: number): Promise<TreeSample> {
  const all =
    process.platform === "linux"
      ? linuxProcs()
      : process.platform === "win32"
        ? await windowsProcs()
        : await macProcs();
  const children = new Map<number, Proc[]>();
  for (const p of all) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const tree: Proc[] = [];
  const rootProc = all.find((p) => p.pid === root);
  const queue = rootProc ? [rootProc] : [];
  while (queue.length) {
    const p = queue.shift()!;
    tree.push(p);
    queue.push(...(children.get(p.pid) ?? []).filter((c) => c.pid !== p.pid));
  }
  if (process.platform === "linux") tree.forEach(linuxDetails);
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { processes: 0, memMB: 0 }])) as TreeSample["byKind"];
  const kindByPid = new Map<number, ProcKind>();
  for (const p of tree) {
    const kind = kindOf(p.command, p.pid === root);
    kindByPid.set(p.pid, kind);
    byKind[kind].processes++;
    byKind[kind].memMB += p.mem / 2 ** 20;
  }
  return {
    at: performance.now(),
    processes: tree.length,
    memMB: tree.reduce((a, p) => a + p.mem, 0) / 2 ** 20,
    byKind,
    cpuByPid: new Map(tree.map((p) => [p.pid, p.cpu])),
    kindByPid,
  };
}

/** CPU used between two samples, as % of one core, in total and by kind of process. */
export function cpuBetween(before: TreeSample, after: TreeSample) {
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<ProcKind, number>;
  const elapsed = after.at - before.at;
  // Processes that started in between count from zero; ones that exited are left out (their last stretch
  // is lost, which only makes this lower).
  for (const [pid, cpu] of after.cpuByPid) {
    const used = Math.max(0, cpu - (before.cpuByPid.get(pid) ?? 0));
    byKind[after.kindByPid.get(pid) ?? "other"] += elapsed > 0 ? (100 * used) / elapsed : 0;
  }
  return { total: KINDS.reduce((a, k) => a + byKind[k], 0), byKind };
}

// --- GPU ----------------------------------------------------------------------------------------------

/** Linux: the DRM clients among the processes' open files, with their engine time and memory. */
function linuxGpu(pids: number[]): GpuSample | null {
  const clients = new Map<string, { ns: number; bytes: number }>();
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (!readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith("/dev/dri/")) continue;
        const info = readFileSync(`/proc/${pid}/fdinfo/${fd}`, "utf8");
        const id = /^drm-client-id:\s*(\d+)/m.exec(info)?.[1];
        if (!id) continue;
        const pdev = /^drm-pdev:\s*(\S+)/m.exec(info)?.[1] ?? "";
        let ns = 0;
        for (const m of info.matchAll(/^drm-engine-[\w-]+:\s*(\d+) ns/gm)) ns += Number(m[1]);
        // Memory: the "total" figures where the driver gives them, else "memory" (older), else "resident".
        let bytes = 0;
        for (const family of ["drm-total-", "drm-memory-", "drm-resident-"]) {
          const re = new RegExp(`^${family}[\\w-]+:\\s*(\\d+)\\s*(KiB|MiB|GiB)?`, "gm");
          for (const m of info.matchAll(re))
            bytes += Number(m[1]) * ({ KiB: 1024, MiB: 2 ** 20, GiB: 2 ** 30 }[m[2] ?? ""] ?? 1);
          if (bytes) break;
        }
        // The same client can be open through several file descriptors.
        clients.set(`${pdev}/${id}`, { ns, bytes });
      } catch {
        // closed meanwhile
      }
    }
  }
  if (!clients.size) return null;
  const all = [...clients.values()];
  return {
    at: performance.now(),
    engineMs: all.reduce((a, c) => a + c.ns, 0) / 1e6,
    memMB: all.reduce((a, c) => a + c.bytes, 0) / 2 ** 20,
    source: "DRM fdinfo",
  };
}

let hasNvidiaSmi: boolean | undefined;
/** NVIDIA's proprietary driver: per-process SM utilization and frame buffer memory, from nvidia-smi pmon. */
async function nvidiaGpu(pids: number[]): Promise<GpuSample | null> {
  hasNvidiaSmi ??= !!Bun.which("nvidia-smi");
  if (!hasNvidiaSmi) return null;
  const text = await Bun.$`nvidia-smi pmon -c 1 -s um`
    .quiet()
    .text()
    .catch(() => "");
  const lines = text.split("\n");
  const header =
    lines
      .find((l) => l.startsWith("# gpu"))
      ?.slice(1)
      .trim()
      .split(/\s+/) ?? [];
  const col = (name: string) => header.indexOf(name);
  let util = 0;
  let mem = 0;
  let seen = false;
  for (const line of lines) {
    if (line.startsWith("#") || !line.trim()) continue;
    const cells = line.trim().split(/\s+/);
    if (!pids.includes(Number(cells[col("pid")]))) continue;
    seen = true;
    util += Number(cells[col("sm")]) || 0;
    mem += Number(cells[col("fb")]) || 0;
  }
  return seen ? { at: performance.now(), utilPct: util, memMB: mem, source: "nvidia-smi" } : null;
}

/** Windows: the GPU engine and process memory performance counters, whose instances name the process. */
async function windowsGpu(pids: number[]): Promise<GpuSample | null> {
  const text = await powershell(
    "(Get-Counter '\\GPU Engine(*)\\Utilization Percentage','\\GPU Process Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples | Select-Object Path,CookedValue | ConvertTo-Json -Compress",
  ).catch(() => "");
  if (!text.trim()) return null;
  const rows = [JSON.parse(text)].flat() as { Path: string; CookedValue: number }[];
  let util = 0;
  let mem = 0;
  let seen = false;
  for (const r of rows) {
    const pid = Number(/pid_(\d+)_/.exec(r.Path)?.[1]);
    if (!pids.includes(pid)) continue;
    seen = true;
    if (r.Path.includes("utilization percentage")) util += r.CookedValue;
    else mem += r.CookedValue / 2 ** 20;
  }
  return seen ? { at: performance.now(), utilPct: util, memMB: mem, source: "Windows GPU counters" } : null;
}

/** The GPU use of these processes, or null where it can't be told (no GPU, or no way to read it). */
export async function sampleGpu(pids: number[]): Promise<GpuSample | null> {
  if (process.platform === "linux") return linuxGpu(pids) ?? (await nvidiaGpu(pids));
  if (process.platform === "win32") return windowsGpu(pids);
  return null;
}

// --- Monitoring a stretch of time ---------------------------------------------------------------------

export interface Usage {
  durationMs: number;
  /** % of one core, averaged over the stretch. */
  cpuPct: number;
  cpuPctByKind: Record<ProcKind, number>;
  memPeakMB: number;
  memAvgMB: number;
  memEndMB: number;
  memEndByKind: Record<ProcKind, number>;
  processes: number;
  /** GPU engine busy % and GPU memory, where measurable. */
  gpu: { busyPct: number | null; memPeakMB: number | null; source: string | null };
}

/**
 * Samples a process tree while something runs: memory at every sample (peak, average), CPU between the
 * first and the last, the GPU's engines and memory where the OS tells. Windows' counters take a second
 * each, so there it samples about once a second.
 */
export function monitor(root: number, intervalMs = 250) {
  const trees: TreeSample[] = [];
  const gpus: GpuSample[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const started = performance.now();
      const tree = await sampleTree(root).catch(() => null);
      if (tree) {
        trees.push(tree);
        const gpu = await sampleGpu([...tree.cpuByPid.keys()]).catch(() => null);
        if (gpu) gpus.push(gpu);
      }
      const left = intervalMs - (performance.now() - started);
      if (running && left > 0) await Bun.sleep(left);
    }
  })();
  return {
    async stop(): Promise<Usage> {
      running = false;
      await loop;
      // One last sample, so even a short stretch has a start and an end.
      const last = await sampleTree(root).catch(() => null);
      if (last) trees.push(last);
      const first = trees[0];
      const end = trees.at(-1);
      if (!first || !end) throw new Error(`process ${root} isn't running`);
      const cpu = cpuBetween(first, end);
      const mems = trees.map((t) => t.memMB);
      let busyPct: number | null = null;
      const engine = gpus.filter((g) => g.engineMs !== undefined);
      if (engine.length >= 2) {
        const a = engine[0]!;
        const b = engine.at(-1)!;
        busyPct = (100 * (b.engineMs! - a.engineMs!)) / Math.max(1, b.at - a.at);
      } else if (gpus.some((g) => g.utilPct !== undefined)) {
        const utils = gpus.filter((g) => g.utilPct !== undefined).map((g) => g.utilPct!);
        busyPct = utils.reduce((x, y) => x + y, 0) / utils.length;
      }
      const gpuMems = gpus.filter((g) => g.memMB !== undefined).map((g) => g.memMB!);
      return {
        durationMs: end.at - first.at,
        cpuPct: cpu.total,
        cpuPctByKind: cpu.byKind,
        memPeakMB: Math.max(...mems),
        memAvgMB: mems.reduce((x, y) => x + y, 0) / mems.length,
        memEndMB: end.memMB,
        memEndByKind: Object.fromEntries(KINDS.map((k) => [k, end.byKind[k].memMB])) as Record<ProcKind, number>,
        processes: end.processes,
        gpu: {
          busyPct,
          memPeakMB: gpuMems.length ? Math.max(...gpuMems) : null,
          source: gpus[0]?.source ?? null,
        },
      };
    },
  };
}
