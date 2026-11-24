/* Boot orchestration, SW control gate, snapshot streaming, and safe Restart.
 *
 * INV-1: NEVER sends anything to guest stdin. Fresh-boot MOTD and restore
 * notices are written locally to xterm.js display only (term.write).
 * INV-10: restartMachine() destroys V86 and re-instantiates from snapshot
 * cleanly instead of calling emulator.restart() into an unbootable SeaBIOS.
 */

import {
  clearLoading,
  hideProgress,
  noteObservedNetwork,
  setLoading,
  setStatus,
  showFatal,
  showProgress,
  showUpdateBanner,
} from "./status.js";
import { currentTerminal, fitSoon } from "./terminal.js";
import { attachKeyboardInterceptor } from "./keybar.js";
import { initChunkFallback } from "./chunk-fallback.js";
import { SafeFetchNetworkAdapter } from "./net-adapter.js";
import { handleBlockedPortHint, isNetDesiredEnabled, syncNetUI } from "./net-ui.js";

const FRESH_MOTD = [
  "",
  "  \x1b[1;32mGoLinux\x1b[0m \x1b[2m· Alpine Linux 3.21 (x86) · BusyBox + TinyCC · 128 MB WASM VM\x1b[0m",
  "  \x1b[36mTools:\x1b[0m tcc/gcc (instant C), python3, git, make, nano, vi, tmux, htop, jq, tree, man",
  "  \x1b[35mFun:\x1b[0m   fastfetch, cowsay, figlet, sl",
  "  \x1b[2mOffline by default · optional Net toggle (browser Fetch) · /root persists · /mnt/host transfer\x1b[0m",
  "",
].join("\r\n");

const swSupported = "serviceWorker" in navigator && !!navigator.serviceWorker;

function pushAssetBase() {
  if (!glIsLocalHost(location.hostname)) return;
  if (swSupported && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "set-asset-base",
      base: GL_ASSET_BASE,
    });
  }
}

function pushBandwidthPref() {
  if (!swSupported || !navigator.serviceWorker.controller) return;
  let mode = "auto";
  try {
    const saved = localStorage.getItem("golinux.bwMode");
    if (saved === "slow" || saved === "fast" || saved === "auto") mode = saved;
  } catch (_) {}
  navigator.serviceWorker.controller.postMessage({
    type: "set-bandwidth-mode",
    mode,
  });
}

function reportThroughputToSW(bps) {
  if (!(bps > 0) || !Number.isFinite(bps)) return;
  const threshold = typeof GL_SLOW_LINK_BPS === "number" ? GL_SLOW_LINK_BPS : (300 * 1024);
  noteObservedNetwork(bps, bps < threshold ? "slow" : "fast");
  if (swSupported && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "report-throughput",
      bps,
    });
  }
}

function waitForWorkerControl(timeoutMs) {
  if (!swSupported) return Promise.resolve(false);
  if (navigator.serviceWorker.controller) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) { settled = true; resolve(v); }
    };
    navigator.serviceWorker.addEventListener("controllerchange", () => done(true), { once: true });
    navigator.serviceWorker.ready.then(() => {
      if (navigator.serviceWorker.controller) done(true);
    }).catch(() => {});
    setTimeout(() => done(!!navigator.serviceWorker.controller), timeoutMs);
  });
}

let bootStarted = false;
let upgradeReloading = false;

export function isBootStarted() {
  return bootStarted;
}

/**
 * Perform at most one automatic reload per upgrade key in this tab session so
 * returning normal tabs cleanly transition onto a newly deployed Service Worker
 * without ever risking a reload loop.
 */
export function triggerUpgradeReload(reasonKey) {
  if (upgradeReloading) return true;
  const key = String(reasonKey || "upgrade");
  try {
    if (sessionStorage.getItem("gl_reloaded_for") === key) {
      return false;
    }
    sessionStorage.setItem("gl_reloaded_for", key);
  } catch (e) {
    // sessionStorage unavailable; fall back to banner instead of risking a loop.
    showUpdateBanner();
    return false;
  }
  upgradeReloading = true;
  setLoading("Updating GoLinux", "Loading the latest version…");
  setStatus("updating…");
  location.reload();
  return true;
}

function waitForWorkerActivation(reg, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) { settled = true; resolve(v); }
    };
    const onCtrl = () => done(true);
    navigator.serviceWorker.addEventListener("controllerchange", onCtrl, { once: true });
    const watch = (w) => {
      if (!w) return;
      if (w.state === "activated") { done(true); return; }
      w.addEventListener("statechange", () => {
        if (w.state === "activated" || w.state === "redundant") done(w.state === "activated");
      });
    };
    watch(reg.installing || reg.waiting);
    reg.addEventListener("updatefound", () => watch(reg.installing), { once: true });
    setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", onCtrl);
      done(false);
    }, timeoutMs);
  });
}

async function fetchLiveBuildId(timeoutMs) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch("images/build-id.json", {
      cache: "no-store",
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data && typeof data.buildId === "string" && data.buildId) ? data.buildId : null;
  } catch (e) {
    return null;
  } finally {
    if (t) clearTimeout(t);
  }
}

export async function prepareChunkAccess() {
  const remoteChunks = !!GL_ASSET_BASE;

  if (!swSupported) {
    if (remoteChunks) {
      showFatal(
        "This browser cannot run GoLinux here",
        "Disk data is served cross-origin and needs a service worker to forward " +
        "requests, but service workers are unavailable (disabled, or blocked in " +
        "private browsing)."
      );
      return false;
    }
    return true;
  }

  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    pushAssetBase();
    if (!hadController || window.__glUpgradeHandled) return;
    window.__glUpgradeHandled = true;
    if (!bootStarted) {
      triggerUpgradeReload("sw-ctrl-" + GL_VERSION + "-" + (GL_BUILD_ID || "dev"));
    } else {
      showUpdateBanner();
    }
  });

  let reg = null;
  try {
    // updateViaCache:"none" forces Safari/Chrome/Firefox to bypass HTTP cache
    // when checking sw.js and importScripts(packs-config.js) on every load.
    reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
  } catch (e) {
    console.warn("service worker registration failed:", e);
  }

  // If this normal tab already had an older SW controlling it, proactively
  // check for a newer deploy BEFORE booting the VM so we never boot split-brain
  // (old shell + old snapshot talking to a newly activated SW).
  if (hadController && reg && navigator.onLine !== false) {
    try {
      await Promise.race([
        reg.update().catch(() => {}),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
      if (upgradeReloading) return false;
      if (reg.installing || reg.waiting) {
        setLoading("Updating GoLinux", "Installing the latest version…");
        await waitForWorkerActivation(reg, 4500);
        if (upgradeReloading) return false;
      }
      // Safety net: if Safari still served a stale packs-config.js from cache
      // while the server has a newer build-id.json, reload cleanly once.
      if (GL_BUILD_ID) {
        const liveId = await fetchLiveBuildId(2000);
        if (liveId && liveId !== GL_BUILD_ID) {
          try { await reg.update(); } catch (e) {}
          if (triggerUpgradeReload("build-" + liveId)) return false;
        }
      }
    } catch (e) { /* offline or update check timed out; proceed with cached SW */ }
  }

  let slowNoticeTimer = null;
  if (!navigator.serviceWorker.controller) {
    slowNoticeTimer = setTimeout(() => {
      if (!upgradeReloading && !bootStarted) {
        setLoading("Preparing GoLinux", "Caching lightweight app shell (first visit only)…");
      }
    }, 2500);
  }
  const controlled = await waitForWorkerControl(25000);
  if (slowNoticeTimer) clearTimeout(slowNoticeTimer);
  if (upgradeReloading) return false;
  if (controlled) {
    pushAssetBase();
    pushBandwidthPref();
    await initChunkFallback();
    return true;
  }

  if (remoteChunks) {
    // Even if SW control timed out, try page-level direct bundle fallback!
    await initChunkFallback();
    showFatal(
      "Could not start",
      "The service worker did not take control of the page, and this build " +
      "loads its disk data from another origin. Reloading usually fixes it."
    );
    return false;
  }
  await initChunkFallback();
  return true;
}

async function snapshotIsCached() {
  for (const name of [GL_DATA_CACHE, GL_SHELL_CACHE]) {
    try {
      const c = await caches.open(name);
      if (await c.match(GL_SNAPSHOT_URL, { ignoreSearch: true })) return true;
    } catch (e) { /* Cache API unavailable */ }
  }
  return false;
}

async function snapshotAvailable(url) {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function fetchSnapshotWithProgress(url, onProgress) {
  const fetchStart = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error("snapshot fetch failed: " + res.status);

  const total = Number(res.headers.get("Content-Length")) || 0;
  if (!res.body || !res.body.getReader) {
    const buf = await res.arrayBuffer();
    const dt = Math.max(0.05, (performance.now() - fetchStart) / 1000);
    const bps = buf.byteLength / dt;
    onProgress(buf.byteLength, buf.byteLength, bps);
    return { buffer: buf, bps };
  }

  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  const samples = [{ t: fetchStart, bytes: 0 }];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    samples.push({ t: now, bytes: loaded });
    const cutoff = now - 2000;
    while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
    const first = samples[0];
    const dt = (now - first.t) / 1000;
    const displayBps = (dt >= 0.4 && loaded - first.bytes > 0)
      ? ((loaded - first.bytes) / dt)
      : 0;
    onProgress(loaded, total || loaded, displayBps);
  }

  const out = new Uint8Array(loaded);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  const totalMs = performance.now() - fetchStart;
  // Only report real network transfers (>= 300 ms); skip instant local cache reads.
  const finalBps = totalMs >= 300 ? (loaded / (totalMs / 1000)) : 0;
  return { buffer: out.buffer, bps: finalBps };
}

async function cacheSnapshotIfNoSW(buffer) {
  if (swSupported && navigator.serviceWorker.controller) return;
  try {
    const cache = await caches.open(GL_DATA_CACHE);
    await cache.put(GL_SNAPSHOT_URL, new Response(buffer, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buffer.byteLength),
      },
    }));
  } catch (e) {
    console.warn("could not cache snapshot:", e);
  }
}

function clearTerminalMount() {
  const container = document.getElementById("terminal");
  if (!container) return;
  for (const child of Array.from(container.children)) {
    if (child.id !== "diskToast" && child.id !== "netToast") child.remove();
  }
}

let ownershipClaimed = false;
let restarting = false;
let activeNetAdapter = null;

export function currentNetAdapter() {
  return activeNetAdapter;
}

export async function bootMachine() {
  bootStarted = true;
  window.__glBootStarted = true;
  const bootStart = performance.now();

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then((g) => { window.__persisted = g; }).catch(() => {});
  }

  if (!ownershipClaimed) {
    ownershipClaimed = true;
    await window.GoPersist.claimOwnership();
  }

  const forcedOff = new URLSearchParams(location.search).has("nosnapshot");

  // Always boot a fresh Alpine Linux instance from the shipped snapshot so a
  // previously running command (e.g. ping, sleep, infinite loop) never freezes
  // the terminal on reopen. Saved /root files are restored cleanly into 9p.
  let savedRoot = null;
  if (!forcedOff) {
    setLoading("Starting GoLinux", "Checking saved /root files…");
    setStatus("loading…");
    savedRoot = await window.GoPersist.loadUserState();
  }

  const haveSnapshot = !forcedOff && (await snapshotAvailable(GL_SNAPSHOT_URL));
  setStatus(haveSnapshot ? "restoring…" : "booting…");

  let initialState = null;
  window.__usedUserState = !!savedRoot;
  if (haveSnapshot) {
    const cached = await snapshotIsCached();
    if (!cached) {
      setLoading("Downloading the machine", "A lightweight ~9 MB snapshot the first time; cached afterwards.");
      showProgress(0, 0);
    } else {
      setLoading("Starting…", savedRoot ? "Starting fresh shell & restoring /root files." : "Restoring the shipped snapshot.");
    }

    try {
      const snap = await fetchSnapshotWithProgress(GL_SNAPSHOT_URL, (l, t, bps) => {
        if (!cached) showProgress(l, t, bps);
      });
      initialState = { buffer: snap.buffer };
      if (!cached) {
        reportThroughputToSW(snap.bps);
        await cacheSnapshotIfNoSW(snap.buffer);
      }
    } catch (e) {
      setStatus("snapshot failed: " + e.message);
    }
    hideProgress();
  }

  clearTerminalMount();

  const disk = {
    url: "/" + GL_CHUNK_PATH + "chunk.zst",
    async: true,
    use_parts: true,
    fixed_chunk_size: 128 * 1024,
    size: typeof GL_DISK_SIZE === "number" ? GL_DISK_SIZE : 1 * 1024 * 1024 * 1024,
  };

  const container = document.getElementById("terminal");
  const options = {
    wasm_path: "assets/v86/v86.wasm",
    bios: { url: "assets/bios/seabios.bin" },
    vga_bios: { url: "assets/bios/vgabios.bin" },
    hda: disk,
    filesystem: {},
    net_device: { type: "virtio" },
    preserve_mac_from_state_image: true,
    memory_size: GL_MEMORY_SIZE,
    autostart: true,
  };

  if (initialState) {
    // Snapshot boots with virtio-console (/dev/hvc0, TERM=xterm-256color) for
    // true out-of-band SIGWINCH resizing with zero stdin injection.
    options.initial_state = initialState;
    options.virtio_console = {
      type: "xtermjs",
      container,
      xterm_lib: window.Terminal,
    };
  } else {
    // Cold-boot fallback (?nosnapshot): serial_console on ttyS0.
    options.bzimage = { url: "images/debian-bzImage" };
    options.initrd = { url: "images/debian-initrd" };
    options.cmdline = "root=/dev/sda rootfstype=ext4 modules=sd-mod,ext4 rw console=ttyS0";
    options.serial_console = {
      type: "xtermjs",
      container,
      xterm_lib: window.Terminal,
    };
  }

  window.__usedSnapshot = !!initialState;
  const emu = new window.V86(options);
  window.emulator = emu;

  if (activeNetAdapter) {
    try { activeNetAdapter.destroy(); } catch (e) {}
    activeNetAdapter = null;
  }
  if (GL_FEATURES.network && emu.bus) {
    activeNetAdapter = new SafeFetchNetworkAdapter(emu.bus, {
      enabled: isNetDesiredEnabled(),
      onBlockedPort: handleBlockedPortHint,
      onStateChange: (on) => syncNetUI(on),
    });
    window.__netAdapter = activeNetAdapter;
    syncNetUI(activeNetAdapter.isEnabled());
  }

  try {
    window.Go9p.install(emu);
  } catch (e) {
    console.warn("9p state wrapper not installed:", e.message);
  }

  emu.add_listener("emulator-loaded", () => {
    setStatus("running");
    window.__bootMs = Math.round(performance.now() - bootStart);
    clearLoading();

    // Restore saved /root files into 9p BEFORE attaching mutation watchers
    // so restored files do not spuriously re-trigger an autosave.
    let restoredCount = 0;
    if (savedRoot) {
      try {
        restoredCount = window.GoPersist.restoreRootFiles(emu, savedRoot);
      } catch (e) {
        console.warn("failed to restore saved /root files:", e);
      }
    }

    // Hook unified keybar + native keyboard modifier pipeline.
    attachKeyboardInterceptor(emu);

    // Attach instant /root fs9p mutation watcher & unload handoff.
    window.GoPersist.attach(emu);

    // Display local banner ONLY via xterm.write (zero bytes sent to guest!).
    const term = currentTerminal();
    if (term && initialState) {
      const restoreNote = savedRoot
        ? `  \x1b[32m[saved /root restored · ${restoredCount} file${restoredCount === 1 ? "" : "s"}]\x1b[0m\r\n`
        : "";
      term.write(FRESH_MOTD + restoreNote + "\r\n\x1b[1;32mroot@golinux\x1b[0m:\x1b[1;34m~\x1b[0m# ");
    }

    // Resize xterm.js and send out-of-band virtio-console0-resize (zero stdin).
    fitSoon({ nudgeRedraw: false });

    // Signal idle pre-warmer that the VM is live.
    try { window.dispatchEvent(new CustomEvent("gl-emulator-ready")); } catch (_) {}
  });

  emu.add_listener("emulator-started", () => setStatus("running"));
  emu.add_listener("emulator-stopped", () => setStatus("stopped"));
  emu.add_listener("download-error", (e) => {
    setStatus("download failed: " + (e && e.file_name ? e.file_name : "asset"));
  });

  return emu;
}

/**
 * Safe restart: flushes any unsaved /root files, cleanly destroys the running
 * V86 instance, and boots a fresh Alpine Linux instance from the shipped
 * snapshot with /root files intact (never calls emulator.restart() into SeaBIOS).
 */
export async function restartMachine() {
  if (restarting) return;
  restarting = true;
  const btn = document.getElementById("restart");
  if (btn) btn.disabled = true;
  try {
    if (window.emulator && window.GoPersist && window.GoPersist.getOwner && window.GoPersist.getOwner()) {
      const needSave = (window.GoPersist.isDirty && window.GoPersist.isDirty()) ||
                       (window.GoPersist.isSaveInFlight && window.GoPersist.isSaveInFlight());
      if (needSave) {
        setStatus("saving…");
        await Promise.race([
          window.GoPersist.saveNow(window.emulator, "restart").catch(() => false),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      }
    }
    setStatus("restarting…");
    if (activeNetAdapter) {
      try { activeNetAdapter.destroy(); } catch (e) {}
      activeNetAdapter = null;
      window.__netAdapter = null;
    }
    if (window.emulator) {
      try {
        await window.emulator.destroy();
      } catch (e) {
        try { window.emulator.stop(); } catch (_) {}
      }
      window.emulator = null;
    }
    await bootMachine();
  } finally {
    restarting = false;
    if (btn) btn.disabled = false;
  }
}
