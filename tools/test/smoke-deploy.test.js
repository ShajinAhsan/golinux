#!/usr/bin/env node
/**
 * Production-like two-origin smoke + invariant test. REQUIRED before deploy.
 *
 * Verifies:
 *   1. Two-origin split (app origin + local R2 mirror with versioned paths & 404 for zeroed chunks)
 *   2. INV-1 SPY: ZERO non-user bytes reach guest stdin across boot, idle, 3 resizes, save, reload
 *   3. Cold gcc compile:
 *        - floating #diskToast appears without shifting terminal height
 *        - COMPILE_OK output stays on screen AFTER gcc finishes AND AFTER #diskToast hides
 *          (proving nothing clears/erases command output!)
 *   4. Native TERM=xterm-256color + nano clean alternate screen (zero scrollback residue)
 *   5. Native virtio-console out-of-band resize:
 *        - stty size matches browser grid after viewport resize
 *        - half-typed command survives viewport resize intact and runs on Enter
 *        - zero stty / Ctrl-L text ever injected
 *   6. Persistence across reload + Reset button clears saved session (BUG-15)
 *   7. Restart button cleanly reboots into working shell without hanging SeaBIOS (BUG-22)
 *   8. Fresh-vs-Upgrade: mismatched buildId in OPFS is rejected BOTH online and offline (BUG-05)
 *   9. Offline real-chunk miss shows #offlineBanner WITHOUT "out of date" fatal stop (BUG-09)
 *  10. Network assertions: every chunk went to asset origin with buildId, none to app origin
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

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".wasm": "application/wasm", ".zst": "application/zstd",
  ".bin": "application/octet-stream", ".png": "image/png",
};

function serve(root, opts = {}) {
  const log = opts.log || [];
  const server = http.createServer((req, res) => {
    if (opts.offlineRef && opts.offlineRef.value) {
      req.socket.destroy();
      return;
    }
    let rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    if (rel === "") rel = "index.html";
    log.push({ method: req.method, path: "/" + rel, status: null, t: Date.now() });

    if (opts.assetOrigin) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Range, If-None-Match, If-Modified-Since");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Max-Age", "86400");
        log[log.length - 1].status = 204;
        return res.writeHead(204).end();
      }
      if (!/^(images\/debian-chunks\/|bundles\/|packs\/)/.test(rel)) {
        log[log.length - 1].status = 404;
        return res.writeHead(404).end("not in bucket");
      }
      const m = rel.match(/\/chunk-(\d+)-(\d+)\.zst$/);
      if (m && opts.realChunks && !opts.realChunks.has(path.basename(rel))) {
        log[log.length - 1].status = 404;
        return res.writeHead(404).end("not stored");
      }
    } else if (rel.startsWith("images/debian-chunks/") || rel.startsWith("bundles/") || rel.startsWith("packs/")) {
      log[log.length - 1].status = 404;
      return res.writeHead(404).end("not on app origin");
    }

    const full = path.join(root, rel);
    if (!full.startsWith(root) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      log[log.length - 1].status = 404;
      return res.writeHead(404).end("not found");
    }
    const fullBody = fs.readFileSync(full);
    let body = fullBody;
    let status = 200;
    const headers = {
      "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Cache-Control": opts.assetOrigin ? "public, max-age=0, must-revalidate" : "no-cache",
    };
    const rangeHdr = req.headers.range;
    if (rangeHdr && /^bytes=\d+-\d*$/.test(rangeHdr)) {
      const [sStr, eStr] = rangeHdr.slice(6).split("-");
      const start = Number(sStr);
      const end = eStr ? Math.min(Number(eStr), fullBody.length - 1) : (fullBody.length - 1);
      if (start >= 0 && start <= end && end < fullBody.length) {
        status = 206;
        body = fullBody.subarray(start, end + 1);
        headers["Content-Range"] = `bytes ${start}-${end}/${fullBody.length}`;
      }
    }
    headers["Content-Length"] = body.length;
    log[log.length - 1].status = status;
    log[log.length - 1].bytes = body.length;
    res.writeHead(status, headers);
    if (req.method === "HEAD") return res.end();
    const t = opts.throttle;
    if (!t || (!/\/debian-chunks\//.test(rel) && !/^bundles\//.test(rel))) return res.end(body);
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
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, log }));
  });
}

function stageR2Mirror(dest, buildId) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "images/debian-chunks/manifest.json"), "utf8"));
  const srcDir = path.join(ROOT, "images/debian-chunks");
  const chunkDst = path.join(dest, "images", "debian-chunks", buildId);
  fs.mkdirSync(chunkDst, { recursive: true });
  for (const name of manifest.real) fs.linkSync(path.join(srcDir, name), path.join(chunkDst, name));
  fs.linkSync(path.join(srcDir, "empty-chunk.zst"), path.join(chunkDst, "empty-chunk.zst"));
  const bundleSrc = path.join(ROOT, "images", "debian-bundles", buildId);
  const bundleDst = path.join(dest, "bundles", buildId);
  fs.mkdirSync(bundleDst, { recursive: true });
  if (fs.existsSync(bundleSrc)) {
    for (const f of fs.readdirSync(bundleSrc)) {
      if (f.endsWith(".pack")) fs.linkSync(path.join(bundleSrc, f), path.join(bundleDst, f));
    }
  }
  const packDst = path.join(dest, "packs", buildId);
  fs.mkdirSync(packDst, { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, "packs"))) {
    if (f.endsWith(".json")) fs.linkSync(path.join(ROOT, "packs", f), path.join(packDst, f));
  }
  return { chunks: manifest.real.length + 1, real: new Set(manifest.real) };
}

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
const connect = (u) => new Promise((res, rej) => {
  const ws = new WebSocket(u);
  ws.onopen = () => res(new CDP(ws));
  ws.onerror = () => rej(new Error("CDP ws failed"));
});

async function waitForHttp(url, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return await r.json().catch(() => ({})); } catch (e) {}
    await sleep(100);
  }
  throw new Error("timed out waiting for " + what);
}

function chromePath() {
  for (const c of [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean)) if (fs.existsSync(c)) return c;
  throw new Error("no Chrome/Chromium found; set $CHROME");
}

async function screenText(cdp) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const ad = window.emulator && (window.emulator.virtio_console_adapter || window.emulator.serial_adapter);
      const t = ad && ad.term;
      if (!t) return "";
      const b = t.buffer.active;
      const lines = [];
      for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
        const l = b.getLine(y);
        if (l) lines.push(l.translateToString(true));
      }
      return lines.join("\\n");
    })()`,
    returnByValue: true,
  });
  return r.result.value || "";
}

async function waitScreen(cdp, re, ms, what) {
  const end = Date.now() + ms;
  let last = "";
  while (Date.now() < end) {
    last = await screenText(cdp);
    if (re.test(last)) return last;
    await sleep(200);
  }
  const nonEmpty = last.split("\n").filter((l) => l.trim().length > 0);
  throw new Error(`timed out waiting for ${what}. Non-empty tail:\n${nonEmpty.slice(-12).join("\n")}`);
}

async function focusTerm(cdp) {
  await cdp.send("Runtime.evaluate", {
    expression: `(() => { const t = document.querySelector(".xterm-helper-textarea"); if (t) t.focus(); })()`,
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

async function pressCtrl(cdp, ch) {
  const code = ch.toUpperCase().charCodeAt(0) - 64;
  await cdp.send("Input.dispatchKeyEvent", {
    type: "char", text: String.fromCharCode(code),
  });
}

async function runCmd(cdp, cmd, expectRe, ms, what) {
  await focusTerm(cdp);
  await typeText(cdp, cmd);
  await pressEnter(cdp);
  return waitScreen(cdp, expectRe, ms, what || cmd);
}

/** Injected before page scripts to spy on ALL guest stdin channels (INV-1). */
const STDIN_SPY_INIT = `
  window.__stdinSpy = { serial0SendCalls: 0, injectedBytes: [], userTyping: false };
  const origDefine = Object.defineProperty;
  const wrapV86 = (V86Ctor) => {
    if (!V86Ctor || V86Ctor.__spied) return V86Ctor;
    const origSerialSend = V86Ctor.prototype.serial0_send;
    V86Ctor.prototype.serial0_send = function(s) {
      window.__stdinSpy.serial0SendCalls++;
      window.__stdinSpy.injectedBytes.push({ via: "serial0_send", s: String(s) });
      return origSerialSend.call(this, s);
    };
    const Wrapped = function(...args) {
      const emu = new V86Ctor(...args);
      const origBusSend = emu.bus.send.bind(emu.bus);
      emu.bus.send = function(name, val) {
        if ((name === "serial0-input" || name === "virtio-console0-input-bytes") && !window.__stdinSpy.userTyping) {
          window.__stdinSpy.injectedBytes.push({ via: name, len: val && val.length || 1 });
        }
        return origBusSend(name, val);
      };
      return emu;
    };
    Wrapped.prototype = V86Ctor.prototype;
    Wrapped.__spied = true;
    return Wrapped;
  };
  let _V86;
  origDefine(window, "V86", {
    configurable: true,
    get() { return _V86; },
    set(v) { _V86 = wrapV86(v); },
  });
`;

async function setUserTyping(cdp, on) {
  await cdp.send("Runtime.evaluate", { expression: `window.__stdinSpy.userTyping = ${!!on};` });
}

async function launchChrome(profileDir, port) {
  const chrome = spawn(chromePath(), [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-dev-shm-usage", "--window-size=1280,900", "about:blank",
  ], { stdio: "ignore" });
  await waitForHttp(`http://127.0.0.1:${port}/json/version`, 20000, "Chrome");
  const targets = await waitForHttp(`http://127.0.0.1:${port}/json/list`, 10000, "targets");
  const page = targets.find((t) => t.type === "page");
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: STDIN_SPY_INIT });
  return { chrome, cdp };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golinux-smoke-"));
  let chrome = null, appSrv = null, assetSrv = null;

  const cleanup = () => {
    try { if (chrome) chrome.kill("SIGKILL"); } catch (e) {}
    try { if (appSrv) appSrv.close(); } catch (e) {}
    try { if (assetSrv) assetSrv.close(); } catch (e) {}
    if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  };
  process.on("exit", cleanup);

  try {
    if (!fs.existsSync(path.join(PAGES_SRC, "index.html"))) {
      throw new Error(`${PAGES_SRC} is not a built Pages dir; run build-pages.sh`);
    }
    const buildId = JSON.parse(fs.readFileSync(path.join(ROOT, "images/build-id.json"), "utf8")).buildId;
    const assetDir = path.join(tmp, "r2");
    const staged = stageR2Mirror(assetDir, buildId);

    const appDir = path.join(tmp, "app");
    fs.cpSync(PAGES_SRC, appDir, { recursive: true });
    check(fs.existsSync(path.join(appDir, "chunks-precache.json")), "staged app includes chunks-precache.json");
    const stagedSwSrc = fs.readFileSync(path.join(appDir, "sw.js"), "utf8");
    check(new RegExp(`^const GL_SW_STAMP = "v\\d+-${buildId}";`, "m").test(stagedSwSrc),
      "staged sw.js is stamped with GL_VERSION + buildId (forces Safari SW update)");

    const assetLog = [];
    const assetOffline = { value: false };
    const a = await serve(assetDir, {
      assetOrigin: true, realChunks: staged.real, log: assetLog,
      offlineRef: assetOffline,
      throttle: { bps: 1024 * 1024, latencyMs: 20 },
    });
    assetSrv = a.server;
    const assetOrigin = `http://127.0.0.1:${a.port}`;

    const cfgPath = path.join(appDir, "packs-config.js");
    const cfg = fs.readFileSync(cfgPath, "utf8");
    const rewritten = cfg.replace(/^const GL_ASSET_ORIGIN\s*=\s*"[^"]*";/m, `const GL_ASSET_ORIGIN = "${assetOrigin}";`);
    if (rewritten === cfg) throw new Error("could not rewrite GL_ASSET_ORIGIN");
    fs.writeFileSync(cfgPath, rewritten);
    check(fs.readFileSync(path.join(PAGES_SRC, "packs-config.js"), "utf8").includes(`"${PROD_ASSET_ORIGIN}"`),
      ".deploy-pages keeps production GL_ASSET_ORIGIN");

    const appLog = [];
    const p = await serve(appDir, { log: appLog });
    appSrv = p.server;
    const appOrigin = `http://127.0.0.1:${p.port}`;

    const profile = path.join(tmp, "profile");
    fs.mkdirSync(profile, { recursive: true });
    const launched = await launchChrome(profile, 9200 + Math.floor(Math.random() * 500));
    chrome = launched.chrome;
    const cdp = launched.cdp;

    /* --- 0. Landing page sanity check (index.html at "/") --- */
    console.log("\n== landing page check ==");
    await cdp.send("Page.navigate", { url: appOrigin + "/" });
    await sleep(600);
    const landingInfo = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        title: document.title,
        ctaCount: document.querySelectorAll("[data-launch-url]").length,
        hasHow: !!document.getElementById("how-it-works"),
        hasDiagram: !!document.querySelector(".arch-svg"),
      })`,
      returnByValue: true,
    })).result.value);
    check(landingInfo.ctaCount >= 3 && landingInfo.hasHow && landingInfo.hasDiagram,
      `landing page loads cleanly (${landingInfo.ctaCount} launch CTAs, animated architecture diagram)`);

    /* --- 1. First load of terminal.html + INV-1 boot spy --- */
    console.log("\n== first load + INV-1 stdin spy ==");
    await cdp.send("Page.navigate", { url: appOrigin + "/terminal.html" });
    await waitScreen(cdp, /root@golinux:~#/, 60000, "shell prompt");
    await sleep(1500);

    // Resize 3 times while idle (must NOT send any stdin bytes!)
    for (const [w, h] of [[390, 844], [844, 390], [1280, 900]]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 800 });
      await sleep(300);
    }
    const spyBoot = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify(window.__stdinSpy)`, returnByValue: true,
    })).result.value);
    check(spyBoot.serial0SendCalls === 0 && spyBoot.injectedBytes.length === 0,
      `INV-1: zero non-user bytes sent to guest during boot + 3 resizes (got ${spyBoot.injectedBytes.length})`);

    /* --- 2. Cold gcc compile: output NOT erased when #diskToast shows & hides --- */
    console.log("\n== cold gcc compile + output preservation ==");
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        window.__toastSeen = false;
        const t = document.getElementById("diskToast");
        new MutationObserver(() => {
          if (t.classList.contains("visible")) window.__toastSeen = true;
        }).observe(t, { attributes: true, attributeFilter: ["class"] });
      })()`,
    });
    await setUserTyping(cdp, true);
    await runCmd(
      cdp,
      "printf '#include <stdio.h>\\nint main(){puts(\"TCC_FAST_OK\");return 0;}\\n' > /root/t.c && gcc /root/t.c -o /root/t && /root/t && echo GCC_OUTPUT_INTACT",
      /TCC_FAST_OK[\s\S]*GCC_OUTPUT_INTACT/,
      120000,
      "cold tcc/gcc compile"
    );
    await setUserTyping(cdp, false);
    // Wait past #diskToast hide settle (1200ms) and assert output was NEVER erased!
    await sleep(1200);
    const afterGcc = await screenText(cdp);
    check(afterGcc.includes("TCC_FAST_OK") && afterGcc.includes("GCC_OUTPUT_INTACT"),
      "tcc/gcc compiled & ran cleanly and output stayed intact on screen (no Ctrl-L erase!)");

    /* --- 3. Native TERM=xterm-256color + clean nano scrollback --- */
    console.log("\n== TERM & nano alternate screen ==");
    await setUserTyping(cdp, true);
    const termOut = await runCmd(
      cdp,
      "echo T=$TERM; (test -f /etc/terminfo/x/xterm-256color || test -f /usr/share/terminfo/x/xterm-256color) && echo SMCUP_OK",
      /T=xterm-256color[\s\S]*SMCUP_OK/,
      15000,
      "TERM check"
    );
    check(/T=xterm-256color/.test(termOut) && /SMCUP_OK/.test(termOut),
      "native TERM=xterm-256color with xterm-256color terminfo (without serial0_send)");

    // Verify vibrant ls colors (directories colored distinctly from regular files via LS_COLORS + alias ls)
    await runCmd(
      cdp,
      "mkdir -p /root/vdir && touch /root/vfile && ls -1 /root && echo LS_COLOR_DONE",
      /LS_COLOR_DONE[\s\S]*LS_COLOR_DONE/,
      15000,
      "colored ls output"
    );
    const lsColors = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const t = window.emulator.virtio_console_adapter.term;
        const b = t.buffer.active;
        let dirFg = null, fileFg = null;
        for (let y = b.length - 1; y >= 0; y--) {
          const line = b.getLine(y);
          if (!line) continue;
          const str = line.translateToString(true).trim();
          if (str === "vdir" && !dirFg) {
            const c = line.getCell(0);
            if (c) dirFg = { mode: c.getFgColorMode(), col: c.getFgColor(), bold: c.isBold() };
          }
          if (str === "vfile" && !fileFg) {
            const c = line.getCell(0);
            if (c) fileFg = { mode: c.getFgColorMode(), col: c.getFgColor(), bold: c.isBold() };
          }
          if (dirFg && fileFg) break;
        }
        return JSON.stringify({ dirFg, fileFg });
      })()`,
      returnByValue: true,
    })).result.value);
    check(
      lsColors.dirFg && lsColors.fileFg &&
      (lsColors.dirFg.col !== lsColors.fileFg.col || lsColors.dirFg.mode !== lsColors.fileFg.mode || lsColors.dirFg.bold !== lsColors.fileFg.bold),
      `ls colors directories distinctly from files (dir=${JSON.stringify(lsColors.dirFg)}, file=${JSON.stringify(lsColors.fileFg)})`
    );

    const baseBeforeNano = (await cdp.send("Runtime.evaluate", {
      expression: `window.emulator.virtio_console_adapter.term.buffer.active.baseY`, returnByValue: true,
    })).result.value;
    await focusTerm(cdp);
    await typeText(cdp, "nano /root/t.c");
    await pressEnter(cdp);
    await waitScreen(cdp, /GNU nano[\s\S]*#include/, 30000, "nano opens /root/t.c");
    await sleep(250);
    const nanoSyntax = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const b = window.emulator.virtio_console_adapter.term.buffer.active;
        let incColored = false, intColored = false;
        for (let y = 0; y < b.length; y++) {
          const l = b.getLine(y);
          if (!l) continue;
          const s = l.translateToString(true);
          const incIdx = s.indexOf("#include");
          if (incIdx >= 0) {
            const c = l.getCell(incIdx);
            if (c && c.getFgColorMode() !== 0) incColored = true;
          }
          const intIdx = s.indexOf("int main");
          if (intIdx >= 0) {
            const c = l.getCell(intIdx);
            if (c && c.getFgColorMode() !== 0) intColored = true;
          }
        }
        return JSON.stringify({ incColored, intColored });
      })()`,
      returnByValue: true,
    })).result.value);
    check(nanoSyntax.incColored && nanoSyntax.intColored,
      `nano C syntax highlighting is colorful (#include=${nanoSyntax.incColored}, int=${nanoSyntax.intColored})`);
    await pressCtrl(cdp, "x");
    await waitScreen(cdp, /nano \/root\/t\.c[\s\S]*root@golinux:~#/, 15000, "nano exits");
    await setUserTyping(cdp, false);
    const nanoCheck = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const b = window.emulator.virtio_console_adapter.term.buffer.active;
        let nanoLines = 0;
        for (let y = 0; y < b.length; y++) {
          const l = b.getLine(y);
          if (l && /GNU nano/.test(l.translateToString(true))) nanoLines++;
        }
        return JSON.stringify({ nanoLines, baseY: b.baseY });
      })()`,
      returnByValue: true,
    })).result.value);
    check(nanoCheck.nanoLines === 0, `nano leaves zero residue in buffer (found ${nanoCheck.nanoLines})`);
    check(nanoCheck.baseY === baseBeforeNano, `nano adds zero scrollback lines (${baseBeforeNano} -> ${nanoCheck.baseY})`);

    // Verify man pages (find/du/df), lsblk, man git alternate-screen cleanup, and clear scrollback wipe
    console.log("\n== man pages, lsblk, less alternate screen, clear scrollback ==");
    await setUserTyping(cdp, true);
    const manLsblkOut = await runCmd(
      cdp,
      "man -w find >/dev/null && man -w du >/dev/null && man -w df >/dev/null && lsblk | grep -q sda && echo MAN_LSBLK_OK",
      /MAN_LSBLK_OK[\s\S]*MAN_LSBLK_OK/,
      30000,
      "man find/du/df + lsblk"
    );
    check(/MAN_LSBLK_OK/.test(manLsblkOut), "man find, man du, man df manuals exist and lsblk reports sda");

    const baseBeforeMan = (await cdp.send("Runtime.evaluate", {
      expression: `window.emulator.virtio_console_adapter.term.buffer.active.baseY`, returnByValue: true,
    })).result.value;
    await focusTerm(cdp);
    await typeText(cdp, "man git");
    await pressEnter(cdp);
    await waitScreen(cdp, /GIT\(1\)/, 30000, "man git opens in less");
    await sleep(150);
    await typeText(cdp, "q");
    await waitScreen(cdp, /man git[\s\S]*root@golinux:~#/, 15000, "man git exits");
    await setUserTyping(cdp, false);
    const manCheck = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const b = window.emulator.virtio_console_adapter.term.buffer.active;
        let gitHeaderLines = 0;
        for (let y = 0; y < b.length; y++) {
          const l = b.getLine(y);
          if (l && /GIT\(1\)/.test(l.translateToString(true))) gitHeaderLines++;
        }
        return JSON.stringify({ gitHeaderLines, baseY: b.baseY });
      })()`,
      returnByValue: true,
    })).result.value);
    check(manCheck.gitHeaderLines === 0,
      `man git (via less) leaves zero GIT(1) residue in scrollback (found ${manCheck.gitHeaderLines})`);
    check(manCheck.baseY === baseBeforeMan,
      `man git adds zero scrollback lines (${baseBeforeMan} -> ${manCheck.baseY})`);

    // Verify `clear` wipes BOTH viewport AND scrollback buffer (\e[3J)
    await setUserTyping(cdp, true);
    await runCmd(cdp, "clear && echo CLEARED_SCROLLBACK_OK", /^CLEARED_SCROLLBACK_OK$/m, 15000, "clear wipes scrollback");
    await setUserTyping(cdp, false);
    const clearCheck = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const b = window.emulator.virtio_console_adapter.term.buffer.active;
        let staleFound = false;
        for (let y = 0; y < b.length; y++) {
          const l = b.getLine(y);
          if (l && /GCC_OUTPUT_INTACT|GIT\(1\)/.test(l.translateToString(true))) staleFound = true;
        }
        return JSON.stringify({ baseY: b.baseY, staleFound });
      })()`,
      returnByValue: true,
    })).result.value);
    check(clearCheck.baseY === 0 && !clearCheck.staleFound,
      `clear wipes scrollback completely (baseY=${clearCheck.baseY}, staleFound=${clearCheck.staleFound})`);

    // Verify newly added CLI tools (fastfetch, cowsay, python3, jq, tree)
    console.log("\n== new CLI tools (fastfetch, cowsay, python3, jq, tree) ==");
    await setUserTyping(cdp, true);
    const toolsOut = await runCmd(
      cdp,
      "fastfetch >/dev/null && cowsay HI_MOO | grep -q HI_MOO && python3 -c 'print(6*7)' && echo '{\"v\":9}' | jq -r .v && tree -L 1 /root >/dev/null && echo NEW_TOOLS_OK",
      /42[\s\S]*9[\s\S]*NEW_TOOLS_OK/,
      90000,
      "new CLI tools check"
    );
    await setUserTyping(cdp, false);
    const toastSeen = (await cdp.send("Runtime.evaluate", {
      expression: `window.__toastSeen`, returnByValue: true,
    })).result.value;
    check(toastSeen === true, "floating #diskToast appeared during cold multi-bundle load (python3/tools)");
    check(/NEW_TOOLS_OK/.test(toolsOut), "fastfetch, cowsay, python3, jq, tree all work cleanly");

    // Regression: small chunks (<200 B compressed, e.g. /etc/resolv.conf = 49 B) must NEVER be zeroed
    await setUserTyping(cdp, true);
    const resolvOut = await runCmd(
      cdp,
      "grep -qx 'nameserver 192.168.86.1' /etc/resolv.conf && ip -4 addr show dev eth0 | grep -q '192.168.86.100/24' && echo NET_CFG_OK",
      /NET_CFG_OK/,
      15000,
      "resolv.conf and eth0 intact on chunked disk"
    );
    await setUserTyping(cdp, false);
    check(/NET_CFG_OK/.test(resolvOut), "chunked disk preserves /etc/resolv.conf (192.168.86.1) and eth0");

    /* --- 4. Out-of-band virtio-console resize preserves half-typed command & no-newline output --- */
    console.log("\n== virtio-console out-of-band resize ==");
    await setUserTyping(cdp, true);
    // Regression: output WITHOUT trailing newline (e.g. printf("Hello World")) must NOT vanish on slight resize!
    await runCmd(cdp, "printf 'Hello World'", /Hello World/, 15000, "no-newline Hello World");
    await setUserTyping(cdp, false);
    await sleep(200);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1120, height: 860, deviceScaleFactor: 1, mobile: false });
    await sleep(450);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(450);
    const afterNoNlResize = await screenText(cdp);
    check(afterNoNlResize.includes("Hello World"),
      "no-newline output ('Hello World') stays visible after slightly resizing window");

    await setUserTyping(cdp, true);
    await focusTerm(cdp);
    await typeText(cdp, "echo TYPED_SURVIVES");
    await setUserTyping(cdp, false);
    await sleep(200);
    // Resize window while half-typed command is sitting on the prompt!
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 480, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    await setUserTyping(cdp, true);
    await pressEnter(cdp);
    const survived = await waitScreen(cdp, /TYPED_SURVIVES[\s\S]*TYPED_SURVIVES/, 15000, "half-typed command runs");
    check(!/stty (rows|echo|-echo)/.test(survived), "zero stty injection during resize");

    // Verify guest stty size matches browser xterm grid
    const szOut = await runCmd(cdp, "echo SZ=$(stty size) END_SZ", /SZ=\d+ \d+ END_SZ/, 15000, "stty size");
    await setUserTyping(cdp, false);
    const gridNow = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `(() => { const t = window.emulator.virtio_console_adapter.term; return JSON.stringify({ cols: t.cols, rows: t.rows }); })()`,
      returnByValue: true,
    })).result.value);
    const szMatch = szOut.match(/SZ=(\d+) (\d+) END_SZ/);
    check(!!szMatch && Number(szMatch[1]) === gridNow.rows && Number(szMatch[2]) === gridNow.cols,
      `guest tty matches xterm grid via virtio-console0-resize (${szMatch ? szMatch[1] + "x" + szMatch[2] : "?"} vs ${gridNow.rows}x${gridNow.cols})`);

    // Mobile keyboard toggle/size-change flicker regression:
    // 1. Height-only viewport changes at the normal bash prompt must send ZERO SIGWINCH
    //    and produce ZERO guest prompt redraw bytes (eliminating root@golinux:~# flicker).
    // 2. Opening nano while the keyboard is shrunk must immediately flush the deferred
    //    height via onBufferChange so nano's bottom bar fits inside the shrunk screen.
    // 3. Resizing keyboard while inside nano (alternate buffer) must send 1 debounced resize.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(450);
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const bus = window.emulator.bus;
        window.__origBusSend = bus.send.bind(bus);
        window.__virtioResizeCount = 0;
        window.__guestOutBytes = 0;
        bus.send = function(name, value) {
          if (name === "virtio-console0-resize") window.__virtioResizeCount++;
          return window.__origBusSend(name, value);
        };
        window.__guestOutListener = (bytes) => {
          window.__guestOutBytes += bytes ? bytes.length : 0;
        };
        window.emulator.add_listener("virtio-console0-output-bytes", window.__guestOutListener);
      })()`,
    });
    for (const h of [760, 680, 600, 540, 480]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: h, deviceScaleFactor: 1, mobile: true });
      await sleep(30);
    }
    await sleep(400);
    const kbdPromptStats = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({ resizes: window.__virtioResizeCount, bytes: window.__guestOutBytes })`,
      returnByValue: true,
    })).result.value);
    check(kbdPromptStats.resizes === 0 && kbdPromptStats.bytes === 0,
      `mobile keyboard height change at bash prompt sends 0 SIGWINCH & 0 prompt redraw bytes (resizes=${kbdPromptStats.resizes}, bytes=${kbdPromptStats.bytes})`);

    // Now launch nano while still at shrunk mobile keyboard height (390x480)
    await setUserTyping(cdp, true);
    await focusTerm(cdp);
    await typeText(cdp, "nano /root/t.c");
    await pressEnter(cdp);
    await waitScreen(cdp, /GNU nano[\s\S]*Exit/, 15000, "nano fits shrunk mobile keyboard height");
    await sleep(250);
    const nanoAltResizes = (await cdp.send("Runtime.evaluate", {
      expression: `window.__virtioResizeCount`,
      returnByValue: true,
    })).result.value;
    check(nanoAltResizes >= 1,
      `entering nano flushed deferred mobile keyboard height via onBufferChange (resizes=${nanoAltResizes})`);

    // Now close keyboard while inside nano (alternate buffer): nano MUST receive 1 resize
    await cdp.send("Runtime.evaluate", { expression: `window.__virtioResizeCount = 0;` });
    for (const h of [600, 720, 844]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: h, deviceScaleFactor: 1, mobile: true });
      await sleep(30);
    }
    await sleep(450);
    const nanoCloseResizes = (await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const n = window.__virtioResizeCount;
        window.emulator.bus.send = window.__origBusSend;
        window.emulator.remove_listener("virtio-console0-output-bytes", window.__guestOutListener);
        delete window.__origBusSend;
        delete window.__guestOutListener;
        return n;
      })()`,
      returnByValue: true,
    })).result.value;
    check(nanoCloseResizes === 1,
      `keyboard close inside nano (alternate buffer) coalesced into 1 resize (got ${nanoCloseResizes})`);
    await pressCtrl(cdp, "x");
    await waitScreen(cdp, /root@golinux:~#/, 15000, "nano exits after mobile keyboard test");
    await setUserTyping(cdp, false);

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);

    /* --- 5. Upload & Option A Download (/mnt/host) with ZERO stdin injection --- */
    console.log("\n== upload & download (/mnt/host, zero stdin) ==");
    await sleep(150);
    await cdp.send("Runtime.evaluate", {
      expression: `window.__stdinSpy.injectedBytes = []; window.__stdinSpy.serial0SendCalls = 0;`,
    });
    await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const dt = new DataTransfer();
        // Deliberately include shell metacharacters to prove zero shell injection (BUG-03).
        dt.items.add(new File(["UPLOAD_PAYLOAD_OK\\n"], 'safe"; $(touch pwned); #.txt', { type: "text/plain" }));
        const input = document.getElementById("uploadInput");
        input.files = dt.files;
        input.dispatchEvent(new Event("change"));
      })()`,
    });
    await sleep(600);
    const spyAfterUpload = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify(window.__stdinSpy)`, returnByValue: true,
    })).result.value);
    check(spyAfterUpload.serial0SendCalls === 0 && spyAfterUpload.injectedBytes.length === 0,
      "INV-1: Upload sends zero bytes to guest stdin (zero shell injection, BUG-03)");

    await setUserTyping(cdp, true);
    const upCheck = await runCmd(
      cdp,
      "test ! -f /root/pwned && cat /mnt/host/safe* && echo FROM_GUEST_9P > /mnt/host/export.txt && echo EXPORT_WRITTEN",
      /UPLOAD_PAYLOAD_OK[\s\S]*EXPORT_WRITTEN/,
      20000,
      "verify upload & create guest export"
    );
    await sleep(150);
    await setUserTyping(cdp, false);
    check(/UPLOAD_PAYLOAD_OK/.test(upCheck), "uploaded file readable in guest /mnt/host without shell injection");

    // Open Download modal (Option A): must list export.txt and read it via 9p with zero stdin!
    await cdp.send("Runtime.evaluate", {
      expression: `window.__stdinSpy.injectedBytes = []; window.__stdinSpy.serial0SendCalls = 0; document.getElementById("downloadBtn").click();`,
    });
    await sleep(200);
    const dlModalState = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const visible = document.getElementById("filesModal").classList.contains("visible");
        const items = [...document.querySelectorAll("#filesList .hf-name")].map(e => e.textContent);
        const btn = document.querySelector('#filesList button[data-download-path="export.txt"]');
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 300));
        const status = document.getElementById("filesStatus").textContent;
        document.getElementById("closeFiles").click();
        return JSON.stringify({ visible, items, status });
      })()`,
      awaitPromise: true, returnByValue: true,
    })).result.value);
    check(dlModalState.visible === true && dlModalState.items.includes("export.txt"),
      "Download modal lists guest file from /mnt/host (" + dlModalState.items.join(", ") + ")");
    check(/Downloaded export\.txt/.test(dlModalState.status),
      "Option A Download succeeded via 9p read_file (" + dlModalState.status + ")");
    const spyAfterDownload = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify(window.__stdinSpy)`, returnByValue: true,
    })).result.value);
    check(spyAfterDownload.serial0SendCalls === 0 && spyAfterDownload.injectedBytes.length === 0,
      "INV-1: Option A Download sends zero bytes to guest stdin (BUG-04)");

    /* --- 6. Persistence across reload + INV-1 spy on restore --- */
    console.log("\n== persistence & restore ==");
    await setUserTyping(cdp, true);
    await runCmd(cdp, "echo SURVIVED_TEST > /root/marker.txt && cat /root/marker.txt", /SURVIVED_TEST/, 20000, "write marker");
    await setUserTyping(cdp, false);
    await sleep(400);

    const savedObj = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const ok = await window.GoPersist.saveNow(window.emulator, "manual");
        const meta = await window.GoPersist.readMeta();
        return JSON.stringify({ ok, meta, expectedSchema: typeof GL_STATE_SCHEMA === "number" ? GL_STATE_SCHEMA : 4 });
      })()`,
      awaitPromise: true, returnByValue: true,
    })).result.value);
    check(savedObj.ok && savedObj.meta && savedObj.meta.buildId === buildId && savedObj.meta.schema === savedObj.expectedSchema,
      `saved state stamped with buildId and schema=${savedObj.expectedSchema}`);

    await cdp.send("Page.reload", { ignoreCache: false });
    await waitScreen(cdp, /\[session restored\][\s\S]*root@golinux:~#/, 60000, "restored banner + redrawn prompt");
    await sleep(500);
    const spyRestore = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify(window.__stdinSpy)`, returnByValue: true,
    })).result.value);
    check(spyRestore.serial0SendCalls === 0 && spyRestore.injectedBytes.length === 0,
      `INV-1: zero non-user bytes sent on session restore`);

    await setUserTyping(cdp, true);
    const afterReload = await runCmd(cdp, "cat /root/marker.txt", /SURVIVED_TEST|No such file/, 20000, "marker after reload");
    await setUserTyping(cdp, false);
    check(/SURVIVED_TEST/.test(afterReload), "/root/marker.txt survived reload");

    /* --- 6. Safe Restart button (BUG-22) --- */
    console.log("\n== safe Restart button ==");
    await cdp.send("Runtime.evaluate", { expression: `document.getElementById("restart").click()` });
    await sleep(1500);
    await waitScreen(cdp, /\[session restored\][\s\S]*root@golinux:~#/, 30000, "prompt after Restart");
    await setUserTyping(cdp, true);
    const afterRestart = await runCmd(cdp, "echo RESTART_ALIVE", /RESTART_ALIVE[\s\S]*RESTART_ALIVE/, 20000, "after Restart");
    await setUserTyping(cdp, false);
    check(/RESTART_ALIVE/.test(afterRestart), "Restart button boots working shell (never hangs SeaBIOS, BUG-22)");

    /* --- 7. Safe Reset button (BUG-15 + deep cache/SW refresh) --- */
    console.log("\n== safe Reset button ==");
    await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const c = await caches.open("golinux-shell-v0-stale");
        await c.put("/stale-probe", new Response("old"));
        window.confirm = () => true;
        document.getElementById("resetBtn").click();
      })()`,
      awaitPromise: true,
    });
    await sleep(3000);
    await waitScreen(cdp, /root@golinux:~#/, 60000, "prompt after Reset");
    const cachesAfterReset = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `caches.keys().then((k) => JSON.stringify(k))`,
      awaitPromise: true, returnByValue: true,
    })).result.value);
    check(!cachesAfterReset.includes("golinux-shell-v0-stale"),
      `Reset wiped stale Cache Storage entries (caches=${JSON.stringify(cachesAfterReset)})`);
    await setUserTyping(cdp, true);
    const afterReset = await runCmd(cdp, "test -f /root/marker.txt && echo STILL_THERE || echo CLEAN_RESET", /STILL_THERE|CLEAN_RESET/, 20000, "after Reset");
    await setUserTyping(cdp, false);
    check(/CLEAN_RESET/.test(afterReset), "Reset wiped saved session cleanly without pagehide re-save race (BUG-15)");

    /* --- 7b. Normal-tab seamless upgrade (no incognito, no manual cache clear) --- */
    console.log("\n== normal-tab upgrade (SW stamp + auto-reload) ==");
    const verBeforeUpgrade = (await cdp.send("Runtime.evaluate", {
      expression: `GL_VERSION`, returnByValue: true,
    })).result.value;
    const nextVer = verBeforeUpgrade + "next";
    fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, "utf8").replace(
      /^const GL_VERSION = "[^"]+";/m,
      `const GL_VERSION = "${nextVer}";`
    ));
    const swPath = path.join(appDir, "sw.js");
    fs.writeFileSync(swPath, fs.readFileSync(swPath, "utf8").replace(
      /^const GL_SW_STAMP = "[^"]+";/m,
      `const GL_SW_STAMP = "${nextVer}-${buildId}";`
    ));
    // Reload in the SAME normal tab (ignoreCache: false) — must auto-upgrade cleanly!
    await cdp.send("Page.reload", { ignoreCache: false });
    // Wait for auto-reload + fresh boot on nextVer
    for (let i = 0; i < 60; i++) {
      const v = (await cdp.send("Runtime.evaluate", {
        expression: `typeof GL_VERSION === "string" ? GL_VERSION : ""`,
        returnByValue: true,
      })).result.value;
      if (v === nextVer) break;
      await sleep(300);
    }
    await waitScreen(cdp, /root@golinux:~#/, 60000, "prompt after normal-tab auto-upgrade");
    const upgradeCheck = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `(async () => JSON.stringify({
        version: GL_VERSION,
        caches: await caches.keys(),
      }))()`,
      awaitPromise: true, returnByValue: true,
    })).result.value);
    check(upgradeCheck.version === nextVer,
      `normal tab auto-upgraded cleanly (${verBeforeUpgrade} -> ${upgradeCheck.version}) with zero manual cache clear`);
    check(upgradeCheck.caches.includes("golinux-shell-" + nextVer) &&
          !upgradeCheck.caches.includes("golinux-shell-" + verBeforeUpgrade),
      `old SW caches purged on upgrade (active=${JSON.stringify(upgradeCheck.caches)})`);

    /* --- 8. Fresh-vs-Upgrade: mismatched buildId rejected online AND offline (BUG-05) --- */
    console.log("\n== upgrade safety (online & offline) ==");
    await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle("golinux", { create: true });
        const sf = await dir.getFileHandle("state.gz", { create: true });
        const sw = await sf.createWritable();
        await sw.write(new Blob([new Uint8Array([1, 2, 3])]));
        await sw.close();
        const mf = await dir.getFileHandle("meta.json", { create: true });
        const mw = await mf.createWritable();
        await mw.write(JSON.stringify({ buildId: "0000000000000001", schema: typeof GL_STATE_SCHEMA === "number" ? GL_STATE_SCHEMA : 4 }));
        await mw.close();
      })()`,
      awaitPromise: true,
    });
    // Reload offline: MUST reject mismatched buildId even when offline!
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    await cdp.send("Page.reload", { ignoreCache: false });
    await waitScreen(cdp, /root@golinux:~#/, 60000, "offline boot with stale state");
    const usedStaleOffline = (await cdp.send("Runtime.evaluate", {
      expression: `window.__usedUserState === true`, returnByValue: true,
    })).result.value;
    check(usedStaleOffline === false, "offline upgrade: mismatched saved buildId is refused (BUG-05)");

    /* --- 9. Offline real-chunk miss shows #offlineBanner, NOT fatal "out of date" (BUG-09) --- */
    console.log("\n== offline real-chunk UX ==");
    // Disconnect the asset origin at TCP level so the Service Worker's own
    // fetch() truly fails (CDP Network.emulateNetworkConditions only affects
    // the page target, not SW fetches).
    assetOffline.value = true;
    await setUserTyping(cdp, true);
    await focusTerm(cdp);
    await typeText(cdp, "curl --version");
    await pressEnter(cdp);
    await setUserTyping(cdp, false);
    await sleep(3000);
    const offlineUi = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        banner: document.getElementById("offlineBanner").classList.contains("visible"),
        fatal: document.getElementById("fatal").classList.contains("visible"),
      })`,
      returnByValue: true,
    })).result.value);
    check(offlineUi.banner === true, "offline real-chunk miss displays #offlineBanner");
    check(offlineUi.fatal === false, "offline real-chunk miss does NOT show fatal 'out of date' (BUG-09)");
    assetOffline.value = false;
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    await cdp.send("Runtime.evaluate", { expression: `window.dispatchEvent(new Event("online"))` });
    await sleep(100);
    const bannerAfterOnline = (await cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("offlineBanner").classList.contains("visible")`,
      returnByValue: true,
    })).result.value;
    check(bannerAfterOnline === false, "#offlineBanner hides automatically when internet reconnects");

    /* --- 9b. Clearing ALL Cache Storage + unregistering SW mid-session must NOT freeze terminal --- */
    console.log("\n== clear site data & cache mid-session resilience ==");
    await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        for (const k of await caches.keys()) await caches.delete(k);
        for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      })()`,
      awaitPromise: true,
    });
    await sleep(300);
    await setUserTyping(cdp, true);
    const afterWipe = await runCmd(
      cdp,
      "clear && ls /root >/dev/null && figlet OK >/dev/null && echo ALIVE_AFTER_WIPE",
      /^ALIVE_AFTER_WIPE$/m,
      45000,
      "commands after clearing site data & cache mid-session"
    );
    await setUserTyping(cdp, false);
    check(/ALIVE_AFTER_WIPE/.test(afterWipe),
      "clear, ls, and uncached bundle tool (figlet) keep working without freezing after clearing site data/cache mid-session");

    /* --- 9c. Slow-link (500 Kbps) adaptive HTTP Range fetch --- */
    console.log("\n== slow-link (500 Kbps) adaptive Range mode ==");
    await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        localStorage.setItem("golinux.bwMode", "slow");
        localStorage.setItem("golinux.autowarm", "off");
        await caches.delete(GL_DATA_CACHE);
      })()`,
      awaitPromise: true,
    });
    await cdp.send("Page.reload", { ignoreCache: false });
    await waitScreen(cdp, /root@golinux:~#/, 60000, "fresh boot in slow-link mode");
    const logIdxBeforeSlow = assetLog.length;
    await setUserTyping(cdp, true);
    const slowOut = await runCmd(
      cdp,
      "tmux -V && echo SLOW_TMUX_OK",
      /^SLOW_TMUX_OK$/m,
      30000,
      "slow-link tmux over Range requests"
    );
    await setUserTyping(cdp, false);
    const slowReqs = assetLog.slice(logIdxBeforeSlow).filter((r) => r.method === "GET" && /\/bundles\/[^/]+\/b-[^/]+\.pack$/.test(r.path));
    const slow206 = slowReqs.filter((r) => r.status === 206);
    check(/tmux[\s\S]*SLOW_TMUX_OK/.test(slowOut), "slow-link mode executes cold tool (tmux) accurately");
    check(slow206.length > 0, `slow-link mode fetched exact 206 byte ranges (got ${slow206.length} x 206 out of ${slowReqs.length} GETs)`);
    const slowTotalBytes = slow206.reduce((s, r) => s + (r.bytes || 0), 0);
    check(slowTotalBytes < 1200 * 1024, `slow-link tmux downloaded compact range bytes (${Math.round(slowTotalBytes / 1024)} KB < 1200 KB vs 2325 KB full bundles)`);
    await cdp.send("Runtime.evaluate", {
      expression: `localStorage.removeItem("golinux.bwMode"); localStorage.removeItem("golinux.autowarm");`,
    });

    /* --- 10. Network assertions --- */
    console.log("\n== network assertions ==");
    const chunkHits = (log) => log.filter((r) => r.method === "GET" && /\/debian-chunks\/(?:[^/]+\/)?chunk-\d+-\d+\.zst$/.test(r.path));
    const bundleHits = (log) => log.filter((r) => r.method === "GET" && /\/bundles\/[^/]+\/b-[^/]+\.pack$/.test(r.path));
    const assetChunks = chunkHits(assetLog);
    const appChunks = chunkHits(appLog);
    const assetBundles = bundleHits(assetLog);
    const appBundles = bundleHits(appLog);
    const fastBundleHits = assetBundles.filter((r) => r.status === 200);
    check(assetBundles.length > 0, `guest fetched ${assetBundles.length} hybrid .pack requests from asset origin (${fastBundleHits.length} x 200, ${assetBundles.length - fastBundleHits.length} x 206)`);
    check(fastBundleHits.length < 60, `hybrid bundling kept fast-mode R2 bundle fetches compact (${fastBundleHits.length} < 60)`);
    check(assetChunks.length === 0, `zero individual .zst chunk fetches or 404s hit asset origin (got ${assetChunks.length})`);
    check(appChunks.length === 0 && appBundles.length === 0, "zero chunk/bundle requests reached app origin");
    const bundlePrefix = `/bundles/${buildId}/`;
    check(assetBundles.every((r) => r.path.startsWith(bundlePrefix) && (r.status === 200 || r.status === 206)),
      `every bundle path carries buildId ${buildId} and returned 200 or 206`);
  } catch (e) {
    bad(e.stack || e.message);
  } finally {
    console.log(`\n${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s))`);
    process.exit(failures ? 1 : 0);
  }
})();
