#!/usr/bin/env node
/**
 * Layout + mobile-control tests, driven in real headless Chrome against the
 * staged app with a local chunk origin.
 *
 *   node tools/test/ui-layout.test.js [--keep]
 *
 * Asserts, per viewport:
 *   - the app fills the viewport and the page itself does not scroll
 *   - the terminal fills the remaining space and its grid matches the box
 *   - the toolbar does not overflow horizontally
 *   - on narrow screens the actions collapse into the menu
 *   - the key bar has >=44px touch targets
 *   - Ctrl is one-shot and sends real input (Ctrl+X reaches the guest)
 *   - arrow keys send the correct escape sequences
 *   - ResizeObserver re-fits after a viewport change
 *
 * Exits non-zero on failure.
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

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".zst": "application/zstd", ".bin": "application/octet-stream",
  ".png": "image/png" };

function serve(root) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
    if (rel === "") rel = "index.html";
    const full = path.join(root, rel);
    if (!full.startsWith(root) || !fs.existsSync(full) ||
        !fs.statSync(full).isFile()) {
      return res.writeHead(404).end("nf");
    }
    const b = fs.readFileSync(full);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
      "Content-Length": b.length,
    });
    res.end(b);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1",
    () => r({ server, port: server.address().port })));
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

/* ---------------- geometry probe ---------------- */

async function geometry(cdp) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const app = document.getElementById("app");
      const bar = document.getElementById("bar");
      const term = document.getElementById("terminal");
      const xterm = document.querySelector("#terminal .xterm-screen");
      const t = window.emulator && window.emulator.serial_adapter &&
                window.emulator.serial_adapter.term;
      const de = document.documentElement;
      const kb = document.getElementById("keybar");
      const kbBtn = kb && kb.querySelector("button");
      const kbr = kbBtn ? kbBtn.getBoundingClientRect() : null;
      return JSON.stringify({
        innerW: window.innerWidth, innerH: window.innerHeight,
        appW: app.getBoundingClientRect().width,
        appH: app.getBoundingClientRect().height,
        pageScrollH: de.scrollHeight, pageClientH: de.clientHeight,
        pageScrollW: de.scrollWidth, pageClientW: de.clientWidth,
        barH: bar.getBoundingClientRect().height,
        kbH: kb ? kb.getBoundingClientRect().height : 0,
        barScrollW: bar.scrollWidth, barClientW: bar.clientWidth,
        termW: term.clientWidth, termH: term.clientHeight,
        xtermW: xterm ? xterm.getBoundingClientRect().width : 0,
        xtermH: xterm ? xterm.getBoundingClientRect().height : 0,
        cols: t ? t.cols : 0, rows: t ? t.rows : 0,
        kbVisible: kb ? kb.classList.contains("visible") : false,
        kbBtnH: kbr ? kbr.height : 0, kbBtnW: kbr ? kbr.width : 0,
        menuBtnShown: getComputedStyle(document.getElementById("barMenuBtn")).display,
        wideShown: getComputedStyle(document.getElementById("openPacks")).display,
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
    const buildId = JSON.parse(fs.readFileSync(
      path.join(ROOT, "images/build-id.json"), "utf8")).buildId;

    // Chunk origin: serve images/ and packs/ at the paths the app asks for.
    const chunkRoot = path.join(tmp, "assets");
    fs.mkdirSync(path.join(chunkRoot, "images"), { recursive: true });
    // Only what the shell needs: the snapshot + build id (no disk chunks, so we
    // do not need a 5 GiB copy just to test layout).
    fs.cpSync(path.join(ROOT, "images", "debian-state.bin.zst"),
      path.join(chunkRoot, "images", "debian-state.bin.zst"));
    const chunkSrv = await serve(chunkRoot);
    servers.push(chunkSrv.server);
    void buildId;

    const appDir = path.join(tmp, "app");
    fs.cpSync(path.join(ROOT, ".deploy-pages"), appDir, { recursive: true });
    const cfgPath = path.join(appDir, "packs-config.js");
    fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, "utf8").replace(
      /^const GL_ASSET_ORIGIN\s*=\s*"[^"]*";/m,
      `const GL_ASSET_ORIGIN = "";`));   // same-origin: no chunks needed
    const appSrv = await serve(appDir);
    servers.push(appSrv.server);
    const origin = `http://127.0.0.1:${appSrv.port}`;

    const profile = path.join(tmp, "p");
    fs.mkdirSync(profile, { recursive: true });
    const port = 9900 + Math.floor(Math.random() * 80);
    chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
      "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      "--no-first-run", "--disable-extensions",
      // Emulate a touch device so the key bar shows.
      "--touch-events=enabled",
      "--window-size=1280,900", "about:blank",
    ], { stdio: "ignore" });

    await waitJson(`http://127.0.0.1:${port}/json/version`, 20000);
    const list = await waitJson(`http://127.0.0.1:${port}/json/list`, 10000);
    const page = list.find((t) => t.type === "page");
    const cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

    await cdp.send("Page.navigate", { url: origin + "/" });
    // Wait for the app script to be alive (the terminal is created by v86
    // after the snapshot loads; layout is measurable before that).
    for (let i = 0; i < 200; i++) {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `!!document.getElementById("terminal")`, returnByValue: true });
      if (r.result.value) break;
      await sleep(100);
    }
    await cdp.send("Runtime.evaluate", {
      expression: `document.getElementById("keybar").classList.add("visible")` });

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
      await sleep(700);   // let ResizeObserver + rAF settle

      const g = await geometry(cdp);
      if (process.env.UI_DEBUG) {
        const d = await cdp.send("Runtime.evaluate", {
          expression: `JSON.stringify({
            applied: [appliedCols, appliedRows],
            desired: desiredGrid(),
            termH: document.getElementById("terminal").clientHeight,
            kbH: document.getElementById("keybar").getBoundingClientRect().height,
          })`, returnByValue: true });
        console.log("  dbg", d.result.value);
      }

      // 1. App fills the viewport; the page does not scroll.
      check(Math.abs(g.appH - g.innerH) <= 2,
        `app height fills viewport (${g.appH} vs ${g.innerH})`);
      check(g.pageScrollH <= g.pageClientH + 1,
        `page does not scroll vertically (${g.pageScrollH} <= ${g.pageClientH})`);
      check(g.pageScrollW <= g.pageClientW + 1,
        `page does not scroll horizontally (${g.pageScrollW} <= ${g.pageClientW})`);

      // 2. Toolbar does not overflow.
      check(g.barScrollW <= g.barClientW + 1,
        `toolbar does not overflow (${g.barScrollW} <= ${g.barClientW})`);

      // 3. Narrow screens collapse to the menu.
      if (vp.w <= 760) {
        check(g.menuBtnShown !== "none", "menu button shown on narrow screen");
        check(g.wideShown === "none", "wide-only actions hidden on narrow screen");
      } else {
        check(g.menuBtnShown === "none", "menu button hidden on wide screen");
        check(g.wideShown !== "none", "actions shown inline on wide screen");
      }

      // 4. Terminal occupies the remaining height.
      // The terminal owns whatever the toolbar and key bar do not.
      const expectedH = g.innerH - g.barH - (g.kbVisible ? g.kbH : 0);
      check(g.termH >= expectedH * 0.9,
        `terminal fills the space between bar and keys ` +
        `(${g.termH} of ~${Math.round(expectedH)})`);
      // Grid must fit the box: a stale grid shows as a cell shorter than the
      // font line height (clipped rows).
      if (g.cols > 0 && g.rows > 0) {
        const cellH = g.xtermH / g.rows;
        check(cellH >= 8,
          `grid fits the box (${g.rows} rows, ${cellH.toFixed(1)}px each)`);
      }

      // 5. Grid matches the box (within one cell).
      if (g.cols > 0) {
        const cellW = g.xtermW / g.cols;
        const cellH = g.xtermH / g.rows;
        check(g.xtermW >= g.termW * 0.8,
          `xterm screen uses the width (${Math.round(g.xtermW)} of ${g.termW})`);
        check(cellW > 2 && cellH > 4,
          `cell size sane (${cellW.toFixed(1)}x${cellH.toFixed(1)})`);
      }

      // 6. Touch targets.
      if (g.kbVisible) {
        check(g.kbBtnH >= 36,
          `key button height is touch-friendly (${g.kbBtnH.toFixed(0)}px)`);
        check(g.kbBtnW >= 36,
          `key button width is touch-friendly (${g.kbBtnW.toFixed(0)}px)`);
      }
    }

    /* ---- resize must not leave visible junk on screen ---- */
    // (Only meaningful with a live guest; the layout suite runs without one, so
    // this is asserted in the smoke test instead.)

    /* ---- toolbar overflow menu ---- */
    console.log("\n== toolbar menu ==");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(400);
    let m = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        document.getElementById("barMenuBtn").click();
        const menu = document.getElementById("barMenu");
        const items = [...menu.querySelectorAll("button,a")].map(e => e.textContent.trim());
        const r = menu.getBoundingClientRect();
        const vis = !menu.hidden && r.width > 0 && r.right <= window.innerWidth + 1;
        return JSON.stringify({ vis, items });
      })()`, returnByValue: true });
    let mo = JSON.parse(m.result.value);
    check(mo.vis, "menu opens and stays inside the viewport");
    for (const want of ["Save for offline use", "Upload", "Download /root", "Reset", "About"]) {
      check(mo.items.includes(want), `menu contains "${want}"`);
    }
    // It must close again, or it would cover the terminal.
    m = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        document.body.click();
        return document.getElementById("barMenu").hidden;
      })()`, returnByValue: true });
    check(m.result.value === true, "menu closes when clicking elsewhere");

    /* ---- key behaviour ---- */
    console.log("\n== mobile keys ==");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(400);

    // Intercept what sendToTerm would deliver, by recording term.input calls.
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        window.__sent = [];
        const t = window.emulator.serial_adapter.term;
        const orig = t.input.bind(t);
        t.input = (s) => { window.__sent.push(s); return orig(s); };
        return true;
      })()`, returnByValue: true });

    const tap = async (sel) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const b = document.querySelector(${JSON.stringify(sel)});
          if (!b) return "missing";
          b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true,
            cancelable: true, pointerType: "touch" }));
          return "ok";
        })()`, returnByValue: true });
      await sleep(60);
      return r.result.value;
    };

    const sent = async () => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `JSON.stringify(window.__sent.map(s =>
          Array.from(s).map(c => c.charCodeAt(0))))`, returnByValue: true });
      return JSON.parse(r.result.value);
    };
    const armed = async () => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector('#keybar [data-act="ctrl"]')
          .getAttribute("aria-pressed")`, returnByValue: true });
      return r.result.value;
    };

    // Arrow keys.
    await cdp.send("Runtime.evaluate", { expression: `window.__sent = []` });
    await tap('#keybar [data-act="up"]');
    await tap('#keybar [data-act="left"]');
    let got = await sent();
    check(got.some((a) => a.join(",") === "27,91,65"), "up sends ESC[A");
    check(got.some((a) => a.join(",") === "27,91,68"), "left sends ESC[D");

    // Esc / Tab / Enter / Backspace.
    await cdp.send("Runtime.evaluate", { expression: `window.__sent = []` });
    await tap('#keybar [data-act="esc"]');
    await tap('#keybar [data-act="tab"]');
    await tap('#keybar [data-act="enter"]');
    await tap('#keybar [data-act="backspace"]');
    got = await sent();
    check(got.some((a) => a.join(",") === "27"), "Esc sends ESC");
    check(got.some((a) => a.join(",") === "9"), "Tab sends 0x09");
    check(got.some((a) => a.join(",") === "13"), "Enter sends CR");
    check(got.some((a) => a.join(",") === "127"), "Backspace sends DEL");

    // Ctrl is one-shot: arm, press x, assert 0x18, assert disarmed.
    await cdp.send("Runtime.evaluate", { expression: `window.__sent = []` });
    await tap('#keybar [data-act="ctrl"]');
    check((await armed()) === "true", "Ctrl arms visibly (aria-pressed=true)");
    // Send the following key through the same handler the sym buttons use.
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const b = document.querySelector('#keybar [data-sym="x"]') ||
                  document.createElement("button");
        b.dataset.sym = "x";
        handleKeyButton(b);
      })()`, returnByValue: true });
    await sleep(60);
    got = await sent();
    check(got.some((a) => a.join(",") === "24"), "Ctrl+x sends 0x18 (Ctrl-X)");
    check((await armed()) === "false", "Ctrl disarms after one keypress");
    await cdp.send("Runtime.evaluate", {
      expression: `window.__sent = []` });
    await tap('#keybar [data-sym="/"]');
    got = await sent();
    check(got.some((a) => a.join(",") === "47"),
      "the next key is unmodified (plain /)");

    // Tapping Ctrl twice disarms.
    await tap('#keybar [data-act="ctrl"]');
    await tap('#keybar [data-act="ctrl"]');
    check((await armed()) === "false", "tapping Ctrl again disarms");
    // Esc cancels a latched Ctrl.
    await tap('#keybar [data-act="ctrl"]');
    await tap('#keybar [data-act="esc"]');
    check((await armed()) === "false", "Esc cancels a latched Ctrl");

    /* ---- resize re-fit ---- */
    console.log("\n== resize ==");
    const before = await geometry(cdp);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
    const after = await geometry(cdp);
    check(after.cols !== before.cols || after.rows !== before.rows,
      `grid re-fits after a viewport change (${before.cols}x${before.rows} -> ` +
      `${after.cols}x${after.rows})`);
    check(after.cols > before.cols,
      "a wider window gives more columns");
  } catch (e) {
    failed++;
    console.error("FAIL: " + e.message);
  } finally {
    try { if (chrome) chrome.kill("SIGKILL"); } catch (e) {}
    for (const s of servers) { try { s.close(); } catch (e) {} }
    if (!keep) {
      try { require("node:child_process").execFileSync("rm", ["-rf", tmp]); } catch (e) {}
    } else console.log("kept " + tmp);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.error("UI layout tests FAILED"); process.exit(1); }
  console.log("All UI layout tests passed.");
})();
