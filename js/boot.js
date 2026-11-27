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
import { handleBlockedPortHint, isNetDesiredEnabled, syncNetUI } from "./net-ui.js";

function buildFreshMotd() {
  const netBit = (typeof GL_FEATURES !== "undefined" && GL_FEATURES.network)
    ? "Offline by default · optional Net toggle · "
    : "Offline sandbox · ";
  const isTouch = (typeof window !== "undefined") &&
    ((window.matchMedia && window.matchMedia("(pointer: coarse)").matches) || ("ontouchstart" in window));
  const transferHint = isTouch
    ? "Upload/Download in menu · Copy/Paste in ⋯ keybar"
    : "drag & drop files straight into ~ · Ctrl+K palette";
  return [
    "",
    "  \x1b[1;32mGoLinux\x1b[0m \x1b[2m· Alpine Linux 3.21 (x86) · BusyBox + TinyCC · 128 MB WASM VM\x1b[0m",
    "  \x1b[36mTools:\x1b[0m tcc/gcc (instant C), python3, git, make, nano, vi, tmux, htop, jq, tree, man, clip",
    "  \x1b[35mFun:\x1b[0m   fastfetch, cowsay, figlet, sl",
    `  \x1b[2m${netBit}~ (/root) auto-saves · ${transferHint}\x1b[0m`,
    "",
  ].join("\r\n");
}

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
    if (sessionStorage.getItem("golinux.reloaded_for") === key) {
      return false;
    }
    sessionStorage.setItem("golinux.reloaded_for", key);
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

  // Always preload bundles.json + empty-chunk.zst right away so the VM can
  // boot immediately in parallel with SW install (never blocked on 2G!).
  const fallbackReadyPromise = initChunkFallback();

  if (!swSupported) {
    await fallbackReadyPromise;
    if (remoteChunks) {
      // Page-level direct bundle fallback works even without SW, as long as
      // bundles.json loaded cleanly; only fail if neither SW nor bundles.json is available.
      return true;
    }
    return true;
  }

  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    pushAssetBase();
    pushBandwidthPref();
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
    reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
  } catch (e) {
    console.warn("service worker registration failed:", e);
  }

  if (hadController && reg && navigator.onLine !== false) {
    try {
      await Promise.race([
        reg.update().catch(() => {}),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      if (upgradeReloading) return false;
      if (reg.installing || reg.waiting) {
        setLoading("Updating GoLinux", "Installing the latest version…");
        await waitForWorkerActivation(reg, 4500);
        if (upgradeReloading) return false;
      }
      if (GL_BUILD_ID) {
        const liveId = await fetchLiveBuildId(1800);
        if (liveId && liveId !== GL_BUILD_ID) {
          try { await reg.update(); } catch (e) {}
          if (triggerUpgradeReload("build-" + liveId)) return false;
        }
      }
    } catch (e) { /* offline or update check timed out; proceed with cached SW */ }
  }

  // Wait up to 3.5s for SW control on first visit if fallback isn't ready yet,
  // otherwise let boot proceed immediately while SW finishes installing in background.
  const [, controlled] = await Promise.all([
    fallbackReadyPromise,
    navigator.serviceWorker.controller
      ? Promise.resolve(true)
      : waitForWorkerControl(hadController ? 4000 : 1200),
  ]);
  if (upgradeReloading) return false;
  if (controlled) {
    pushAssetBase();
    pushBandwidthPref();
  } else {
    waitForWorkerControl(25000).then((ok) => {
      if (ok) {
        pushAssetBase();
        pushBandwidthPref();
      }
    }).catch(() => {});
  }
  return true;
}

function snapPartCacheName() {
  const v = typeof GL_VERSION !== "undefined" ? GL_VERSION : "v0";
  const b = typeof GL_BUILD_ID !== "undefined" && GL_BUILD_ID ? GL_BUILD_ID : "dev";
  return `golinux-snap-part-${v}-${b}`;
}
const SNAP_PART_KEY = "/__golinux_snap_partial__";
const SNAP_CHECKPOINT_BYTES = 256 * 1024;
const SNAP_STALL_MS = 8000;
const QUICK_TIPS = [
  "Tip: Press Ctrl+K anytime for the command palette & starter snippets.",
  "Tip: Compile C in milliseconds with `tcc hello.c -o hello` or `gcc`.",
  "Tip: Pipe any command output to `clip` to copy it to your host clipboard.",
  "Tip: Everything in ~ (/root) auto-saves locally to your browser.",
];

async function readCachedSnapshot() {
  for (const name of [GL_DATA_CACHE, GL_SHELL_CACHE]) {
    try {
      const c = await caches.open(name);
      const hit = await c.match(GL_SNAPSHOT_URL, { ignoreSearch: true });
      if (hit && hit.ok) return await hit.arrayBuffer();
    } catch (e) { /* Cache API unavailable */ }
  }
  return null;
}

async function readPartialSnapshot() {
  if (typeof caches === "undefined") return null;
  try {
    const c = await caches.open(snapPartCacheName());
    const hit = await c.match(SNAP_PART_KEY);
    if (!hit || !hit.ok) return null;
    const etag = hit.headers.get("X-GL-ETag") || "";
    const total = Number(hit.headers.get("X-GL-Total")) || 0;
    const buf = await hit.arrayBuffer();
    if (!buf.byteLength) return null;
    return { bytes: new Uint8Array(buf), etag, total };
  } catch (_) {
    return null;
  }
}

async function writePartialSnapshot(chunks, totalLoaded, etag, total) {
  if (typeof caches === "undefined" || !totalLoaded) return;
  try {
    const merged = new Uint8Array(totalLoaded);
    let off = 0;
    for (const ch of chunks) {
      merged.set(ch, off);
      off += ch.byteLength;
    }
    const c = await caches.open(snapPartCacheName());
    await c.put(SNAP_PART_KEY, new Response(merged, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(totalLoaded),
        "X-GL-ETag": etag || "",
        "X-GL-Total": String(total || 0),
      },
    }));
  } catch (_) {}
}

async function clearPartialSnapshot() {
  if (typeof caches === "undefined") return;
  try { await caches.delete(snapPartCacheName()); } catch (_) {}
}

let manualRetryFn = null;

function setRetryControl(visible, onRetry) {
  manualRetryFn = onRetry || null;
  const btn = document.getElementById("loadingRetry");
  if (!btn) return;
  btn.hidden = !visible;
  btn.onclick = () => {
    if (manualRetryFn) manualRetryFn();
  };
}

/**
 * Range-resumable snapshot downloader with stall detection, exponential backoff,
 * and Cache Storage checkpointing so 2G connections never lose progress.
 */
async function fetchSnapshotResumable(url, onProgress, onStatusDetail) {
  const fetchStart = performance.now();
  let partial = await readPartialSnapshot();
  const chunks = partial ? [partial.bytes] : [];
  let loaded = partial ? partial.bytes.byteLength : 0;
  let total = partial ? partial.total : 0;
  let etag = partial ? partial.etag : "";
  let lastCheckpoint = loaded;

  if (loaded > 0) {
    onProgress(loaded, total || loaded, 0);
  }

  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    let stalled = false;
    let lastByteAt = performance.now();
    const watchdog = ctrl ? setInterval(() => {
      if (performance.now() - lastByteAt > SNAP_STALL_MS) {
        stalled = true;
        ctrl.abort();
      }
    }, 1000) : null;

    try {
      const headers = {};
      if (loaded > 0) {
        headers["Range"] = `bytes=${loaded}-`;
        if (etag) headers["If-Range"] = etag;
      }
      const res = await fetch(url, {
        headers,
        cache: "no-store",
        signal: ctrl ? ctrl.signal : undefined,
      });

      if (res.status === 404) {
        if (watchdog) clearInterval(watchdog);
        await clearPartialSnapshot();
        return { missing: true };
      }
      if (res.status === 416) {
        if (watchdog) clearInterval(watchdog);
        // Range not satisfiable (e.g. already complete or file shrank); restart clean.
        chunks.length = 0;
        loaded = 0;
        total = 0;
        etag = "";
        await clearPartialSnapshot();
        continue;
      }
      if (!res.ok) throw new Error("snapshot fetch failed: " + res.status);

      const newEtag = res.headers.get("ETag") || etag;
      if (res.status === 200) {
        // Upstream sent full entity (either fresh download or ETag changed).
        chunks.length = 0;
        loaded = 0;
        lastCheckpoint = 0;
        total = Number(res.headers.get("Content-Length")) || 0;
      } else if (res.status === 206) {
        const cr = res.headers.get("Content-Range") || "";
        const m = /bytes\s+\d+-\d+\/(\d+)/i.exec(cr);
        if (m) total = Number(m[1]);
        else if (!total) total = loaded + (Number(res.headers.get("Content-Length")) || 0);
      }
      etag = newEtag;

      if (!res.body || !res.body.getReader) {
        const buf = await res.arrayBuffer();
        if (watchdog) clearInterval(watchdog);
        if (res.status === 200) {
          const dt = Math.max(0.05, (performance.now() - fetchStart) / 1000);
          const bps = buf.byteLength / dt;
          onProgress(buf.byteLength, buf.byteLength, bps);
          await clearPartialSnapshot();
          setRetryControl(false, null);
          return { buffer: buf, bps };
        }
        chunks.push(new Uint8Array(buf));
        loaded += buf.byteLength;
      } else {
        const reader = res.body.getReader();
        const samples = [{ t: performance.now(), bytes: loaded }];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength) {
            lastByteAt = performance.now();
            chunks.push(value);
            loaded += value.byteLength;

            const now = lastByteAt;
            samples.push({ t: now, bytes: loaded });
            const cutoff = now - 2000;
            while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
            const first = samples[0];
            const dt = (now - first.t) / 1000;
            const displayBps = (dt >= 0.4 && loaded - first.bytes > 0)
              ? ((loaded - first.bytes) / dt)
              : 0;
            onProgress(loaded, total || loaded, displayBps);

            if (loaded - lastCheckpoint >= SNAP_CHECKPOINT_BYTES) {
              lastCheckpoint = loaded;
              writePartialSnapshot(chunks, loaded, etag, total);
            }
          }
        }
      }

      if (watchdog) clearInterval(watchdog);
      const out = new Uint8Array(loaded);
      let off = 0;
      for (const p of chunks) { out.set(p, off); off += p.byteLength; }
      await clearPartialSnapshot();
      setRetryControl(false, null);
      const totalMs = performance.now() - fetchStart;
      const finalBps = totalMs >= 300 ? (loaded / (totalMs / 1000)) : 0;
      return { buffer: out.buffer, bps: finalBps };
    } catch (e) {
      if (watchdog) clearInterval(watchdog);
      await writePartialSnapshot(chunks, loaded, etag, total);
      if (attempt === MAX_ATTEMPTS - 1) throw e;
      const waitMs = Math.min(8000, 1000 * (2 ** attempt));
      if (onStatusDetail) {
        const pct = total ? ` at ${Math.round((loaded / total) * 100)}%` : "";
        onStatusDetail(
          (stalled ? `Connection stalled${pct}` : `Connection interrupted${pct}`) +
          ` — retrying in ${Math.round(waitMs / 1000)}s…`
        );
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => { setRetryControl(false, null); resolve(); }, waitMs);
        setRetryControl(true, () => {
          clearTimeout(timer);
          setRetryControl(false, null);
          resolve();
        });
      });
    }
  }
  throw new Error("snapshot download failed");
}

async function cacheSnapshotInDataCache(buffer) {
  try {
    const cache = await caches.open(GL_DATA_CACHE);
    await cache.put(GL_SNAPSHOT_URL, new Response(buffer.slice(0), {
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

  // Warm v86.wasm into HTTP/SW cache in parallel with snapshot + /root restore.
  fetch("assets/v86/v86.wasm", { cache: "force-cache" }).catch(() => {});

  let tipTimer = null;
  let initialState = null;
  let savedRoot = null;

  const savedRootPromise = forcedOff
    ? Promise.resolve(null)
    : window.GoPersist.loadUserState().catch(() => null);

  if (!forcedOff) {
    const cachedBuf = await readCachedSnapshot();
    if (cachedBuf) {
      setStatus("restoring…");
      setLoading("Starting…", "Restoring cached Alpine snapshot & /root files…");
      initialState = { buffer: cachedBuf };
    } else {
      setStatus("downloading…");
      let tipIdx = 0;
      setLoading("Downloading the machine", "Resumable ~9 MB snapshot (cached locally after first load).");
      showProgress(0, 0);
      tipTimer = setInterval(() => {
        tipIdx = (tipIdx + 1) % QUICK_TIPS.length;
        setLoading("Downloading the machine", QUICK_TIPS[tipIdx]);
      }, 4500);

      try {
        const snap = await fetchSnapshotResumable(
          GL_SNAPSHOT_URL,
          (l, t, bps) => showProgress(l, t, bps),
          (msg) => setLoading("Downloading the machine", msg)
        );
        if (snap && snap.buffer) {
          initialState = { buffer: snap.buffer };
          reportThroughputToSW(snap.bps);
          await cacheSnapshotInDataCache(snap.buffer);
        }
      } catch (e) {
        setStatus("snapshot failed: " + e.message);
      }
      if (tipTimer) clearInterval(tipTimer);
      setRetryControl(false, null);
      hideProgress();
    }
  }

  savedRoot = await savedRootPromise;
  window.__usedUserState = !!savedRoot;
  setStatus(initialState ? "restoring…" : "booting…");

  clearTerminalMount();

  const chunkSize = typeof GL_CHUNK_SIZE === "number" ? GL_CHUNK_SIZE : (128 * 1024);
  const disk = {
    url: "/" + GL_CHUNK_PATH + "chunk.zst",
    async: true,
    use_parts: true,
    fixed_chunk_size: chunkSize,
    size: typeof GL_DISK_SIZE === "number" ? GL_DISK_SIZE : 1 * 1024 * 1024 * 1024,
  };

  const container = document.getElementById("terminal");
  const options = {
    wasm_path: "assets/v86/v86.wasm",
    bios: { url: "assets/bios/seabios.bin" },
    vga_bios: { url: "assets/bios/vgabios.bin" },
    vga_memory_size: typeof GL_VGA_MEMORY_SIZE === "number" ? GL_VGA_MEMORY_SIZE : (8 * 1024 * 1024),
    hda: disk,
    filesystem: {},
    net_device: { type: "virtio" },
    preserve_mac_from_state_image: true,
    memory_size: GL_MEMORY_SIZE,
    disable_speaker: true,
    disable_keyboard: true,
    disable_mouse: true,
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
    const nextgenSchema = typeof GL_STATE_SCHEMA === "number" && GL_STATE_SCHEMA >= 5;
    if (nextgenSchema) {
      options.cmdline = "root=/dev/sda rootfstype=squashfs ro init=/sbin/init-overlay mitigations=off quiet console=ttyS0";
    } else {
      options.initrd = { url: "images/debian-initrd" };
      options.cmdline = "root=/dev/sda rootfstype=ext4 modules=sd-mod,ext4 rw console=ttyS0";
    }
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
    const { SafeFetchNetworkAdapter } = await import("./net-adapter.js");
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
      term.write(buildFreshMotd() + restoreNote + "\r\n\x1b[1;32mroot@golinux\x1b[0m:\x1b[1;34m~\x1b[0m# ");
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
