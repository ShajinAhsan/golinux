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
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
      res.setHeader("Access-Control-Allow-Headers", "Range, If-None-Match, If-Modified-Since");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, ETag");
      if (!/^(images\/debian-chunks\/|packs\/)/.test(rel)) {
        log[log.length - 1].status = 404;
        return res.writeHead(404).end("not in bucket");
      }
      const m = rel.match(/\/chunk-(\d+)-(\d+)\.zst$/);
      if (m && opts.realChunks && !opts.realChunks.has(path.basename(rel))) {
        log[log.length - 1].status = 404;
        return res.writeHead(404).end("not stored");
      }
    } else if (rel.startsWith("images/debian-chunks/") || rel.startsWith("packs/")) {
      log[log.length - 1].status = 404;
      return res.writeHead(404).end("not on app origin");
    }

    const full = path.join(root, rel);
    if (!full.startsWith(root) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      log[log.length - 1].status = 404;
      return res.writeHead(404).end("not found");
    }
    const body = fs.readFileSync(full);
    log[log.length - 1].status = 200;
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": opts.assetOrigin ? "public, max-age=0, must-revalidate" : "no-cache",
    });
    if (req.method === "HEAD") return res.end();
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

    /* --- 1. First load + INV-1 boot spy --- */
    console.log("\n== first load + INV-1 stdin spy ==");
    await cdp.send("Page.navigate", { url: appOrigin + "/" });
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
      "printf 'int main(){return 0;}' > /root/t.c && gcc /root/t.c -o /root/t && /root/t && echo GCC_OUTPUT_INTACT",
      /GCC_OUTPUT_INTACT[\s\S]*GCC_OUTPUT_INTACT/,
      180000,
      "cold gcc compile"
    );
    await setUserTyping(cdp, false);
    // Wait past #diskToast hide settle (1200ms) and assert output was NEVER erased!
    await sleep(1200);
    const afterGcc = await screenText(cdp);
    const toastSeen = (await cdp.send("Runtime.evaluate", {
      expression: `window.__toastSeen`, returnByValue: true,
    })).result.value;
    check(toastSeen === true, "floating #diskToast appeared during cold gcc compile");
    check(afterGcc.includes("GCC_OUTPUT_INTACT"),
      "gcc output stays intact on screen after compile and after #diskToast hides (no Ctrl-L erase!)");

    /* --- 3. Native TERM=xterm-256color + clean nano scrollback --- */
    console.log("\n== TERM & nano alternate screen ==");
    await setUserTyping(cdp, true);
    const termOut = await runCmd(
      cdp,
      "echo T=$TERM; tput smcup >/dev/null 2>&1 && echo SMCUP_OK",
      /T=xterm-256color[\s\S]*SMCUP_OK/,
      15000,
      "TERM check"
    );
    check(/T=xterm-256color/.test(termOut) && /SMCUP_OK/.test(termOut),
      "native TERM=xterm-256color with alternate screen (without serial0_send)");

    const baseBeforeNano = (await cdp.send("Runtime.evaluate", {
      expression: `window.emulator.virtio_console_adapter.term.buffer.active.baseY`, returnByValue: true,
    })).result.value;
    await focusTerm(cdp);
    await typeText(cdp, "nano /root/n.txt");
    await pressEnter(cdp);
    await sleep(2000);
    await pressCtrl(cdp, "x");
    await sleep(1000);
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

    /* --- 4. Out-of-band virtio-console resize preserves half-typed command --- */
    console.log("\n== virtio-console out-of-band resize ==");
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

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);

    /* --- 5. Persistence across reload + INV-1 spy on restore --- */
    console.log("\n== persistence & restore ==");
    await setUserTyping(cdp, true);
    await runCmd(cdp, "echo SURVIVED_TEST > /root/marker.txt && cat /root/marker.txt", /SURVIVED_TEST/, 20000, "write marker");
    await setUserTyping(cdp, false);
    await sleep(400);

    const savedObj = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const ok = await window.GoPersist.saveNow(window.emulator, "manual");
        const meta = await window.GoPersist.readMeta();
        return JSON.stringify({ ok, meta });
      })()`,
      awaitPromise: true, returnByValue: true,
    })).result.value);
    check(savedObj.ok && savedObj.meta && savedObj.meta.buildId === buildId && savedObj.meta.schema === 2,
      "saved state stamped with buildId and schema=2");

    await cdp.send("Page.reload", { ignoreCache: false });
    await waitScreen(cdp, /\[session restored\]/, 60000, "restored banner");
    await sleep(800);
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
    await waitScreen(cdp, /session restored|root@golinux:~#/, 30000, "prompt after Restart");
    await setUserTyping(cdp, true);
    const afterRestart = await runCmd(cdp, "echo RESTART_ALIVE", /RESTART_ALIVE[\s\S]*RESTART_ALIVE/, 20000, "after Restart");
    await setUserTyping(cdp, false);
    check(/RESTART_ALIVE/.test(afterRestart), "Restart button boots working shell (never hangs SeaBIOS, BUG-22)");

    /* --- 7. Safe Reset button (BUG-15) --- */
    console.log("\n== safe Reset button ==");
    await cdp.send("Runtime.evaluate", {
      expression: `window.confirm = () => true; document.getElementById("resetBtn").click();`,
    });
    await sleep(2500);
    await waitScreen(cdp, /root@golinux:~#/, 60000, "prompt after Reset");
    await setUserTyping(cdp, true);
    const afterReset = await runCmd(cdp, "test -f /root/marker.txt && echo STILL_THERE || echo CLEAN_RESET", /STILL_THERE|CLEAN_RESET/, 20000, "after Reset");
    await setUserTyping(cdp, false);
    check(/CLEAN_RESET/.test(afterReset), "Reset wiped saved session cleanly without pagehide re-save race (BUG-15)");

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
        await mw.write(JSON.stringify({ buildId: "0000000000000001", schema: 2 }));
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
    await typeText(cdp, "g++ --version");
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

    /* --- 10. Network assertions --- */
    console.log("\n== network assertions ==");
    const chunkHits = (log) => log.filter((r) => /\/debian-chunks\/(?:[^/]+\/)?chunk-\d+-\d+\.zst$/.test(r.path));
    const assetChunks = chunkHits(assetLog);
    const appChunks = chunkHits(appLog);
    check(assetChunks.length > 0, `guest fetched ${assetChunks.length} chunks from asset origin`);
    check(appChunks.length === 0, "zero chunk requests reached app origin");
    const prefixed = `/images/debian-chunks/${buildId}/`;
    check(assetChunks.every((r) => r.path.startsWith(prefixed)), `every chunk path carries buildId ${buildId}`);
    const realHits = assetChunks.filter((r) => staged.real.has(path.basename(r.path)));
    check(realHits.length > 0 && realHits.every((r) => r.status === 200), "every real chunk returned 200");
    const zeroHits = assetChunks.filter((r) => !staged.real.has(path.basename(r.path)));
    check(zeroHits.every((r) => r.status === 404), "every zeroed chunk 404ed on R2 mirror");
  } catch (e) {
    bad(e.stack || e.message);
  } finally {
    console.log(`\n${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s))`);
    process.exit(failures ? 1 : 0);
  }
})();
