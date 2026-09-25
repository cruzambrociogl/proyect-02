// The server site: what is served, adding images, preparing them.
//
//   GET    /                       the page (server/admin.html)
//   GET    /api/images             every image: its original, whether it is prepared, progress
//   POST   /api/upload?name=FILE   the request body is the file, streamed to --originals
//   POST   /api/prepare?name=FILE  queue its preparation (splatpyr ingest, then build)
//   DELETE /api/prepared?name=FILE remove what was prepared for it (the original stays)
//   DELETE /api/original?name=FILE remove the original
//   GET    /thumb/FILE             a small preview (the top level of the prepared pyramid)
//
// Preparation runs one image at a time in a child process (the Python preprocessing), and
// its output is parsed for progress. Images appear in the catalog as soon as they are ready.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { isReady } from "./image.ts";

const IMAGE_EXT = /\.(jpe?g|png|tiff?|webp)$/i;

interface Job {
  name: string;
  state: "queued" | "ingesting" | "fitting" | "done" | "failed";
  line: string;               // the last thing the preprocessing said
  progress: number;           // 0..1, rough
  started: number;
  finished: number;
  log: string[];
  levels?: [number, number];  // the splat levels being fitted, top..split
}

export interface AdminOptions {
  port: number;
  data: string;               // prepared images
  originals: string;          // uploaded (or dropped-in) source images
  python: string;
  root: string;               // where `python -m splatpyr` runs
  onReady: () => void;        // an image finished preparing, or was removed
}

export function startAdmin(o: AdminOptions): void {
  const jobs = new Map<string, Job>();
  const queue: string[] = [];
  let running = false;

  /** A plain file or folder name (no path, not hidden). Uploads also need an image extension. */
  const safe = (name: string | null): string | null =>
    name && basename(name) === name && !name.startsWith(".") && !name.endsWith(".part") ? name : null;

  function describe(name: string) {
    const original = join(o.originals, name), prepared = join(o.data, name);
    const out: Record<string, unknown> = { name, original: existsSync(original) ? statSync(original).size : null };
    if (existsSync(join(prepared, "pyramid.json"))) {
      const meta = JSON.parse(readFileSync(join(prepared, "pyramid.json"), "utf8"));
      Object.assign(out, { width: meta.width, height: meta.height, maxLevel: meta.max_level, split: meta.split,
                           prepared: isReady(prepared) ? "ready" : "partial", preparedBytes: folderBytes(prepared) });
    } else {
      out.prepared = "no";
    }
    const job = jobs.get(name);
    if (job) out.job = { ...job, log: job.log.slice(-12), seconds: ((job.finished || Date.now()) - job.started) / 1000 };
    return out;
  }

  function list() {
    const names = new Set<string>();
    for (const dir of [o.originals, o.data]) {
      if (!existsSync(dir)) continue;
      for (const n of readdirSync(dir)) {
        if (!safe(n)) continue;
        if (dir === o.originals ? IMAGE_EXT.test(n) : existsSync(join(dir, n, "pyramid.json"))) names.add(n);
      }
    }
    return [...names].sort().map(describe);
  }

  function next(): void {
    if (running) return;
    const name = queue.shift();
    if (!name) return;
    running = true;
    const job = jobs.get(name)!;
    const original = join(o.originals, name), prepared = join(o.data, name);
    const step = (args: string[], state: Job["state"]) => new Promise<number>((resolve) => {
      job.state = state;
      const child = spawn(o.python, ["-u", "-m", "splatpyr", ...args], { cwd: o.root });
      const take = (d: Buffer) => {
        for (const line of d.toString().split("\n").map((l) => l.trim()).filter(Boolean)) {
          if (/Warning|warn\(/.test(line)) continue;
          job.line = line;
          job.log.push(line);
          if (job.log.length > 200) job.log.shift();
          progress(job, line);
        }
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("close", (code) => resolve(code ?? 1));
    });
    (async () => {
      job.started = Date.now();
      const ok = (await step(["ingest", original, prepared], "ingesting")) === 0
              && (await step(["build", prepared], "fitting")) === 0;
      job.state = ok ? "done" : "failed";
      job.progress = ok ? 1 : job.progress;
      job.finished = Date.now();
      running = false;
      o.onReady();
      next();
    })();
  }

  /** Rough progress from the preprocessing's output: ingest is the first 10%, fitting the rest. */
  function progress(job: Job, line: string): void {
    if (job.state === "ingesting") {
      job.progress = line.startsWith("ingest done") ? 0.1 : Math.min(0.09, job.progress + 0.01);
      return;
    }
    const top = /splats for levels (\d+)\.\.(\d+)/.exec(line);
    if (top) { job.levels = [Number(top[1]), Number(top[2])]; return; }
    const lv = job.levels;
    const partial = /^level (\d+): (\d+)\/(\d+) units/.exec(line);
    const whole = /^level (\d+): \d+ units/.exec(line);
    if (lv && (partial || whole)) {
      // levels have 4x the units of the one above: weight each by its share of the work
      const [hi, lo] = lv, L = Number((partial ?? whole)![1]);
      const weight = (l: number) => 4 ** (hi - l);
      const total = Array.from({ length: hi - lo + 1 }, (_, i) => weight(hi - i)).reduce((a, b) => a + b, 0);
      let done = 0;
      for (let l = hi; l > L; l--) done += weight(l);
      done += partial ? (weight(L) * Number(partial[2])) / Number(partial[3]) : weight(L);
      job.progress = 0.1 + 0.9 * Math.min(1, done / total);
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const name = safe(url.searchParams.get("name"));
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-cache" }).end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" })
           .end(readFileSync(join(import.meta.dirname, "admin.html")));
      } else if (req.method === "GET" && url.pathname === "/api/images") {
        json(200, { images: list(), queue, originals: o.originals, data: o.data });
      } else if (req.method === "POST" && url.pathname === "/api/upload") {
        if (!name || !IMAGE_EXT.test(name)) return json(400, { error: "name must be a file name ending in .jpg, .png, .tif or .webp" });
        const target = join(o.originals, name), part = `${target}.part`;
        const out = createWriteStream(part);
        req.pipe(out);
        out.on("finish", () => { renameSync(part, target); json(200, describe(name)); });
        out.on("error", (e) => json(500, { error: String(e) }));
        req.on("aborted", () => { out.destroy(); rmSync(part, { force: true }); });
      } else if (req.method === "POST" && url.pathname === "/api/prepare") {
        if (!name || !existsSync(join(o.originals, name))) return json(404, { error: "no such original" });
        if (queue.includes(name) || ["ingesting", "fitting"].includes(jobs.get(name)?.state ?? "")) {
          return json(409, { error: "already being prepared" });
        }
        jobs.set(name, { name, state: "queued", line: "waiting for its turn", progress: 0, started: Date.now(), finished: 0, log: [] });
        queue.push(name);
        next();
        json(202, describe(name));
      } else if (req.method === "DELETE" && (url.pathname === "/api/prepared" || url.pathname === "/api/original")) {
        if (!name) return json(400, { error: "bad name" });
        if (["ingesting", "fitting", "queued"].includes(jobs.get(name)?.state ?? "")) return json(409, { error: "being prepared" });
        rmSync(join(url.pathname === "/api/prepared" ? o.data : o.originals, name), { recursive: true, force: true });
        jobs.delete(name);
        o.onReady();
        json(200, { ok: true });
      } else if (req.method === "GET" && url.pathname.startsWith("/thumb/")) {
        const n = safe(decodeURIComponent(url.pathname.slice(7)));
        const meta = n && existsSync(join(o.data, n, "pyramid.json"))
          ? JSON.parse(readFileSync(join(o.data, n, "pyramid.json"), "utf8")) : null;
        const file = meta && join(o.data, n!, "pixels", String(meta.max_level), "0_0.png");
        if (!file || !existsSync(file)) return void res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=60" }).end(readFileSync(file));
      } else {
        res.writeHead(404).end("not found");
      }
    } catch (e) {
      json(500, { error: String(e) });
    }
  });
  server.listen(o.port, () => console.log(`server site on http://localhost:${o.port}/ (originals: ${o.originals})`));
}

function folderBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
  }
  return total;
}
