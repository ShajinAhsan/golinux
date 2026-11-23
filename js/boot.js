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
  setLoading,
  setStatus,
  showFatal,
  showProgress,
} from "./status.js";
import { currentTerminal, fitSoon } from "./terminal.js";
import { attachKeyboardInterceptor } from "./keybar.js";

const FRESH_MOTD = [
  "",
  "  \x1b[1;32mGoLinux\x1b[0m \x1b[2m· Debian 12 (bookworm) i386 · local WebAssembly VM\x1b[0m",
  "  \x1b[36mTools:\x1b[0m gcc/g++, python3, git, make, vim, nano, tmux, htop, jq, tree, man",
  "  \x1b[35mFun:\x1b[0m   fastfetch, neofetch, cowsay, figlet, sl",
  "  \x1b[2mOffline-safe (no guest network) · /root persists locally · transfer via /mnt/host\x1b[0m",
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

  navigator.serviceWorker.addEventListener("controllerchange", pushAssetBase);

  try {
    await navigator.serviceWorker.register("sw.js");
  } catch (e) {
    console.warn("service worker registration failed:", e);
  }

  const controlled = await waitForWorkerControl(6000);
  if (controlled) {
    pushAssetBase();
    return true;
  }

  if (remoteChunks) {
    showFatal(
      "Could not start",
      "The service worker did not take control of the page, and this build " +
      "loads its disk data from another origin. Reloading usually fixes it."
    );
    return false;
  }
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
  const res = await fetch(url);
  if (!res.ok) throw new Error("snapshot fetch failed: " + res.status);

  const total = Number(res.headers.get("Content-Length")) || 0;
  if (!res.body || !res.body.getReader) {
    const buf = await res.arrayBuffer();
    onProgress(buf.byteLength, buf.byteLength);
    return buf;
  }

  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total || loaded);
  }

  const out = new Uint8Array(loaded);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out.buffer;
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
    if (child.id !== "diskToast") child.remove();
  }
}

let ownershipClaimed = false;
let restarting = false;

export async function bootMachine() {
  const bootStart = performance.now();

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then((g) => { window.__persisted = g; }).catch(() => {});
  }

  if (!ownershipClaimed) {
    ownershipClaimed = true;
    await window.GoPersist.claimOwnership();
  }

  const forcedOff = new URLSearchParams(location.search).has("nosnapshot");

  let userState = null;
  if (!forcedOff) {
    setLoading("Restoring your session", "Loading saved machine state from this browser.");
    setStatus("restoring…");
    userState = await window.GoPersist.loadUserState();
    if (!userState) {
      setLoading("Starting a fresh machine", "Loading the shipped Debian snapshot.");
    }
  }

  const haveSnapshot = !forcedOff && (await snapshotAvailable(GL_SNAPSHOT_URL));
  if (!userState) setStatus(haveSnapshot ? "restoring…" : "booting…");

  let initialState = null;
  if (userState) {
    initialState = { buffer: userState };
    window.__usedUserState = true;
  } else if (haveSnapshot) {
    window.__usedUserState = false;
    const cached = await snapshotIsCached();
    if (!cached) {
      setLoading("Downloading the machine", "About 13 MB the first time; cached afterwards.");
      showProgress(0, 0);
    } else {
      setLoading("Starting…", "Restoring the shipped snapshot.");
    }

    try {
      const buf = await fetchSnapshotWithProgress(GL_SNAPSHOT_URL, (l, t) => {
        if (!cached) showProgress(l, t);
      });
      initialState = { buffer: buf };
      if (!cached) await cacheSnapshotIfNoSW(buf);
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
    size: 5 * 1024 * 1024 * 1024,
  };

  const container = document.getElementById("terminal");
  const options = {
    wasm_path: "assets/v86/v86.wasm",
    bios: { url: "assets/bios/seabios.bin" },
    vga_bios: { url: "assets/bios/vgabios.bin" },
    hda: disk,
    filesystem: {},
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
    options.cmdline = "root=/dev/sda rw console=ttyS0";
    options.serial_console = {
      type: "xtermjs",
      container,
      xterm_lib: window.Terminal,
    };
  }

  window.__usedSnapshot = !!initialState;
  const emu = new window.V86(options);
  window.emulator = emu;

  try {
    window.Go9p.install(emu);
  } catch (e) {
    console.warn("9p state wrapper not installed:", e.message);
  }

  emu.add_listener("emulator-loaded", () => {
    setStatus("running");
    window.__bootMs = Math.round(performance.now() - bootStart);
    clearLoading();

    // Hook unified keybar + native keyboard modifier pipeline & dirty tracking.
    attachKeyboardInterceptor(emu);

    // Attach autosave lifecycle (only active if this tab owns persistence lock).
    window.GoPersist.attach(emu);

    // Display local banner ONLY via xterm.write (zero bytes sent to guest!).
    const term = currentTerminal();
    if (term && initialState) {
      if (userState) {
        term.write("\x1b[2m[session restored]\x1b[0m\r\n");
      } else {
        term.write(FRESH_MOTD + "\r\n\x1b[1;32mroot@golinux\x1b[0m:\x1b[1;34m~\x1b[0m# ");
      }
    }

    // Resize xterm.js and send out-of-band virtio-console0-resize (zero stdin).
    // On user-state restore, nudge SIGWINCH so bash/nano redraws its real prompt.
    fitSoon({ nudgeRedraw: !!userState });
  });

  emu.add_listener("emulator-started", () => setStatus("running"));
  emu.add_listener("emulator-stopped", () => setStatus("stopped"));
  emu.add_listener("download-error", (e) => {
    setStatus("download failed: " + (e && e.file_name ? e.file_name : "asset"));
  });

  return emu;
}

/**
 * Safe restart: cleanly destroys the running V86 instance and boots fresh from
 * saved/shipped snapshot (never calls emulator.restart() into SeaBIOS).
 */
export async function restartMachine() {
  if (restarting) return;
  restarting = true;
  const btn = document.getElementById("restart");
  if (btn) btn.disabled = true;
  try {
    setStatus("restarting…");
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
