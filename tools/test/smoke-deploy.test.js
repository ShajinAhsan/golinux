#!/usr/bin/env node
/**
 * Production-like smoke test. REQUIRED before any deploy.
 *
 * Serves two origins exactly as production does:
 *   app origin   (temp copy of .deploy-pages, asset origin pointed at B)
 *   asset origin (a mirror of what upload-r2.sh uploads: real chunks under
 *                 images/debian-chunks/<buildId>/, 404 for zeroed chunks)
 *
 * Then drives a FRESH headless Chrome profile through a real session:
 * first load -> shell -> ls -> gcc --version -> compile+run C -> write a file in
 * /root -> save -> reload -> assert the file survived.
 *
 * It uses NO localhost override (?assets=) and NO localStorage override: the
 * only asset origin is the staged GL_ASSET_ORIGIN, rewritten in a temp copy.
 * .deploy-pages itself is never modified.
 *
 * Network assertions:
 *   - every chunk request goes to the ASSET origin, with the build id in the
 *     path, and never to the app origin
 *   - every request for a REAL chunk returns 200
 *   - a 404 on the asset origin is only ever a known-zeroed chunk (which the
 *     service worker answers with the empty template)
 *   - no fatal "out of date" overlay appears
 *
 * Exits non-zero on any failure.
 *
 * Usage: node tools/test/smoke-deploy.test.js [--keep] [--pages DIR]
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const KEEP = process.argv.includes("--keep");
const pagesArg = process.argv.indexOf("--pages");
const PAGES_SRC = pagesArg > 0
  ? path.resolve(process.argv[pagesArg + 1])
  : path.join(ROOT, ".deploy-pages");

const PROD_ASSET_ORIGIN = "https://assets.golinux.app";

let failures = 0;
function ok(msg) { console.log("ok: " + msg); }
function bad(msg) { failures++; console.error("FAIL: " + msg); }
function check(cond, msg) { cond ? ok(msg) : bad(msg); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- static servers ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".zst": "application/zstd",
  ".bin": "application/octet-stream",
  ".png": "image/png",
};

/**
 * @param root      directory to serve
 * @param opts.assetOrigin  if set: only asset paths are served (as R2 does),
 *                          CORS headers are added, and zeroed chunks 404.
 * @param opts.realChunks   Set of real chunk names (asset mode).
 */
function serve(root, opts = {}) {
  // Every request that actually reaches this origin. This is the ground truth
  // for the network assertions: unlike the CDP Network domain it also sees
  // requests issued by the service worker, which is exactly what we must check.
  const log = opts.log || [];
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    if (rel === "") rel = "index.html";
    log.push({ method: req.method, path: "/" + rel, status: null, t: Date.now() });

    if (opts.assetOrigin) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
      res.setHeader("Access-Control-Allow-Headers",
        "Range, If-None-Match, If-Modified-Since");
      res.setHeader("Access-Control-Expose-Headers",
        "Content-Length, Content-Range, ETag");
      // The bucket only holds chunks and packs.
      if (!/^(images\/debian-chunks\/|packs\/)/.test(rel)) {
        log[log.length - 1].status = 404;
        res.writeHead(404).end("not in bucket");
        return;
      }
      // Zeroed chunks are never uploaded: 404, as R2 does.
      const m = rel.match(/\/chunk-(\d+)-(\d+)\.zst$/);
      if (m && opts.realChunks &&
          !opts.realChunks.has(path.basename(rel))) {
        log[log.length - 1].status = 404;
        res.writeHead(404).end("not stored");
        return;
      }
    } else {
      // Pages does not serve the chunk directory at all.
      if (rel.startsWith("images/debian-chunks/")) {
        log[log.length - 1].status = 404;
        res.writeHead(404).end("not on Pages");
        return;
      }
    }

    const full = path.join(root, rel);
    if (!full.startsWith(root) || !fs.existsSync(full) ||
        !fs.statSync(full).isFile()) {
      log[log.length - 1].status = 404;
      res.writeHead(404).end("not found");
      return;
    }
    const body = fs.readFileSync(full);
    log[log.length - 1].status = 200;
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full).toLowerCase()] ||
        "application/octet-stream",
      "Content-Length": body.length,
      // NOTE: deliberately NOT "immutable". The SW cache is what production
      // layers on top; for a cold-cache test the browser's own HTTP cache must
      // not be able to answer a chunk after the SW cache is cleared.
      "Cache-Control": opts.assetOrigin ? "public, max-age=0, must-revalidate"
        : "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    // Optional throttling, so the indicator test can exercise a real slow link.
    // Without it a local server answers each chunk in well under 500 ms and the
    // indicator correctly never appears.
    const t = opts.throttle;
    if (!t || !/\/debian-chunks\//.test(rel)) return res.end(body);
    setTimeout(() => {
      const slice = 16 * 1024;
      const stepMs = (slice / t.bps) * 1000;
      let off = 0;
      const tick = () => {
        if (off >= body.length) return res.end();
        res.write(body.subarray(off, off + slice));
        off += slice;
        setTimeout(tick, stepMs);
      };
      tick();
    }, t.latencyMs || 0);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, log });
    });
  });
}

/* ---------------- R2 mirror ---------------- */

/**
 * Mirror exactly what upload-r2.sh syncs: real chunks at
 * images/debian-chunks/<buildId>/, the empty template, and packs/<buildId>/.
 * Hardlinked so it is cheap.
 */
function stageR2Mirror(dest, buildId) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "images/debian-chunks/manifest.json"), "utf8"));
  const srcDir = path.join(ROOT, "images/debian-chunks");
  const chunkDst = path.join(dest, "images", "debian-chunks", buildId);
  fs.mkdirSync(chunkDst, { recursive: true });

  let n = 0;
  for (const name of manifest.real) {
    fs.linkSync(path.join(srcDir, name), path.join(chunkDst, name));
    n++;
  }
  fs.linkSync(path.join(srcDir, "empty-chunk.zst"),
    path.join(chunkDst, "empty-chunk.zst"));

  const packDst = path.join(dest, "packs", buildId);
  fs.mkdirSync(packDst, { recursive: true });
  let p = 0;
  for (const f of fs.readdirSync(path.join(ROOT, "packs"))) {
    if (f.endsWith(".json")) {
      fs.linkSync(path.join(ROOT, "packs", f), path.join(packDst, f));
      p++;
    }
  }
  return { chunks: n + 1, packs: p, real: new Set(manifest.real) };
}

/* ---------------- minimal CDP client ---------------- */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else {
        for (const h of this.handlers) h(msg);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.handlers.push(fn); }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(new CDP(ws));
    ws.onerror = () => reject(new Error("CDP websocket failed"));
  });
}

async function waitForHttp(url, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json().catch(() => ({}));
    } catch (e) { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("timed out waiting for " + what);
}

/* ---------------- browser ---------------- */

function chromePath() {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("no Chrome/Chromium found; set $CHROME");
}

/* ---------------- terminal driving (real key events) ---------------- */

async function screenText(cdp) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.querySelector(".xterm-rows");
      return el ? el.innerText : "";
    })()`,
    returnByValue: true,
  });
  return r.result.value || "";
}

async function waitScreen(cdp, re, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    last = await screenText(cdp);
    if (re.test(last)) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}. Screen tail:\n` +
    last.split("\n").slice(-8).join("\n"));
}

async function focusTerm(cdp) {
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const t = document.querySelector(".xterm-helper-textarea");
      if (t) t.focus();
      return !!t;
    })()`,
    returnByValue: true,
  });
}

async function typeText(cdp, text) {
  for (const ch of text) {
    await cdp.send("Input.dispatchKeyEvent", { type: "char", text: ch });
  }
}

async function pressEnter(cdp) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type, key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      text: type === "keyDown" ? "\r" : undefined,
    });
  }
}

async function run(cdp, cmd, expectRe, timeoutMs, what) {
  await focusTerm(cdp);
  await typeText(cdp, cmd);
  await pressEnter(cdp);
  return waitScreen(cdp, expectRe, timeoutMs, what || cmd);
}

/* ---------------- cold-profile compile phase ---------------- */

/**
 * Load the app in a FRESH browser profile and time an indicator-visible gcc
 * compile. This mirrors the measurement harness: a new profile means a new
 * service worker, empty CacheStorage and an empty v86 block cache, which is the
 * only honest way to obtain a cold first compile.
 */
async function runColdCompile(ctx) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golinux-cold-"));
  const out = { compiled: false, indicatorSeen: false, indicatorText: "",
    toolLabelIsGcc: false, stats: {}, log: [] };
  let chrome = null;
  try {
    const profile = path.join(tmp, "profile");
    fs.mkdirSync(profile, { recursive: true });
    const port = 9800 + Math.floor(Math.random() * 190);
    chrome = spawn(chromePath(), [
      "--headless=new", `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`, "--no-first-run",
      "--no-default-browser-check", "--disable-extensions",
      "--disable-dev-shm-usage", "--window-size=1280,900", "about:blank",
    ], { stdio: "ignore" });

    await waitForHttp(`http://127.0.0.1:${port}/json/version`, 20000, "Chrome");
    const targets = await waitForHttp(`http://127.0.0.1:${port}/json/list`,
      10000, "targets");
    const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page");
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    await cdp.send("Page.navigate", { url: ctx.appOrigin + "/" });
    await waitScreen(cdp, /root@golinux:~#/, 90000, "cold shell prompt");

    // Arm the observer before the compile.
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        window.__ind = { seen: false, text: "" };
        const bar = document.getElementById("diskBar");
        new MutationObserver(() => {
          if (bar.classList.contains("visible")) {
            window.__ind.seen = true;
            window.__ind.text =
              (document.getElementById("diskLabel").textContent || "") + " " +
              (document.getElementById("diskSub").textContent || "");
          }
        }).observe(bar, { attributes: true, attributeFilter: ["class"] });
      })()`,
    });

    const before = ctx.assetLog ? ctx.assetLog.length : 0;
    await focusTerm(cdp);
    await typeText(cdp, "printf 'int main(){return 0;}' > /root/t.c && " +
      "gcc /root/t.c -o /root/t && /root/t && echo COMPILE_OK");
    const t0 = Date.now();
    await pressEnter(cdp);

    let last = "";
    let seen = false, seenText = "";
    const allSeen = [];
    for (let i = 0; i < 1800; i++) {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `JSON.stringify(window.__ind)`, returnByValue: true,
      });
      const v = JSON.parse(r.result.value || "{}");
      // Keep updating: the bar may first flash a small tool (make) whose chunks
      // overlap the compile's, then settle on the real one (gcc).
      if (v.seen) { seen = true; seenText = v.text; allSeen.push(v.text); }
      last = await screenText(cdp);
      // The typed command itself contains COMPILE_OK, so its echo satisfies a
      // single match. Require two occurrences: the echo and the real output.
      if (last.split("COMPILE_OK").length - 1 >= 2) break;
      await sleep(100);
    }
    out.compiled = last.split("COMPILE_OK").length - 1 >= 2;
    out.indicatorSeen = seen;
    out.indicatorText = seenText;
    // True if gcc was ever the label during the compile.
    out.toolLabelIsGcc = allSeen.some((t) => /gcc/i.test(t));
    out.labels = allSeen;

    const hits = ctx.assetLog ? ctx.assetLog.slice(before)
      .filter((r) => /\/chunk-\d+-\d+\.zst$/.test(r.path)).length : 0;
    out.stats = { ms: Date.now() - t0, chunkRequests: hits };

    /* ---- tty resize: guest follows, and nothing is printed ---- */
    {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const t = window.emulator.serial_adapter.term;
          const vis = () => {
            const b = t.buffer.active; const o = [];
            for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
              const l = b.getLine(y); const s = l ? l.translateToString(true) : "";
              if (s.trim()) o.push(s);
            }
            return o;
          };
          fitTerminal();                 // settle at the current size
          await sleep(900);
          const before = { cols: t.cols, rows: t.rows, lines: vis() };
          applyGrid(Math.max(20, before.cols - 40), Math.max(5, before.rows - 12));
          await sleep(1600);
          return JSON.stringify({
            before, after: { cols: t.cols, rows: t.rows, lines: vis() },
          });
        })()`,
        awaitPromise: true, returnByValue: true,
      });
      const g = JSON.parse(r.result.value || "{}");
      check(g.after && g.after.rows < g.before.rows,
        `a smaller grid is applied (${g.before && g.before.rows} -> ` +
        `${g.after && g.after.rows} rows)`);

      // Nothing from the resize machinery may remain on screen.
      const residue = (g.after && g.after.lines || []).filter(
        (l) => /stty|rows \d+ cols \d+/.test(l));
      check(residue.length === 0,
        "the resize leaves no visible command output" +
        (residue.length ? ` (found: ${JSON.stringify(residue[0])})` : ""));

      // The guest tty must agree with the emulator grid.
      await focusTerm(cdp);
      await typeText(cdp, "echo SZ=$(stty size)");
      await pressEnter(cdp);
      await sleep(1500);
      const vis = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const t = window.emulator.serial_adapter.term;
          const b = t.buffer.active; const lines = [];
          for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
            const l = b.getLine(y); lines.push(l ? l.translateToString(true) : "");
          }
          return JSON.stringify(lines);
        })()`, returnByValue: true,
      });
      const lines = JSON.parse(vis.result.value || "[]");
      let last = null;
      for (const ln of lines) {
        const m = ln.trim().match(/^SZ=(\d+)\s+(\d+)$/);
        if (m) last = m;
      }
      check(!!last && Number(last[1]) === g.after.rows &&
            Number(last[2]) === g.after.cols,
        `guest tty matches the emulator grid (stty size = ` +
        `${last ? last[1] + " " + last[2] : "?"}, grid = ` +
        `${g.after.rows} ${g.after.cols})`);

      // Restore a normal terminal for the remaining phases.
      await cdp.send("Runtime.evaluate", { expression: `fitTerminal()` });
      await sleep(800);
    }

    /* ---- offline packs: exercise the real dialog logic in the page ---- */
    const pack = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const out = {};

        // Keep this cheap: the R2 mirror is throttled, so downloading the FULL
        // pack (5,600 chunks) would take minutes. Common is 701 chunks, and a
        // small synthetic pack gives us the "two packs, overlapping" case.
        const states = async () => window.GoPacks.packStates();

        // 1. Save common, then Save it again: the second must fetch nothing.
        await window.GoPacks.install("common");
        let st = await states();
        out.commonComplete = st.common.complete;
        out.commonPresent = st.common.present;
        const mark = performance.now();
        await window.GoPacks.install("common");   // second Save
        st = await states();
        out.secondSavePresent = st.common.present;
        out.secondSaveMs = Math.round(performance.now() - mark);

        // 2. Remove common: no other pack is saved, so it goes.
        const beforeRm = await (async () => {
          const c = await caches.open("golinux-pack-v13");
          return (await c.keys()).length;
        })();
        const rm = await window.GoPacks.removePack("common");
        st = await states();
        out.afterRemoveCommon = st.common.present;
        out.packCacheKeysBefore = beforeRm;
        out.removeResult = rm;

        // 3. Two saved packs that overlap: removing one must keep the other.
        //    Seeded directly (not downloaded) to keep the smoke test fast.
        {
          // Use the app's own pack URL helper: packs live on the asset origin.
          const all = await (await fetch(glPackUrl("full.json"),
            { cache: "no-store" })).json();
          const pc = await caches.open("golinux-pack-v13");
          for (const n of all) {
            await pc.put(location.origin + "/images/debian-chunks/3a3a2a8af275cc11/" + n,
              new Response("x"));
          }
          await window.GoPacks.removePack("common");
          const cached = new Set((await pc.keys()).map(k => k.url));
          out.fullSurvivesRemoveCommon = all.every(n =>
            cached.has(location.origin + "/images/debian-chunks/3a3a2a8af275cc11/" + n));
          // Clean up so later phases start from a known state.
          await window.GoPacks.useMinimal();
        }

        // 4. Two jobs at once: the second is refused.
        const a = window.GoPacks.install("common");
        await sleep(50);
        const b = await window.GoPacks.install("common");
        out.secondRefused = !!(b && b.refused);
        window.GoPacks.cancel();
        await a;
        await sleep(200);

        return JSON.stringify(out);
      })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (process.env.SMOKE_DEBUG) {
      console.log("DEBUG raw pack result:", JSON.stringify(pack).slice(0, 500));
    }
    let packRes = {};
    try { packRes = JSON.parse(pack.result.value || "{}"); }
    catch (e) {
      packRes = { error: "unparseable",
        exception: pack.exceptionDetails ? pack.exceptionDetails.text : null,
        raw: String(pack.result.value).slice(0, 300) };
    }
    out.pack = packRes;
    out.log.push("packs: " + JSON.stringify(packRes).slice(0, 600));
    out.log.push(`cold compile took ${((Date.now() - t0) / 1000).toFixed(1)}s, ` +
      `${hits} chunk requests`);
    return out;
  } finally {
    try { if (chrome) chrome.kill("SIGKILL"); } catch (e) {}
    try { require("node:child_process").execFileSync("rm", ["-rf", tmp]); } catch (e) {}
  }
}

/* ---------------- main ---------------- */

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golinux-smoke-"));
  let chrome = null;
  let appSrv = null;
  let assetSrv = null;

  const cleanup = () => {
    try { if (chrome) chrome.kill("SIGKILL"); } catch (e) {}
    try { if (appSrv) appSrv.close(); } catch (e) {}
    try { if (assetSrv) assetSrv.close(); } catch (e) {}
    if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
    else console.log("kept temp dir: " + tmp);
  };
  process.on("exit", cleanup);

  try {
    if (!fs.existsSync(path.join(PAGES_SRC, "index.html"))) {
      throw new Error(`${PAGES_SRC} is not a built Pages dir; run build-pages.sh`);
    }
    const buildInfo = JSON.parse(
      fs.readFileSync(path.join(ROOT, "images", "build-id.json"), "utf8"));
    const buildId = buildInfo.buildId;

    /* --- 1. build the two origins --- */
    const assetDir = path.join(tmp, "r2");
    const staged = stageR2Mirror(assetDir, buildId);
    console.log(`R2 mirror: ${staged.chunks} chunk files, ${staged.packs} packs ` +
      `under images/debian-chunks/${buildId}/`);

    const appDir = path.join(tmp, "app");
    fs.cpSync(PAGES_SRC, appDir, { recursive: true });
    // The app must have the precache list, or it cannot tell zeroed chunks
    // from real ones.
    check(fs.existsSync(path.join(appDir, "chunks-precache.json")),
      "staged app includes chunks-precache.json");

    // Start the asset origin first so we know its port, then point the temp
    // copy of the app at it. NEVER touch .deploy-pages itself.
    const assetLog = [];
    // Throttle chunks so a cold compile lasts long enough for the 500 ms
    // indicator window to be exercised, as it would on a real slow link.
    const a = await serve(assetDir, { assetOrigin: true,
      realChunks: staged.real, log: assetLog,
      // ~1 MB/s: a cold gcc compile takes ~10 s (well over the 500 ms
      // indicator window) without making the whole test slow.
      throttle: { bps: 1024 * 1024, latencyMs: 20 } });
    assetSrv = a.server;
    const assetOrigin = `http://127.0.0.1:${a.port}`;

    const cfgPath = path.join(appDir, "packs-config.js");
    const cfg = fs.readFileSync(cfgPath, "utf8");
    const rewritten = cfg.replace(/^const GL_ASSET_ORIGIN\s*=\s*"[^"]*";/m,
      `const GL_ASSET_ORIGIN = "${assetOrigin}";`);
    if (rewritten === cfg) throw new Error("could not rewrite GL_ASSET_ORIGIN");
    // Disable prefetch for this run: the point is to observe the compile's OWN
    // disk reads. With prefetch on, it legitimately serves them from cache and
    // the compile fetches only a handful of chunks.
    const noPrefetch = rewritten.replace(/^const GL_PREFETCH = true;/m,
      "const GL_PREFETCH = false;");
    fs.writeFileSync(cfgPath, noPrefetch);
    check(
      fs.readFileSync(path.join(PAGES_SRC, "packs-config.js"), "utf8")
        .includes(`"${PROD_ASSET_ORIGIN}"`),
      ".deploy-pages keeps its production GL_ASSET_ORIGIN (temp copy only)");

    const appLog = [];
    const p = await serve(appDir, { log: appLog });
    appSrv = p.server;
    const appOrigin = `http://127.0.0.1:${p.port}`;
    console.log(`app origin   : ${appOrigin}`);
    console.log(`asset origin : ${assetOrigin}`);

    /* --- 2. fresh headless Chrome --- */
    const profile = path.join(tmp, "chrome-profile");
    fs.mkdirSync(profile, { recursive: true });
    const cdpPort = 9200 + Math.floor(Math.random() * 500);
    chrome = spawn(chromePath(), [
      "--headless=new",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-dev-shm-usage",
      "--window-size=1280,900",
      "about:blank",
    ], { stdio: "ignore" });

    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20000, "Chrome");
    const targets = await waitForHttp(`http://127.0.0.1:${cdpPort}/json/list`,
      10000, "target list");
    const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    const cdp = await connect(page.webSocketDebuggerUrl);

    const chunks = [];       // { url, status }
    const chunkReqs = new Map();
    cdp.on((msg) => {
      if (msg.method === "Network.requestWillBeSent") {
        const u = msg.params.request.url;
        if (/\/debian-chunks\/[^/]*chunk-\d+-\d+\.zst$/.test(u)) {
          const rec = { id: msg.params.requestId, url: u, status: null };
          chunks.push(rec);
          chunkReqs.set(msg.params.requestId, rec);
        }
      } else if (msg.method === "Network.responseReceived") {
        const rec = chunkReqs.get(msg.params.requestId);
        if (rec) rec.status = msg.params.response.status;
      }
    });

    await cdp.send("Network.enable");
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    /* --- 3. first load --- */
    console.log("\n== first load ==");
    const bootMark = assetLog ? assetLog.length : 0;
    await cdp.send("Page.navigate", { url: appOrigin + "/" });
    try {
      await waitScreen(cdp, /root@golinux:~#/, 90000, "shell prompt");
    } catch (e) {
      // Turn a bare timeout into a diagnosis: is it the fatal overlay, or did
      // chunks go to the wrong origin?
      const diag = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const f = document.querySelector("#fatal");
          const v = f && f.classList.contains("visible");
          return JSON.stringify({
            fatal: v,
            title: v ? f.querySelector(".fatal-title").textContent : "",
            detail: v ? f.querySelector(".fatal-detail").textContent : "",
            status: (document.querySelector("#status") || {}).textContent || "",
          });
        })()`,
        returnByValue: true,
      }).catch(() => ({ result: { value: "{}" } }));
      const d = JSON.parse(diag.result.value || "{}");
      const chunkPaths = (log) => log.filter((r) =>
        /\/debian-chunks\//.test(r.path)).length;
      throw new Error("no shell prompt. " +
        (d.fatal ? `FATAL "${d.title}": ${d.detail} ` : `status="${d.status}" `) +
        `chunk requests: app=${chunkPaths(appLog)} asset=${chunkPaths(assetLog)}`);
    }
    addNote("shell appeared");
    if (process.env.SMOKE_DEBUG && assetLog) {
      const bootHits = assetLog.slice(bootMark)
        .filter((r) => /\/chunk-\d+-\d+\.zst$/.test(r.path)).length;
      console.log("DEBUG chunks fetched during BOOT:", bootHits);
    }

    /* --- 4. run real commands --- */
    console.log("\n== compile and run C (cold, literally the first command) ==");
    if (process.env.SMOKE_DEBUG) {
      const pre = await cdp.send("Runtime.evaluate", {
        expression: `(async () => {
          const sets = await (async () => {
            const r = await fetch("packs/3a3a2a8af275cc11/tools.json").catch(()=>null);
            return r && r.ok ? r.json() : null;
          })();
          if (!sets) return "no tools.json";
          const out = {};
          for (const id of ["gcc","make"]) {
            let have = 0;
            for (const n of sets[id].chunks) {
              for (const cn of ["golinux-pack-v13","golinux-data-v13"]) {
                const c = await caches.open(cn);
                if (await c.match("/images/debian-chunks/3a3a2a8af275cc11/" + n,
                    { ignoreSearch: true })) { have++; break; }
              }
            }
            out[id] = have + "/" + sets[id].chunks.length;
          }
          out.prefetch = window.prefetchState ? JSON.stringify(window.prefetchState.tool) : "n/a";
          return JSON.stringify(out);
        })()`, awaitPromise: true, returnByValue: true });
      console.log("DEBUG cached-before-compile:", pre.result.value);
    }
    /* A live session cannot be made cold by clearing caches: v86 keeps every
     * chunk it has read in an in-RAM block cache, so the compile would be served
     * from guest memory and fetch almost nothing. Reloading is unreliable here
     * (the SW needs to regain control). The measurement harness proved the
     * reliable answer: a FRESH browser profile. So run the cold-compile phase in
     * its own clean profile, exactly as a first-time visitor would. */
    const cold = await runColdCompile({
      appOrigin, assetOrigin, assetLog, staged: staged.real, buildId,
    });
    for (const line of cold.log) console.log(line);
    check(cold.compiled, "compiled and ran a C program (cold profile)");
    check(cold.indicatorSeen,
      "the 'Loading from disk' indicator appeared during a cold gcc compile" +
      (cold.indicatorText ? ` ("${cold.indicatorText}")` : ""));
    const pr = cold.pack || {};
    check(pr.commonComplete === true,
      "packs: saving Common completes (" + pr.commonPresent + " chunks)");
    check(pr.secondSavePresent === pr.commonPresent && pr.secondSaveMs < 3000,
      "packs: a second Save on a complete pack does nothing (" +
      pr.secondSaveMs + " ms)");
    check(pr.afterRemoveCommon === 0,
      "packs: removing Common with nothing else saved clears it (" +
      pr.afterRemoveCommon + " left)");
    check(pr.fullSurvivesRemoveCommon === true,
      "packs: removing Common while Full is saved keeps every Full chunk");
    check(pr.secondRefused === true,
      "packs: a second job started at once is refused");

    check(cold.toolLabelIsGcc,
      "the per-tool bar labelled it 'gcc' at some point during the compile" +
      (cold.labels && cold.labels.length
        ? ` (first: "${cold.labels[0]}", last: "${cold.labels[cold.labels.length-1]}")`
        : ""));
    if (process.env.SMOKE_DEBUG) {
      console.log("DEBUG cold phase:", JSON.stringify(cold.stats));
    }

    const logMark = assetLog ? assetLog.length : 0;

    /* --- 5. persistence across reload --- */
    console.log("\n== persistence ==");
    let s = await run(cdp, "echo SURVIVED > /root/marker.txt && cat /root/marker.txt",
      /SURVIVED/, 60000, "write marker");
    check(/SURVIVED/.test(s), "wrote /root/marker.txt");

    // Force a save through the public API (autosave is on a 30 s timer).
    // saveNow() deliberately DEFERS while the shell is busy, so wait for the
    // prompt to come back and for the 500 ms atPrompt poll, then retry until
    // the state is actually written.
    await waitScreen(cdp, /root@golinux:~#\s*$/, 30000, "idle prompt");
    await sleep(1200);
    const saved = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        try {
          for (let i = 0; i < 40; i++) {
            await window.GoPersist.saveNow(window.emulator, "manual");
            const meta = await window.GoPersist.readMeta();
            if (meta && meta.buildId) {
              return JSON.stringify({ ok: true, meta, tries: i + 1 });
            }
            await sleep(500);
          }
          const meta = await window.GoPersist.readMeta();
          return JSON.stringify({ ok: false, meta });
        } catch (e) { return JSON.stringify({ ok: false, err: String(e) }); }
      })()`,
      awaitPromise: true, returnByValue: true,
    });
    const savedObj = JSON.parse(saved.result.value || "{}");
    check(savedObj.ok && savedObj.meta && savedObj.meta.buildId === buildId,
      "saved user state is stamped with the build id" +
      (savedObj.ok ? "" : ` (${JSON.stringify(savedObj).slice(0, 200)})`));

    await cdp.send("Page.reload", { ignoreCache: false });
    await waitScreen(cdp, /root@golinux:~#/, 90000, "shell after reload");
    s = await run(cdp, "cat /root/marker.txt", /SURVIVED|No such file/, 60000,
      "marker after reload");
    check(/SURVIVED/.test(s), "/root file survived the reload");

    // No fatal overlay.
    const fatal = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const f = document.querySelector("#fatal");
        const visible = f && f.classList.contains("visible");
        return JSON.stringify({ visible, title: visible ?
          f.querySelector(".fatal-title").textContent : "" });
      })()`,
      returnByValue: true,
    });
    const fatalObj = JSON.parse(fatal.result.value || "{}");
    check(!fatalObj.visible, "no fatal 'out of date' overlay (got: " +
      (fatalObj.title || "none") + ")");

    /* --- 6. network assertions --- */
    console.log("\n== network ==");
    // Ground truth: what each origin actually served (this includes requests
    // made by the service worker, which CDP's Network domain does not show).
    const chunkHits = (log) => log.filter((r) =>
      /\/debian-chunks\/(?:[^/]+\/)?chunk-\d+-\d+\.zst$/.test(r.path));

    if (process.env.SMOKE_DEBUG) {
      const uniq = (l) => [...new Set(l.map(r => r.path))].sort();
      console.log("APP LOG:", JSON.stringify(uniq(appLog), null, 0).slice(0, 3000));
      console.log("ASSET LOG:", JSON.stringify(uniq(assetLog), null, 0).slice(0, 3000));
    }
    const assetChunks = chunkHits(assetLog);
    const appChunks = chunkHits(appLog);
    console.log(`asset origin: ${assetChunks.length} chunk requests, ` +
      `app origin: ${appChunks.length} chunk requests`);

    check(assetChunks.length > 0,
      "the guest actually fetched disk chunks from the asset origin");

    check(appChunks.length === 0,
      "no chunk request reached the app origin" +
      (appChunks.length ? ` (${appChunks[0].path} -> ${appChunks[0].status})` : ""));

    const prefixed = `images/debian-chunks/${buildId}/`;
    const wrongPath = assetChunks.filter((r) => !r.path.startsWith("/" + prefixed));
    check(wrongPath.length === 0,
      "every chunk path on the asset origin contained the build id (" +
      buildId + ")" +
      (wrongPath.length ? ` (${wrongPath[0].path})` : ""));

    const realHits = assetChunks.filter((r) => staged.real.has(path.basename(r.path)));
    check(realHits.length > 0,
      `fetched ${realHits.length} real data chunks`);
    const realNot200 = realHits.filter((r) => r.status !== 200);
    check(realNot200.length === 0,
      "every REAL chunk request returned 200" +
      (realNot200.length ?
        ` (${realNot200[0].path} -> ${realNot200[0].status})` : ""));

    const zeroed = assetChunks.filter((r) => !staged.real.has(path.basename(r.path)));
    const zeroedNot404 = zeroed.filter((r) => r.status !== 404);
    check(zeroedNot404.length === 0,
      "every zeroed-chunk request on the asset origin 404ed (as R2 does)" +
      (zeroedNot404.length ?
        ` (${zeroedNot404[0].path} -> ${zeroedNot404[0].status})` : ""));
  } catch (e) {
    bad(e.message);
  } finally {
    console.log(`\n${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s))`);
    process.exit(failures ? 1 : 0);
  }
})();

const notes = [];
function addNote(n) { notes.push(n); }
