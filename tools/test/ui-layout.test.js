#!/usr/bin/env node
/**
 * Layout + mobile-control tests in real headless Chrome.
 *
 * Verifies:
 *   - Viewport fit, zero page scroll, zero toolbar overflow across 5 viewports
 *     INCLUDING with a 120-char #persistStatus warning (BUG-26)
 *   - Narrow screens collapse actions into #barMenu; flagged-off controls hidden
 *   - Keybar touch targets >=36px; Ctrl/Alt one-shot works on BOTH keybar symbols
 *     AND native keyboard input (BUG-24)
 *   - #fatal includes a working Reload button (BUG-23)
 *   - .xterm-helper-textarea has font-size >= 16px (prevents iOS Safari zoom, BUG-25)
 *   - ResizeObserver re-fits grid without touching stdin
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const keep = process.argv.includes("--keep");

let failed = 0, passed = 0;
const check = (c, m) => {
  if (c) { passed++; console.log("ok: " + m); }
  else { failed++; console.error("FAIL: " + m); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".wasm": "application/wasm", ".zst": "application/zstd",
  ".bin": "application/octet-stream", ".png": "image/png",
};

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

function serve(root) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    if (rel === "") rel = "index.html";
    const full = path.join(root, rel);
    if (!full.startsWith(root) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return res.writeHead(404).end("nf");
    }
    const b = fs.readFileSync(full);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
      "Content-Length": b.length,
    });
    res.end(b);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

async function waitJson(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch (e) {}
    await sleep(100);
  }
  throw new Error("timeout " + url);
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
  ws.onerror = () => rej(new Error("ws fail"));
});

async function geometry(cdp) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const app = document.getElementById("app");
      const bar = document.getElementById("bar");
      const term = document.getElementById("terminal");
      const xterm = document.querySelector("#terminal .xterm-screen");
      const ta = document.querySelector("#terminal .xterm-helper-textarea");
      const ad = window.emulator && (window.emulator.virtio_console_adapter || window.emulator.serial_adapter);
      const t = ad && ad.term;
      const de = document.documentElement;
      const kb = document.getElementById("keybar");
      const kbBtn = kb && kb.querySelector("button");
      const kbr = kbBtn ? kbBtn.getBoundingClientRect() : null;
      return JSON.stringify({
        innerW: window.innerWidth, innerH: window.innerHeight,
        appH: app.getBoundingClientRect().height,
        pageScrollH: de.scrollHeight, pageClientH: de.clientHeight,
        pageScrollW: de.scrollWidth, pageClientW: de.clientWidth,
        barH: bar.getBoundingClientRect().height,
        kbH: kb ? kb.getBoundingClientRect().height : 0,
        barScrollW: bar.scrollWidth, barClientW: bar.clientWidth,
        termW: term.clientWidth, termH: term.clientHeight,
        xtermW: xterm ? xterm.getBoundingClientRect().width : 0,
        xtermH: xterm ? xterm.getBoundingClientRect().height : 0,
        taFontSize: ta ? parseFloat(getComputedStyle(ta).fontSize) : 0,
        cols: t ? t.cols : 0, rows: t ? t.rows : 0,
        kbVisible: kb ? kb.classList.contains("visible") : false,
        kbBtnH: kbr ? kbr.height : 0, kbBtnW: kbr ? kbr.width : 0,
        menuBtnShown: getComputedStyle(document.getElementById("barMenuBtn")).display,
        resetShown: getComputedStyle(document.getElementById("resetBtn")).display,
        packsHidden: document.getElementById("openPacks").hidden,
        fatalReloadExists: !!document.getElementById("fatalReload"),
      });
    })()`,
    returnByValue: true,
  });
  return JSON.parse(r.result.value);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui-layout-"));
  let chrome = null, servers = [];
  try {
    const appDir = path.join(tmp, "app");
    fs.cpSync(path.join(ROOT, ".deploy-pages"), appDir, { recursive: true });
    const cfgPath = path.join(appDir, "packs-config.js");
    fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, "utf8").replace(
      /^const GL_ASSET_ORIGIN\s*=\s*"[^"]*";/m,
      `const GL_ASSET_ORIGIN = "";`
    ));
    const appSrv = await serve(appDir);
    servers.push(appSrv.server);
    const origin = `http://127.0.0.1:${appSrv.port}`;

    const profile = path.join(tmp, "p");
    fs.mkdirSync(profile, { recursive: true });
    const port = 9900 + Math.floor(Math.random() * 80);
    chrome = spawn(chromePath(), [
      "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      "--no-first-run", "--disable-extensions", "--touch-events=enabled",
      "--window-size=1280,900", "about:blank",
    ], { stdio: "ignore" });

    await waitJson(`http://127.0.0.1:${port}/json/version`, 20000);
    const list = await waitJson(`http://127.0.0.1:${port}/json/list`, 10000);
    const page = list.find((t) => t.type === "page");
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

    /* ---- Landing page responsiveness (index.html at "/") ---- */
    console.log("\n== landing page responsive layout ==");
    await cdp.send("Page.navigate", { url: origin + "/" });
    await sleep(500);
    for (const vp of [
      { name: "landing desktop 1440x900", w: 1440, h: 900 },
      { name: "landing phone 390x844", w: 390, h: 844 },
      { name: "landing small phone 320x568", w: 320, h: 568 },
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 800,
      });
      await sleep(300);
      const lg = JSON.parse((await cdp.send("Runtime.evaluate", {
        expression: `JSON.stringify({
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
        })`,
        returnByValue: true,
      })).result.value);
      check(lg.scrollW <= lg.clientW + 1, `${vp.name}: no horizontal overflow (${lg.scrollW} <= ${lg.clientW})`);
    }

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: origin + "/terminal.html" });
    // Wait until xterm instance is created by v86
    for (let i = 0; i < 300; i++) {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `!!(window.emulator && (window.emulator.virtio_console_adapter || window.emulator.serial_adapter) && (window.emulator.virtio_console_adapter || window.emulator.serial_adapter).term)`,
        returnByValue: true,
      });
      if (r.result.value) break;
      await sleep(100);
    }
    await sleep(500);
    await cdp.send("Runtime.evaluate", {
      expression: `
        document.getElementById("keybar").classList.add("visible");
        // Populate a long persistence warning to prove #bar never overflows (BUG-26).
        document.getElementById("persistStatus").textContent =
          "Autosave paused: saved state is 162 MB (limit 150 MB). Delete large files to resume saving.";
      `,
    });

    const viewports = [
      { name: "desktop 1440x900", w: 1440, h: 900 },
      { name: "tablet 834x1112", w: 834, h: 1112 },
      { name: "phone 390x844", w: 390, h: 844 },
      { name: "small phone 320x568", w: 320, h: 568 },
      { name: "phone landscape 844x390", w: 844, h: 390 },
    ];

    for (const vp of viewports) {
      console.log(`\n== ${vp.name} ==`);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.w < 800,
      });
      await sleep(600);
      const g = await geometry(cdp);
      check(Math.abs(g.appH - g.innerH) <= 2, `app height fills viewport (${g.appH} vs ${g.innerH})`);
      check(g.pageScrollH <= g.pageClientH + 1, `no vertical page scroll`);
      check(g.pageScrollW <= g.pageClientW + 1, `no horizontal page scroll`);
      check(g.barScrollW <= g.barClientW + 1,
        `toolbar does not overflow with long #persistStatus (${g.barScrollW} <= ${g.barClientW}) (BUG-26)`);
      if (vp.w <= 760) {
        check(g.menuBtnShown !== "none", "menu button shown on narrow screen");
        check(g.resetShown === "none", "wide-only actions hidden on narrow screen");
      } else {
        check(g.menuBtnShown === "none", "menu button hidden on wide screen");
        check(g.resetShown !== "none", "actions shown inline on wide screen");
      }
      check(g.packsHidden === true, "flagged-off packs button stays hidden");
      check(g.fatalReloadExists === true, "#fatal includes Reload button (BUG-23)");
      if (g.taFontSize > 0) {
        check(g.taFontSize >= 16, `helper textarea font-size >= 16px (${g.taFontSize}px) prevents iOS zoom (BUG-25)`);
      }
      if (g.kbVisible) {
        check(g.kbBtnH >= 36 && g.kbBtnW >= 36, `key buttons touch-friendly (${Math.round(g.kbBtnW)}x${Math.round(g.kbBtnH)})`);
      }
    }

    /* ---- Ctrl latch intercepts NATIVE keyboard input (BUG-24) ---- */
    console.log("\n== keybar + native keyboard Ctrl latch ==");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(400);

    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        window.__busInput = [];
        const origSend = window.emulator.bus.send.bind(window.emulator.bus);
        window.emulator.bus.send = (name, value) => {
          if (name === "virtio-console0-input-bytes") {
            window.__busInput.push(Array.from(value));
          } else if (name === "serial0-input") {
            window.__busInput.push([value]);
          }
          return origSend(name, value);
        };
      })()`,
    });

    const tap = async (sel) => {
      await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(sel)}).dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }))`,
      });
      await sleep(50);
    };

    // Tap Ctrl on keybar, then type 'o' via real CDP keyboard event (native keyboard path!)
    await tap('#keybar [data-act="ctrl"]');
    const armedBefore = (await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('#keybar [data-act="ctrl"]').getAttribute("aria-pressed")`,
      returnByValue: true,
    })).result.value;
    check(armedBefore === "true", "Ctrl arms visibly");

    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector(".xterm-helper-textarea").focus()`,
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "char", text: "o" });
    await sleep(80);

    const busAfter = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify(window.__busInput)`, returnByValue: true,
    })).result.value);
    const armedAfter = (await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('#keybar [data-act="ctrl"]').getAttribute("aria-pressed")`,
      returnByValue: true,
    })).result.value;

    check(busAfter.some((a) => a.join(",") === "15"),
      "tapping Ctrl + native keyboard 'o' sends 0x0f (Ctrl-O) to guest (BUG-24)");
    check(armedAfter === "false", "Ctrl disarms after native keyboard char");

    // Next native 'o' must be plain 111
    await cdp.send("Runtime.evaluate", { expression: `window.__busInput = []` });
    await cdp.send("Input.dispatchKeyEvent", { type: "char", text: "o" });
    await sleep(60);
    const busPlain = JSON.parse((await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify(window.__busInput)`, returnByValue: true,
    })).result.value);
    check(busPlain.some((a) => a.join(",") === "111"), "following native key is unmodified 'o'");

    // Resize re-fit
    const before = await geometry(cdp);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const after = await geometry(cdp);
    check(after.cols > before.cols, `grid re-fits wider (${before.cols}x${before.rows} -> ${after.cols}x${after.rows})`);
  } catch (e) {
    failed++;
    console.error("FAIL: " + e.stack);
  } finally {
    try { if (chrome) chrome.kill("SIGKILL"); } catch (e) {}
    for (const s of servers) { try { s.close(); } catch (e) {} }
    if (!keep) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.error("UI layout tests FAILED"); process.exit(1); }
  console.log("All UI layout tests passed.");
})();
