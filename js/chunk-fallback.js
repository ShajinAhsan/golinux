/* Page-level disk chunk resilience & automatic Service Worker recovery.
 *
 * Fixes the "clear site data & cache while Linux is running -> terminal freezes"
 * bug:
 *   When a user clears browser site data/cache mid-session, the browser wipes
 *   Cache Storage and/or unregisters sw.js. Subsequent v86 XHR reads to
 *   /images/debian-chunks/<buildId>/chunk-*.zst would bypass the dead SW, hit
 *   terminal.golinux.app directly, get HTTP 404, and hang v86's IDE driver
 *   indefinitely.
 *
 * How this protects the live VM with ZERO normal-path overhead:
 *   1. On boot, preloads bundles.json (~147 KB) and empty-chunk.zst (25 B)
 *      into page memory.
 *   2. Watches serviceWorker controllerchange and auto-re-registers sw.js if
 *      the controller disappears.
 *   3. Wraps XMLHttpRequest ONLY for /images/debian-chunks/.../chunk-*.zst:
 *      - When SW is controlling the page, requests pass straight through.
 *      - If SW is gone (controller === null) OR a same-origin 404 leaks back
 *        from a just-killed SW, this serves empty chunks from RAM and fetches
 *        real chunks directly from https://assets.golinux.app/bundles/<id>/...
 *        (CORS-enabled + CDN cached), unpacking sibling chunks into an
 *        in-memory cache and re-registering sw.js in the background.
 *
 * Preserves INV-1 (zero guest stdin) and INV-2 (real R2 404 / offline never
 * silently becomes zeros).
 */

import { showFatal, showOfflineBanner, hideOfflineBanner } from "./status.js";

const CHUNK_URL_RE = /\/debian-chunks\/(?:[^/]+\/)?(chunk-\d+-\d+\.zst)(?:[?#].*)?$/;

let emptyChunkBytes = null;
let chunkToBundle = null;      // Map<chunkName, { file, off, len }>
let bundleToChunks = null;     // Map<file, Array<{ name, off, len }>>
let bundleSizes = null;        // Map<file, number>
const memChunks = new Map();   // fallback in-memory cache: chunkName -> ArrayBuffer
const inflight = new Map();    // file -> Promise<{ status, map? }>
const inflightRange = new Map(); // chunkName -> Promise<{ status, buf? }>
let installed = false;
let reRegisterTimer = null;
let fallbackBps = null;

function isSlowFallback() {
  const pref = (() => {
    try { return localStorage.getItem("golinux.bwMode") || "auto"; } catch (_) { return "auto"; }
  })();
  if (pref === "slow") return true;
  if (pref === "fast") return false;
  const threshold = typeof GL_SLOW_LINK_BPS === "number" ? GL_SLOW_LINK_BPS : (300 * 1024);
  if (fallbackBps != null) return fallbackBps < threshold;
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (c) {
    if (c.saveData) return true;
    if (/^(slow-2g|2g|3g)$/.test(c.effectiveType || "")) return true;
    if (typeof c.downlink === "number" && c.downlink > 0 && c.downlink < 2.5) return true;
  }
  return false;
}

function reRegisterSW() {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker) return;
  if (reRegisterTimer) return;
  reRegisterTimer = setTimeout(() => {
    reRegisterTimer = null;
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }, 150);
}

/** Preload bundles.json and empty-chunk.zst into page RAM for wipe resilience. */
export async function initChunkFallback() {
  try {
    const [emptyRes, bundlesRes] = await Promise.all([
      fetch(GL_EMPTY_CHUNK_PATH).catch(() => null),
      fetch("bundles.json").catch(() => null),
    ]);
    if (emptyRes && emptyRes.ok) {
      emptyChunkBytes = await emptyRes.arrayBuffer();
    }
    if (bundlesRes && bundlesRes.ok) {
      const data = await bundlesRes.json();
      if (data && Array.isArray(data.files) && Array.isArray(data.entries)) {
        const chunkSize = Number(data.chunkSize) || (128 * 1024);
        const c2b = new Map();
        const b2c = new Map();
        const bsz = new Map();
        for (const f of data.files) {
          b2c.set(f, []);
          bsz.set(f, 0);
        }
        for (const row of data.entries) {
          const [idx, fileIdx, off, len] = row;
          const file = data.files[fileIdx];
          if (!file) continue;
          const start = idx * chunkSize;
          const name = `chunk-${start}-${start + chunkSize}.zst`;
          c2b.set(name, { file, off, len });
          b2c.get(file).push({ name, off, len });
          if (off + len > (bsz.get(file) || 0)) bsz.set(file, off + len);
        }
        chunkToBundle = c2b;
        bundleToChunks = b2c;
        bundleSizes = bsz;
      }
    }
  } catch (e) {
    /* non-fatal; SW still handles normal path */
  }

  installXhrGuard();
}

async function fetchBundleDirect(file) {
  if (inflight.has(file)) return inflight.get(file);

  const p = (async () => {
    try {
      const url = typeof glBundleUrl === "function"
        ? glBundleUrl(file)
        : (GL_ASSET_BASE + "/" + GL_BUNDLES_PATH + file);
      const res = await fetch(url);
      if (!res.ok) return { status: res.status };
      const buf = await res.arrayBuffer();
      const members = (bundleToChunks && bundleToChunks.get(file)) || [];
      const map = new Map();
      // Cap in-memory fallback map to ~32 MB (~800 chunks) to stay mobile-safe.
      if (memChunks.size > 800) memChunks.clear();
      for (const m of members) {
        const slice = buf.slice(m.off, m.off + m.len);
        map.set(m.name, slice);
        memChunks.set(m.name, slice);
      }
      // Best-effort repopulate Cache API if available.
      try {
        if (typeof caches !== "undefined") {
          const cache = await caches.open(GL_DATA_CACHE);
          const prefix = "/" + GL_CHUNK_PATH;
          for (const [name, slice] of map) {
            cache.put(
              new Request(location.origin + prefix + name, { method: "GET" }),
              new Response(slice.slice(0), {
                status: 200,
                headers: {
                  "Content-Type": "application/zstd",
                  "Content-Length": String(slice.byteLength),
                },
              })
            ).catch(() => {});
          }
        }
      } catch (_) {}
      hideOfflineBanner();
      return { status: 200, map };
    } catch (e) {
      return { status: 0, error: e };
    }
  })();

  inflight.set(file, p);
  p.finally(() => {
    if (inflight.get(file) === p) inflight.delete(file);
  });
  return p;
}

async function fetchChunkRangeDirect(name, meta) {
  if (inflightRange.has(name)) return inflightRange.get(name);
  const p = (async () => {
    const t0 = Date.now();
    try {
      const url = typeof glBundleUrl === "function"
        ? glBundleUrl(meta.file)
        : (GL_ASSET_BASE + "/" + GL_BUNDLES_PATH + meta.file);
      const res = await fetch(url, {
        headers: { Range: `bytes=${meta.off}-${meta.off + meta.len - 1}` },
      });
      if (!res.ok) return { status: res.status };
      const buf = await res.arrayBuffer();
      const dt = Math.max(1, Date.now() - t0);
      if (buf.byteLength > 0) fallbackBps = buf.byteLength / (dt / 1000);

      if (res.status === 206 && buf.byteLength === meta.len) {
        if (memChunks.size > 800) memChunks.clear();
        memChunks.set(name, buf);
        try {
          if (typeof caches !== "undefined") {
            const cache = await caches.open(GL_DATA_CACHE);
            cache.put(
              new Request(location.origin + "/" + GL_CHUNK_PATH + name, { method: "GET" }),
              new Response(buf.slice(0), {
                status: 200,
                headers: {
                  "Content-Type": "application/zstd",
                  "Content-Length": String(buf.byteLength),
                },
              })
            ).catch(() => {});
          }
        } catch (_) {}
        hideOfflineBanner();
        return { status: 200, buf };
      }

      if (res.status === 200 && buf.byteLength >= meta.off + meta.len) {
        const members = (bundleToChunks && bundleToChunks.get(meta.file)) || [];
        if (memChunks.size > 800) memChunks.clear();
        let wanted = null;
        for (const m of members) {
          const slice = buf.slice(m.off, m.off + m.len);
          memChunks.set(m.name, slice);
          if (m.name === name) wanted = slice;
        }
        hideOfflineBanner();
        if (wanted) return { status: 200, buf: wanted };
      }
      return { status: 502 };
    } catch (e) {
      return { status: 0, error: e };
    }
  })();
  inflightRange.set(name, p);
  p.finally(() => {
    if (inflightRange.get(name) === p) inflightRange.delete(name);
  });
  return p;
}

async function resolveChunkDirect(name, method) {
  if (!chunkToBundle) return { status: 404, missing: true };

  // Known-empty chunk -> return 25-byte empty-chunk.zst from RAM!
  if (!chunkToBundle.has(name)) {
    if (!emptyChunkBytes) {
      try {
        const r = await fetch(GL_EMPTY_CHUNK_PATH, { cache: "no-store" });
        if (r.ok) emptyChunkBytes = await r.arrayBuffer();
      } catch (_) {}
    }
    if (emptyChunkBytes) {
      return {
        status: 200,
        buf: method === "HEAD" ? new ArrayBuffer(0) : emptyChunkBytes.slice(0),
        len: emptyChunkBytes.byteLength,
      };
    }
    return { status: 404, missing: true };
  }

  const meta = chunkToBundle.get(name);
  if (method === "HEAD") {
    return { status: 200, buf: new ArrayBuffer(0), len: meta.len };
  }

  if (memChunks.has(name)) {
    const hit = memChunks.get(name);
    return { status: 200, buf: hit.slice(0), len: hit.byteLength };
  }

  const smallLimit = typeof GL_SMALL_BUNDLE_BYTES === "number" ? GL_SMALL_BUNDLE_BYTES : (96 * 1024);
  const bSize = (bundleSizes && bundleSizes.get(meta.file)) || 0;
  if (isSlowFallback() && (bSize === 0 || bSize > smallLimit)) {
    const res = await fetchChunkRangeDirect(name, meta);
    if (res.status === 200 && res.buf) {
      return { status: 200, buf: res.buf.slice(0), len: res.buf.byteLength };
    }
    if (res.status === 0) {
      showOfflineBanner();
      return { status: 408 };
    }
    if (res.status === 404) {
      showFatal(
        "This version is out of date",
        "Disk data for this build could not be loaded (missing bundle " +
        meta.file + "). Reload the page to load the current version."
      );
      return { status: 404, missing: true };
    }
    return { status: res.status || 502 };
  }

  const res = await fetchBundleDirect(meta.file);
  if (res.status === 200 && res.map && res.map.has(name)) {
    const slice = res.map.get(name);
    return { status: 200, buf: slice.slice(0), len: slice.byteLength };
  }
  if (res.status === 0) {
    showOfflineBanner();
    return { status: 408 };
  }
  if (res.status === 404) {
    showFatal(
      "This version is out of date",
      "Disk data for this build could not be loaded (missing bundle " +
      meta.file + "). Reload the page to load the current version."
    );
    return { status: 404, missing: true };
  }
  return { status: res.status || 502 };
}

function fulfillSyntheticXhr(xhr, result) {
  const status = result.status || 500;
  const buf = result.buf || new ArrayBuffer(0);
  const len = String(result.len != null ? result.len : buf.byteLength);
  try {
    Object.defineProperty(xhr, "readyState", { configurable: true, value: 4 });
    Object.defineProperty(xhr, "status", { configurable: true, value: status });
    Object.defineProperty(xhr, "statusText", { configurable: true, value: status === 200 ? "OK" : "Error" });
    Object.defineProperty(xhr, "response", { configurable: true, value: buf });
    xhr.getResponseHeader = (h) => {
      if (/^content-length$/i.test(h)) return len;
      if (/^content-type$/i.test(h)) return "application/zstd";
      return null;
    };
  } catch (_) {}
  if (typeof xhr.onreadystatechange === "function") {
    try { xhr.onreadystatechange(new Event("readystatechange")); } catch (_) {}
  }
  if (typeof xhr.onload === "function") {
    try { xhr.onload(new Event("load")); } catch (_) {}
  }
}

function installXhrGuard() {
  if (installed || typeof XMLHttpRequest === "undefined") return;
  installed = true;

  if ("serviceWorker" in navigator && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!navigator.serviceWorker.controller) reRegisterSW();
    });
  }

  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__glMethod = String(method || "GET").toUpperCase();
    this.__glUrl = String(url || "");
    const m = CHUNK_URL_RE.exec(this.__glUrl);
    this.__glChunkName = m ? m[1] : null;
    return OrigOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const chunkName = this.__glChunkName;
    if (!chunkName || !chunkToBundle) {
      return OrigSend.apply(this, args);
    }

    const swControlling = !!("serviceWorker" in navigator &&
      navigator.serviceWorker &&
      navigator.serviceWorker.controller);

    // If SW was wiped (e.g. user cleared site data while VM is running),
    // fulfill directly via in-memory empty-chunk / direct R2 bundle fetch and
    // re-register sw.js in the background. Zero terminal freeze!
    if (!swControlling) {
      reRegisterSW();
      resolveChunkDirect(chunkName, this.__glMethod).then((res) => {
        fulfillSyntheticXhr(this, res);
      });
      return;
    }

    // Even when controller looks truthy, a browser wiping site data mid-flight
    // can cause this XHR to bypass the dying SW and get a 404 from app origin.
    // Intercept onload so a stale-SW 404 seamlessly recovers via direct bundle!
    const origOnload = this.onload;
    if (typeof origOnload === "function") {
      this.onload = function (ev) {
        if (this.readyState === 4 && this.status === 404) {
          reRegisterSW();
          this.onload = origOnload;
          resolveChunkDirect(chunkName, this.__glMethod).then((res) => {
            fulfillSyntheticXhr(this, res);
          });
          return;
        }
        return origOnload.call(this, ev);
      };
    }

    return OrigSend.apply(this, args);
  };
}
