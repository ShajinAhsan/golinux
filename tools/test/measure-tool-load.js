#!/usr/bin/env node
/**
 * Measure first-use tool load, with and without parallel prefetch.
 *
 * For each scenario it uses a FRESH Chrome profile (cold OPFS + cold
 * CacheStorage) against the production-like two-origin setup: the staged app on
 * one origin, a local mirror of what upload-r2.sh uploads (real
 * images/debian-chunks/<buildId>/ paths, 404 for zeroed chunks) on the other.
 *
 * Prefetch is implemented the way the real feature would be: the page fetches
 * each chunk of the tool's set from the SAME-ORIGIN chunk path, which the
 * service worker intercepts, forwards to the asset origin and caches. The
 * compile that follows then reads from the SW cache. No guest input is used to
 * decide anything, and no ?assets= override is used.
 *
 * Timing is wall-clock from "Enter" on the compile command to the next prompt.
 *
 * Usage: node tools/test/measure-tool-load.js [--tool gcc] [--reps 1]
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const argOf = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : d;
};
const TOOL = argOf("--tool", "gcc");
const REPS = Number(argOf("--reps", "1"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- servers ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".wasm": "application/wasm", ".zst": "application/zstd",
  ".bin": "application/octet-stream", ".png": "image/png",
};

function serve(root, opts = {}) {
  const log = opts.log || [];
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    if (rel === "") rel = "index.html";
    log.push(rel);
    if (opts.assetOrigin) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
      res.setHeader("Access-Control-Allow-Headers", "Range, If-None-Match");
      if (!/^(images\/debian-chunks\/|packs\/)/.test(rel)) {
        return res.writeHead(404).end("not in bucket");
      }
      const m = rel.match(/\/chunk-(\d+)-(\d+)\.zst$/);
      if (m && opts.realChunks && !opts.realChunks.has(path.basename(rel))) {
        return res.writeHead(404).end("not stored");
      }
    } else if (rel.startsWith("images/debian-chunks/")) {
      return res.writeHead(404).end("not on Pages");
    }
    const full = path.join(root, rel);
    if (!full.startsWith(root) || !fs.existsSync(full) ||
        !fs.statSync(full).isFile()) {
      return res.writeHead(404).end("nf");
    }
    const body = fs.readFileSync(full);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": opts.assetOrigin ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    // Throttle HERE, not with CDP Network.emulateNetworkConditions: that is
    // per-target and does not apply to service-worker fetches, which are the
    // ones that actually download chunks.
    const t = opts.throttleRef ? opts.throttleRef.value : null;
    if (!t) return res.end(body);
    const paceMs = (body.length / t.bps) * 1000;
    setTimeout(() => {
      if (paceMs <= 0) return res.end(body);
      // Stream in 16 KiB slices at the target rate.
      const slice = 16 * 1024;
      let off = 0;
      const stepMs = (slice / t.bps) * 1000;
      const tick = () => {
        if (off >= body.length) return res.end();
        res.write(body.subarray(off, off + slice));
        off += slice;
        setTimeout(tick, stepMs);
      };
      tick();
    }, t.latencyMs || 0);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1",
    () => r({ server, port: server.address().port, log })));
}

/* ---------------- CDP ---------------- */

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
}
const connect = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.onopen = () => res(new CDP(ws));
  ws.onerror = () => rej(new Error("ws failed"));
});

async function waitJson(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch (e) {}
    await sleep(100);
  }
  throw new Error("timeout " + url);
}

function chromePath() {
  for (const c of [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
  ].filter(Boolean)) if (fs.existsSync(c)) return c;
  throw new Error("no Chrome");
}

/* ---------------- terminal ---------------- */

async function screen(cdp) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `(() => { const e = document.querySelector(".xterm-rows");
      return e ? e.innerText : ""; })()`, returnByValue: true,
  });
  return r.result.value || "";
}
async function waitScreen(cdp, re, ms, what) {
  const end = Date.now() + ms; let last = "";
  while (Date.now() < end) {
    last = await screen(cdp);
    if (re.test(last)) return last;
    await sleep(60);
  }
  throw new Error(`timeout waiting ${what}; tail:\n` + last.split("\n").slice(-6).join("\n"));
}
async function focusTerm(cdp) {
  await cdp.send("Runtime.evaluate", {
    expression: `(() => { const t = document.querySelector(".xterm-helper-textarea");
      if (t) t.focus(); })()`,
  });
}
async function typeText(cdp, s) {
  for (const ch of s) await cdp.send("Input.dispatchKeyEvent", { type: "char", text: ch });
}
async function enter(cdp) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13, text: type === "keyDown" ? "\r" : undefined,
    });
  }
}
/**
 * Time one command by watching the serial STREAM, not the visible screen.
 *
 * Two traps this avoids:
 *   1. The echoed command line contains the same text as its output, so a
 *      screen match can fire before the command even runs (that produced a
 *      bogus 0.06 s for every compile).
 *   2. A prompt regex matches the prompt from BEFORE the command.
 * So the marker is printed as its own short line (a marker inside a long
 * command can be split by an 80-column wrap), and we count it in the raw bytes.
 */
async function timedCommand(cdp, cmd, marker, ms) {
  await focusTerm(cdp);
  await typeText(cdp, cmd);
  const t0 = Date.now();
  await enter(cdp);
  // The marker is a separate short command, so it cannot wrap and the tty runs
  // it only after the timed command finished. Its own echo line and its output
  // line are two separate occurrences: wait for the second, which cannot match
  // the echoed command we are timing.
  await typeText(cdp, `echo ${marker}`);
  await enter(cdp);
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    last = await screen(cdp);
    if (last.split(marker).length - 1 >= 2) return Date.now() - t0;
    await sleep(40);
  }
  throw new Error(`timeout waiting for ${marker}; tail:\n` +
    last.split("\n").slice(-8).join("\n"));
}

/* ---------------- R2 mirror ---------------- */

function stageR2(dest, buildId) {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, "images/debian-chunks/manifest.json"), "utf8"));
  const srcDir = path.join(ROOT, "images/debian-chunks");
  const out = path.join(dest, "images", "debian-chunks", buildId);
  fs.mkdirSync(out, { recursive: true });
  for (const n of manifest.real) fs.linkSync(path.join(srcDir, n), path.join(out, n));
  fs.linkSync(path.join(srcDir, "empty-chunk.zst"), path.join(out, "empty-chunk.zst"));
  const packs = path.join(dest, "packs", buildId);
  fs.mkdirSync(packs, { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, "packs"))) {
    if (f.endsWith(".json")) fs.linkSync(path.join(ROOT, "packs", f), path.join(packs, f));
  }
  return new Set(manifest.real);
}

/* ---------------- one scenario run ---------------- */

async function runScenario(ctx, { label, concurrency, net }) {
  const { staged, buildId } = ctx;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golinux-measure-"));
  let chrome = null;
  try {
    const profile = path.join(tmp, "profile");
    fs.mkdirSync(profile, { recursive: true });
    const port = 9400 + Math.floor(Math.random() * 400);
    chrome = spawn(chromePath(), [
      "--headless=new", `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-dev-shm-usage", "--window-size=1280,900",
      "about:blank",
    ], { stdio: "ignore" });

    await waitJson(`http://127.0.0.1:${port}/json/version`, 20000);
    const list = await waitJson(`http://127.0.0.1:${port}/json/list`, 10000);
    const page = list.find((t) => t.type === "page");
    const cdp = await connect(page.webSocketDebuggerUrl);

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    await cdp.send("Page.navigate", { url: ctx.appOrigin + "/" });
    await waitScreen(cdp, /root@golinux:~#/, 90000, "prompt");
    await sleep(500);

    // Prepare the source OUTSIDE the timed region.
    await timedCommand(cdp, "printf 'int main(){return 0;}' > /root/main.c",
      "READY_MARK", 90000);

    // The compile that the numbers describe.
    const compileCmd = "gcc /root/main.c -o /root/main";
    const setNames = global.__PREFETCH_OVERRIDE || JSON.parse(
      fs.readFileSync(path.join(ROOT, "packs", "tools.json"), "utf8"))[TOOL].chunks;

    // Prefetch, if this scenario asks for it: same-origin chunk fetches, which
    // the service worker forwards to the asset origin and caches. This is
    // exactly what the proposed page-side prefetcher would do.
    let prefetchMs = null;
    if (concurrency > 0) {
      const t0 = Date.now();
      const res = await cdp.send("Runtime.evaluate", {
        expression: `(async () => {
          const names = ${JSON.stringify(setNames)};
          const prefix = ${JSON.stringify("images/debian-chunks/" + buildId + "/")};
          let i = 0, ok = 0, failed = 0;
          async function worker() {
            while (i < names.length) {
              const n = names[i++];
              try {
                const r = await fetch(prefix + n, { cache: "default" });
                if (r.ok) { await r.arrayBuffer(); ok++; } else failed++;
              } catch (e) { failed++; }
            }
          }
          await Promise.all(Array.from({ length: ${concurrency} }, worker));
          return JSON.stringify({ ok, failed });
        })()`,
        awaitPromise: true, returnByValue: true,
      });
      prefetchMs = Date.now() - t0;
      ctx.lastPrefetch = JSON.parse(res.result.value);
      ctx.prefetchedNames = new Set(setNames);
    }

    if (ctx.assetLog) ctx.assetLog.length = 0;
    const compileMs = await timedCommand(cdp, compileCmd, "COMPILE_MARK", 300000);
    if (process.env.SMOKE_RECORD_NEEDED && ctx.assetLog) {
      global.__NEEDED = [...new Set(ctx.assetLog
        .filter((p) => /\/chunk-\d+-\d+\.zst$/.test(p))
        .map((p) => p.split("/").pop()))];
    }
    const compileNames = (ctx.assetLog || [])
      .filter((p) => /\/chunk-\d+-\d+\.zst$/.test(p))
      .map((p) => p.split("/").pop());
    const compileChunkHits = ctx.assetLog ? compileNames.length : null;
    // Split those misses: chunks the recorded set DOES contain (a regression:
    // prefetch did not cover them) vs chunks it does not (expected, because the
    // recorded command differs from the measured one).
    const setHas = new Set(setNames);
    const missedButInSet = compileNames.filter((n) => setHas.has(n));
    const missedNotInSet = compileNames.filter((n) => !setHas.has(n));
    // Did the prefetch actually populate the SW cache? A prefetched chunk that
    // is fetched again during the compile means the cache entry was not reused.
    const prefetchedAgain = ctx.prefetchedNames
      ? [...new Set(compileNames.filter((n) => ctx.prefetchedNames.has(n)))] : [];

    // Reference: a second compile with everything already cached.
    const warmMs = await timedCommand(cdp,
      "gcc /root/main.c -o /root/main2", "WARM_MARK", 180000);

    return { label, concurrency, net: net ? net.name : "fast",
      prefetchMs, compileMs, warmMs, chunks: setNames.length,
      compileChunkHits,
      missInSet: missedButInSet.length,
      missNotInSet: missedNotInSet.length,
      prefetchedAgain: prefetchedAgain.length,
      prefetchDetail: ctx.lastPrefetch };
  } finally {
    try { chrome.kill("SIGKILL"); } catch (e) {}
    // Chrome may still be flushing its profile; rmSync alone can race.
    try { require("node:child_process").execFileSync("rm", ["-rf", tmp]); } catch (e) {}
  }
}

/* ---------------- main ---------------- */

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golinux-measure-root-"));
  const servers = [];
  try {
    const buildId = JSON.parse(fs.readFileSync(
      path.join(ROOT, "images", "build-id.json"), "utf8")).buildId;

    const r2dir = path.join(tmp, "r2");
    const realChunks = stageR2(r2dir, buildId);
    const throttleRef = { value: null };
    const assetLog = [];
    const asset = await serve(r2dir, { assetOrigin: true, realChunks,
      throttleRef, log: assetLog });
    servers.push(asset.server);

    // Prepare ONE app copy per scenario is not needed: the app is read-only
    // except for the asset origin, which is identical for every run.
    const appDir = path.join(tmp, "app");
    fs.cpSync(path.join(ROOT, ".deploy-pages"), appDir, { recursive: true });
    const cfgPath = path.join(appDir, "packs-config.js");
    fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, "utf8").replace(
      /^const GL_ASSET_ORIGIN\s*=\s*"[^"]*";/m,
      `const GL_ASSET_ORIGIN = "http://127.0.0.1:${asset.port}";`));
    const app = await serve(appDir, {});
    servers.push(app.server);

    const ctx = {
      appOrigin: `http://127.0.0.1:${app.port}`,
      assetOrigin: `http://127.0.0.1:${asset.port}`,
      staged: realChunks, buildId, throttleRef, assetLog,
    };

    const nets = {
      fast: null,
      slow: { name: "slow-4Mbps-150ms", latency: 150,
              downBps: 4 * 1024 * 1024, upBps: 1 * 1024 * 1024 },
    };

    const rows = [];
    for (const [netName, net] of Object.entries(nets)) {
      for (const conc of [0, 4, 8]) {
        for (let rep = 0; rep < REPS; rep++) {
          const label = `${netName}/prefetch=${conc}`;
          process.stdout.write(`\n== ${label} (rep ${rep + 1}/${REPS}) ==\n`);
          // One asset server for all scenarios: the app's GL_ASSET_ORIGIN is
          // written into the temp copy once, so a per-scenario port would not
          // be used. Throttling is therefore a mutable value read per request.
          ctx.throttleRef.value = net
            ? { bps: net.downBps, latencyMs: net.latency } : null;
          if (ctx.assetLog) ctx.assetLog.length = 0;
          const r = await runScenario(ctx, { label, concurrency: conc, net });
          rows.push(r);
          console.log(JSON.stringify(r));
        }
      }
    }

    if (process.env.SMOKE_RECORD_NEEDED && global.__NEEDED) {
      for (const [netName, net] of Object.entries(nets)) {
        ctx.throttleRef.value = net
          ? { bps: net.downBps, latencyMs: net.latency } : null;
        global.__PREFETCH_OVERRIDE = global.__NEEDED;
        process.stdout.write(`\n== ${netName}/prefetch=4 CEILING (perfect set, ` +
          `${global.__NEEDED.length} chunks) ==\n`);
        const r = await runScenario(ctx, { label: netName + "/ceiling",
          concurrency: 4, net });
        rows.push(r);
        console.log(JSON.stringify(r));
      }
      global.__PREFETCH_OVERRIDE = null;
    }

    console.log("\n\n=== SUMMARY ===");
    console.log("network               prefetch  prefetch_s  compile_s  warm_s  compile_fetches  miss_in_set  miss_out_of_set  prefetched_again");
    for (const r of rows) {
      console.log(
        `${r.net.padEnd(22)} ${String(r.concurrency || "off").padEnd(9)} ` +
        `${(r.prefetchMs === null ? "-" : (r.prefetchMs / 1000).toFixed(2)).padStart(10)}  ` +
        `${(r.compileMs / 1000).toFixed(2).padStart(9)}  ` +
        `${(r.warmMs / 1000).toFixed(2).padStart(6)}  ` +
        `${String(r.compileChunkHits).padStart(15)}  ` +
        `${String(r.missInSet).padStart(11)}  ${String(r.missNotInSet).padStart(15)}  ` +
        `${String(r.prefetchedAgain).padStart(15)}`);
    }
    fs.writeFileSync(path.join(ROOT, ".build", "measure-tool-load.json"),
      JSON.stringify(rows, null, 2));
  } catch (e) {
    console.error("MEASURE FAILED:", e.message);
    process.exitCode = 1;
  } finally {
    for (const s of servers) { try { s.close(); } catch (e) {} }
    try { require("node:child_process").execFileSync("rm", ["-rf", tmp]); } catch (e) {}
  }
})();
