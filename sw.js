/* GoLinux service worker.
 *
 * Key invariants enforced:
 *   - All GL_SHELL_FILES (including chunks-precache.json & assets/empty-chunk.zst)
 *     are precached as install-critical so offline chunk classification works.
 *   - ?assets= override persistence is strictly localhost-only; production
 *     visitors can never be redirected by a query string or stored config.
 *   - 404 for a known-empty chunk -> assets/empty-chunk.zst.
 *   - 404 for a REAL chunk -> 404 + postMessage("chunk-missing-real") (NEVER zeros).
 *   - 5xx -> pass through (NEVER zeros).
 *   - Offline on a known-empty chunk -> assets/empty-chunk.zst silently (no error banner).
 *   - Offline on a REAL chunk -> HTTP 408 (avoids v86's infinite 5xx retry storm)
 *     + postMessage("chunk-offline") (shows offline banner; does NOT kill VM as "out of date").
 *   - Chunk HEAD preserves method:"HEAD" and answers from cache when cached.
 *   - /packs/*.json bypasses GL_SHELL_CACHE (never frozen stale).
 *   - Pack downloader fetches (?gl_pack=1) bypass SW data-cache/disk-activity
 *     so packs are not double-cached into GL_DATA_CACHE.
 *   - HTML navigations use network-first with cache fallback so deploys ship immediately.
 */

// Stamped with "<GL_VERSION>-<GL_BUILD_ID>" by build-pages.sh on every deploy
// so Safari/WebKit always detects a byte-level sw.js update even when only
// packs-config.js, js/*.js, styles.css, or the Linux image changed.
const GL_SW_STAMP = "dev";

importScripts("packs-config.js");

const SHELL_FILES = GL_SHELL_FILES;

// Matches both flat local dev paths and build-id versioned production paths.
const CHUNK_RE = /\/debian-chunks\/(?:[^/]+\/)?chunk-\d+-\d+\.zst$/;

const GL_CONFIG_CACHE = "golinux-config";
const GL_ASSET_OVERRIDE_KEY = "asset-base-override";

const IS_LOCAL_HOST = glIsLocalHost(self.location && self.location.hostname);
let overrideGeneration = 0;

let assetBaseReady = (async () => {
  if (!IS_LOCAL_HOST) return;
  const gen = overrideGeneration;
  try {
    const cache = await caches.open(GL_CONFIG_CACHE);
    const hit = await cache.match(GL_ASSET_OVERRIDE_KEY);
    if (hit && overrideGeneration === gen) {
      const base = await hit.text();
      if (base && overrideGeneration === gen) glSetAssetBase(base);
    }
  } catch (e) { /* no persisted override */ }
})();

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(GL_SHELL_CACHE);
    const results = await Promise.allSettled(
      SHELL_FILES.map((f) => cache.add(new Request(f, { cache: "reload" })))
    );

    const failed = results
      .map((r, i) => (r.status === "rejected" ? SHELL_FILES[i] : null))
      .filter(Boolean);

    if (failed.length) {
      console.warn("service worker: could not precache", failed);
      throw new Error("precache failed: " + failed.join(", "));
    }

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keep = new Set([GL_SHELL_CACHE, GL_DATA_CACHE, GL_PACK_CACHE]);
    if (IS_LOCAL_HOST) keep.add(GL_CONFIG_CACHE);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
    broadcast({
      type: "sw-activated",
      version: GL_VERSION,
      buildId: GL_BUILD_ID,
      stamp: GL_SW_STAMP,
    });
  })());
});

// Localhost-only ?assets= override persistence. Ignored on production hosts.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "set-asset-base") {
    if (!IS_LOCAL_HOST) return;
    overrideGeneration++;
    const base = glSetAssetBase(event.data.base);
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(GL_CONFIG_CACHE);
        if (base) {
          await cache.put(
            GL_ASSET_OVERRIDE_KEY,
            new Response(base, { headers: { "Content-Type": "text/plain" } })
          );
        } else {
          await cache.delete(GL_ASSET_OVERRIDE_KEY);
        }
      } catch (e) { /* non-fatal */ }
    })());
  }
});

/* ---------- real chunk manifest + hybrid bundle index ---------- */

let realChunkSet = null;
let realChunkPromise = null;
let emptyChunkBytes = null;
let emptyChunkPromise = null;
let bundleIndex = null;      // { chunkToBundle, bundleToChunks, bundleSizes }
let bundleIndexPromise = null;
const inflightBundles = new Map(); // file -> Promise<{ status, map?: Map<name, ArrayBuffer>, response?: Response }>
const inflightChunks = new Map();  // chunkName -> Promise<{ status, buf?: ArrayBuffer, response?: Response }>
let bandwidthPref = "auto";        // "auto" | "slow" | "fast"
let idleWarmAbort = null;
let toolWarmQueue = [];
let toolWarmActive = 0;

/**
 * Return the 25-byte empty-chunk.zst response even if the user cleared Cache
 * Storage while this SW remained active in memory.
 */
async function getEmptyChunkResponse(headOnly) {
  if (!emptyChunkBytes) {
    if (!emptyChunkPromise) {
      emptyChunkPromise = (async () => {
        try {
          const shell = await caches.open(GL_SHELL_CACHE);
          const cached = await shell.match(GL_EMPTY_CHUNK_PATH, { ignoreSearch: true });
          if (cached && cached.ok) {
            emptyChunkBytes = await cached.arrayBuffer();
            return emptyChunkBytes;
          }
        } catch (e) { /* fall through to network */ }
        try {
          const res = await fetch(GL_EMPTY_CHUNK_PATH, { cache: "no-store" });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            emptyChunkBytes = buf;
            caches.open(GL_SHELL_CACHE).then((c) => c.put(
              GL_EMPTY_CHUNK_PATH,
              new Response(buf.slice(0), {
                status: 200,
                headers: {
                  "Content-Type": "application/zstd",
                  "Content-Length": String(buf.byteLength),
                },
              })
            )).catch(() => {});
            return emptyChunkBytes;
          }
        } catch (e) { /* offline and cache wiped */ }
        emptyChunkPromise = null;
        return null;
      })();
    }
    await emptyChunkPromise;
  }
  if (!emptyChunkBytes) return null;
  return new Response(headOnly ? null : emptyChunkBytes.slice(0), {
    status: 200,
    statusText: "OK",
    headers: {
      "Content-Type": "application/zstd",
      "Content-Length": String(emptyChunkBytes.byteLength),
    },
  });
}

function loadRealChunks() {
  if (realChunkSet) return Promise.resolve(realChunkSet);
  if (realChunkPromise) return realChunkPromise;
  realChunkPromise = (async () => {
    try {
      // Prefer the precached copy for this SW version (works offline!).
      try {
        const shell = await caches.open(GL_SHELL_CACHE);
        const cached = await shell.match("chunks-precache.json", { ignoreSearch: true });
        if (cached && cached.ok) {
          const list = await cached.json();
          if (Array.isArray(list)) {
            realChunkSet = new Set(list);
            return realChunkSet;
          }
        }
      } catch (e) { /* fall through to network */ }

      const res = await fetch("chunks-precache.json", { cache: "no-store" });
      if (!res.ok) {
        realChunkPromise = null;
        return null;
      }
      const list = await res.json();
      if (!Array.isArray(list)) {
        realChunkPromise = null;
        return null;
      }
      realChunkSet = new Set(list);
      return realChunkSet;
    } catch (e) {
      // Never cache a transient failure forever: allow the next call to retry.
      realChunkPromise = null;
      return null;
    }
  })();
  return realChunkPromise;
}

function loadBundleIndex() {
  if (bundleIndex) return Promise.resolve(bundleIndex);
  if (bundleIndexPromise) return bundleIndexPromise;
  bundleIndexPromise = (async () => {
    try {
      let data = null;
      try {
        const shell = await caches.open(GL_SHELL_CACHE);
        const cached = await shell.match("bundles.json", { ignoreSearch: true });
        if (cached && cached.ok) data = await cached.json();
      } catch (e) { /* fall through */ }

      if (!data) {
        const res = await fetch("bundles.json", { cache: "no-store" });
        if (!res.ok) {
          bundleIndexPromise = null;
          return null;
        }
        data = await res.json();
      }

      if (!data || !Array.isArray(data.files) || !Array.isArray(data.entries)) {
        bundleIndexPromise = null;
        return null;
      }

      const chunkSize = Number(data.chunkSize) || (128 * 1024);
      const chunkToBundle = new Map();
      const bundleToChunks = new Map();
      const bundleSizes = new Map();
      for (const f of data.files) {
        bundleToChunks.set(f, []);
        bundleSizes.set(f, 0);
      }
      for (const row of data.entries) {
        const [idx, fileIdx, off, len] = row;
        const file = data.files[fileIdx];
        if (!file) continue;
        const start = idx * chunkSize;
        const name = `chunk-${start}-${start + chunkSize}.zst`;
        const meta = { file, off, len };
        chunkToBundle.set(name, meta);
        bundleToChunks.get(file).push({ name, off, len });
        const end = off + len;
        if (end > (bundleSizes.get(file) || 0)) bundleSizes.set(file, end);
      }
      bundleIndex = { chunkToBundle, bundleToChunks, bundleSizes };
      return bundleIndex;
    } catch (e) {
      bundleIndexPromise = null;
      return null;
    }
  })();
  return bundleIndexPromise;
}

function abortIdleWarm() {
  if (idleWarmAbort) {
    try { idleWarmAbort.abort(); } catch (_) {}
    idleWarmAbort = null;
  }
}

/** Stream a Response body while reporting byte deltas for live UI progress. */
async function readBodyWithProgress(response, onDelta) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const buf = await response.arrayBuffer();
    if (onDelta && buf.byteLength) onDelta(buf.byteLength);
    return buf;
  }
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      parts.push(value);
      total += value.byteLength;
      if (onDelta) onDelta(value.byteLength);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out.buffer;
}

/** Unpack a complete .pack ArrayBuffer into GL_DATA_CACHE and return Map<name, ArrayBuffer>. */
async function unpackBundleBuffer(file, buf, pathnamePrefix) {
  const idx = await loadBundleIndex();
  const members = (idx && idx.bundleToChunks.get(file)) || [];
  const cache = await caches.open(GL_DATA_CACHE).catch(() => null);
  const map = new Map();
  const puts = [];
  for (const m of members) {
    const slice = buf.slice(m.off, m.off + m.len);
    map.set(m.name, slice);
    if (cache) {
      const key = new Request(self.location.origin + pathnamePrefix + m.name, { method: "GET" });
      const resp = new Response(slice, {
        status: 200,
        headers: {
          "Content-Type": "application/zstd",
          "Content-Length": String(slice.byteLength),
        },
      });
      puts.push(cache.put(key, resp).catch(() => {}));
    }
  }
  if (puts.length) await Promise.all(puts);
  return map;
}

/**
 * Fetch a hybrid .pack bundle once (deduplicated across concurrent chunk reads),
 * stream byte progress live, slice every .zst chunk inside it directly into
 * GL_DATA_CACHE, and return a transient Map<chunkName, ArrayBuffer>.
 */
function fetchAndUnpackBundle(file, triggerName, pathnamePrefix, opts) {
  const bg = !!(opts && opts.background);
  const isIdle = !!(opts && opts.idle);
  const signal = opts && opts.signal;
  if (!isIdle && inflightBundles.has(file)) return inflightBundles.get(file);

  const p = (async () => {
    let streamed = 0;
    if (!bg) beginDiskRead(triggerName);
    const fetchStart = Date.now();
    const bundleUrl = glBundleUrl(file);
    try {
      const response = await fetch(bundleUrl, signal ? { signal } : undefined);
      if (!response.ok) {
        if (!bg) endDiskRead(false, 0, triggerName, streamed, triggerName);
        return { status: response.status, response };
      }
      const buf = await readBodyWithProgress(response, (delta) => {
        streamed += delta;
        if (!bg) progressDiskRead(delta);
      });
      const map = await unpackBundleBuffer(file, buf, pathnamePrefix);
      noteThroughput(buf.byteLength, Math.max(1, Date.now() - fetchStart));
      if (!bg) {
        const unpackedNames = [triggerName];
        for (const k of map.keys()) if (k !== triggerName) unpackedNames.push(k);
        endDiskRead(true, buf.byteLength, unpackedNames, streamed, triggerName);
      }
      return { status: 200, map, totalBytes: buf.byteLength };
    } catch (e) {
      if (!bg) endDiskRead(false, 0, triggerName, streamed, triggerName);
      return { status: 0, error: e, aborted: !!(e && e.name === "AbortError") };
    }
  })();

  if (!isIdle) {
    inflightBundles.set(file, p);
    p.finally(() => {
      if (inflightBundles.get(file) === p) inflightBundles.delete(file);
    });
  }
  return p;
}

/**
 * Slow-link exact byte-range fetch for a single chunk inside a .pack bundle.
 * Eliminates 2x-18x over-fetching at 500 Kbps - 1 Mbps while falling back
 * cleanly if an upstream ignores Range and returns 200 OK.
 */
function fetchChunkRange(bMeta, name, pathnamePrefix, opts) {
  const bg = !!(opts && opts.background);
  const isIdle = !!(opts && opts.idle);
  const signal = opts && opts.signal;

  if (!isIdle && inflightChunks.has(name)) return inflightChunks.get(name);
  if (inflightBundles.has(bMeta.file)) {
    return inflightBundles.get(bMeta.file).then((res) => {
      if (res.status === 200 && res.map && res.map.has(name)) {
        return { status: 200, buf: res.map.get(name) };
      }
      return res;
    });
  }

  const p = (async () => {
    let streamed = 0;
    if (!bg) beginDiskRead(name);
    const fetchStart = Date.now();
    const bundleUrl = glBundleUrl(bMeta.file);
    const rangeHeader = `bytes=${bMeta.off}-${bMeta.off + bMeta.len - 1}`;
    try {
      const init = { headers: { Range: rangeHeader } };
      if (signal) init.signal = signal;
      const response = await fetch(bundleUrl, init);
      if (!response.ok) {
        if (!bg) endDiskRead(false, 0, name, streamed, name);
        return { status: response.status, response };
      }
      const buf = await readBodyWithProgress(response, (delta) => {
        streamed += delta;
        if (!bg) progressDiskRead(delta);
      });

      // Fallback: upstream ignored Range and sent the full 200 bundle.
      if (response.status === 200 && buf.byteLength >= bMeta.off + bMeta.len) {
        const map = await unpackBundleBuffer(bMeta.file, buf, pathnamePrefix);
        noteThroughput(buf.byteLength, Math.max(1, Date.now() - fetchStart));
        if (!bg) {
          const unpackedNames = [name];
          for (const k of map.keys()) if (k !== name) unpackedNames.push(k);
          endDiskRead(true, buf.byteLength, unpackedNames, streamed, name);
        }
        const slice = map.get(name);
        if (slice) return { status: 200, buf: slice };
      }

      // Standard 206 Partial Content exact chunk slice.
      if (response.status === 206 && buf.byteLength === bMeta.len) {
        const cache = await caches.open(GL_DATA_CACHE).catch(() => null);
        if (cache) {
          const key = new Request(self.location.origin + pathnamePrefix + name, { method: "GET" });
          const resp = new Response(buf.slice(0), {
            status: 200,
            headers: {
              "Content-Type": "application/zstd",
              "Content-Length": String(buf.byteLength),
            },
          });
          await cache.put(key, resp).catch(() => {});
        }
        noteThroughput(buf.byteLength, Math.max(1, Date.now() - fetchStart));
        if (!bg) endDiskRead(true, buf.byteLength, name, streamed, name);
        return { status: 200, buf };
      }

      if (!bg) endDiskRead(false, 0, name, streamed, name);
      return { status: 502 };
    } catch (e) {
      if (!bg) endDiskRead(false, 0, name, streamed, name);
      return { status: 0, error: e, aborted: !!(e && e.name === "AbortError") };
    }
  })();

  if (!isIdle) {
    inflightChunks.set(name, p);
    p.finally(() => {
      if (inflightChunks.get(name) === p) inflightChunks.delete(name);
    });
  }
  return p;
}

function shouldUseRange(bMeta, idx) {
  if (!isSlowLink()) return false;
  const smallLimit = typeof GL_SMALL_BUNDLE_BYTES === "number"
    ? GL_SMALL_BUNDLE_BYTES
    : (96 * 1024);
  const bSize = (idx && idx.bundleSizes && idx.bundleSizes.get(bMeta.file)) || 0;
  if (bSize > 0 && bSize <= smallLimit) return false;
  return true;
}

/**
 * True ONLY when chunks-precache.json is loaded and does not contain `name`.
 * When unavailable, returns false (assume real; never paper over real data).
 */
async function isEmptyChunkName(name) {
  const set = realChunkSet || (await loadRealChunks());
  if (!set) return false;
  return !set.has(name);
}

/** Answer a HEAD from a cached GET entry. */
async function headFromCache(key, cacheNames) {
  for (const name of cacheNames) {
    const cache = await caches.open(name);
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) {
      const len = hit.headers.get("Content-Length");
      return new Response(null, {
        status: 200,
        statusText: "OK",
        headers: len ? { "Content-Length": len } : {},
      });
    }
  }
  return null;
}

function broadcast(msg) {
  self.clients.matchAll({ includeUncontrolled: true }).then((cs) => {
    for (const c of cs) c.postMessage(msg);
  }).catch(() => {});
}

/* ---------- disk activity reporting ---------- */

const diskActivity = {
  pending: 0, files: 0, bytes: 0, inflightBytes: 0, lastPost: 0,
  timer: null, settleTimer: null, recent: [], activeNames: new Set(),
  streamTotal: 0, streamWindow: [],
};
const BURST_SETTLE_MS = 250;
const PROGRESS_POST_MS = 200;
const STREAM_WINDOW_MS = 2500;

function computeLiveStreamBps(now) {
  const win = diskActivity.streamWindow;
  if (win.length < 2) return null;
  const cutoff = now - STREAM_WINDOW_MS;
  while (win.length > 2 && win[0].t < cutoff) win.shift();
  const first = win[0];
  const last = win[win.length - 1];
  const dt = (last.t - first.t) / 1000;
  const db = last.total - first.total;
  if (dt < 0.45 || db < 4096) return null;
  return db / dt;
}

function postDiskActivity() {
  const now = Date.now();
  diskActivity.lastPost = now;
  diskActivity.timer = null;
  const liveBps = computeLiveStreamBps(now);
  if (liveBps != null) {
    // If active download is streaming slower than our historical estimate,
    // immediately pull ewmaBps down mid-flight so slow-link Range mode engages right away.
    if (throughput.ewmaBps == null || liveBps < throughput.ewmaBps * 0.75) {
      throughput.ewmaBps = throughput.ewmaBps == null
        ? liveBps
        : (0.75 * liveBps + 0.25 * throughput.ewmaBps);
    }
  }
  const msg = {
    type: "disk-activity",
    pending: diskActivity.pending,
    files: diskActivity.files,
    bytes: diskActivity.bytes,
    inflightBytes: diskActivity.inflightBytes,
    names: diskActivity.recent,
    activeNames: Array.from(diskActivity.activeNames),
    liveBps,
    bps: effectiveBps(),
    mode: currentBandwidthMode(),
  };
  diskActivity.recent = [];
  broadcast(msg);
}

function scheduleDiskPost(force) {
  const since = Date.now() - diskActivity.lastPost;

  if (diskActivity.settleTimer) {
    clearTimeout(diskActivity.settleTimer);
    diskActivity.settleTimer = null;
  }
  if (diskActivity.pending === 0) {
    diskActivity.settleTimer = setTimeout(() => {
      diskActivity.settleTimer = null;
      diskActivity.lastPost = Date.now();
      diskActivity.inflightBytes = 0;
      diskActivity.activeNames.clear();
      diskActivity.streamWindow = [];
      broadcast({
        type: "disk-activity",
        pending: 0,
        files: diskActivity.files,
        bytes: diskActivity.bytes,
        inflightBytes: 0,
        names: [],
        activeNames: [],
        liveBps: null,
        bps: effectiveBps(),
        mode: currentBandwidthMode(),
        idle: true,
      });
    }, BURST_SETTLE_MS);
  }

  if (force || since >= PROGRESS_POST_MS) {
    if (diskActivity.timer) { clearTimeout(diskActivity.timer); diskActivity.timer = null; }
    postDiskActivity();
  } else if (!diskActivity.timer) {
    diskActivity.timer = setTimeout(postDiskActivity, PROGRESS_POST_MS - since);
  }
}

function beginDiskRead(name) {
  // Foreground disk reads immediately preempt any background idle warming.
  abortIdleWarm();
  if (diskActivity.pending === 0) {
    diskActivity.streamWindow = [{ t: Date.now(), total: diskActivity.streamTotal }];
  }
  diskActivity.pending++;
  if (name) diskActivity.activeNames.add(name);
  scheduleDiskPost(diskActivity.pending === 1);
}

function progressDiskRead(deltaBytes) {
  if (!(deltaBytes > 0)) return;
  diskActivity.inflightBytes += deltaBytes;
  diskActivity.streamTotal += deltaBytes;
  const now = Date.now();
  diskActivity.streamWindow.push({ t: now, total: diskActivity.streamTotal });
  if (diskActivity.streamWindow.length > 64) {
    diskActivity.streamWindow.splice(0, diskActivity.streamWindow.length - 64);
  }
  scheduleDiskPost(false);
}

function endDiskRead(counted, bytes, namesOrName, streamedBytes, activeName) {
  diskActivity.pending = Math.max(0, diskActivity.pending - 1);
  if (streamedBytes > 0) {
    diskActivity.inflightBytes = Math.max(0, diskActivity.inflightBytes - streamedBytes);
  }
  if (activeName) diskActivity.activeNames.delete(activeName);
  else if (typeof namesOrName === "string") diskActivity.activeNames.delete(namesOrName);

  if (counted) {
    diskActivity.files++;
    diskActivity.bytes += bytes || 0;
    if (Array.isArray(namesOrName)) {
      for (const n of namesOrName) {
        if (n && diskActivity.recent.length < 256) diskActivity.recent.push(n);
      }
    } else if (namesOrName && diskActivity.recent.length < 256) {
      diskActivity.recent.push(namesOrName);
    }
  }
  scheduleDiskPost(diskActivity.pending === 0);
}

/* ---------- throughput probe & adaptive bandwidth mode ---------- */

const throughput = { samples: 0, bytes: 0, ms: 0, ewmaBps: null, seededBps: null };

function noteThroughput(bytes, ms) {
  if (!(bytes > 0) || !(ms > 0)) return;
  const instantBps = bytes / (ms / 1000);
  throughput.samples++;
  throughput.bytes += bytes;
  throughput.ms += ms;
  // Ignore ultra-fast local HTTP disk cache hits (< 35 ms at > 10 MB/s) so they
  // never poison the WAN throughput estimate with fake 25-50 MB/s readings.
  if (ms < 35 && instantBps > 10 * 1024 * 1024) return;
  if (throughput.ewmaBps == null) {
    throughput.ewmaBps = instantBps;
  } else if (instantBps < throughput.ewmaBps) {
    // Drop quickly when connection slows down (asymmetric EWMA).
    throughput.ewmaBps = 0.75 * instantBps + 0.25 * throughput.ewmaBps;
  } else {
    throughput.ewmaBps = 0.35 * instantBps + 0.65 * throughput.ewmaBps;
  }
}

function seedThroughput(bps) {
  if (!(bps > 0) || !Number.isFinite(bps)) return;
  throughput.seededBps = bps;
  if (throughput.ewmaBps == null || bps < throughput.ewmaBps) {
    throughput.ewmaBps = bps;
  }
}

function measuredThroughput() {
  if (throughput.samples < 3 || throughput.ms <= 0) return null;
  return throughput.ewmaBps || (throughput.bytes / (throughput.ms / 1000));
}

function effectiveBps() {
  return throughput.ewmaBps || throughput.seededBps || null;
}

function isSlowLink() {
  if (bandwidthPref === "slow") return true;
  if (bandwidthPref === "fast") return false;
  const bps = effectiveBps();
  const threshold = typeof GL_SLOW_LINK_BPS === "number" ? GL_SLOW_LINK_BPS : (300 * 1024);
  if (bps != null) return bps < threshold;
  const conn = self.navigator && self.navigator.connection;
  if (conn) {
    if (conn.saveData) return true;
    if (/^(slow-2g|2g|3g)$/.test(conn.effectiveType || "")) return true;
    if (typeof conn.downlink === "number" && conn.downlink > 0 && conn.downlink < 2.5) return true;
  }
  return false;
}

function currentBandwidthMode() {
  return isSlowLink() ? "slow" : "fast";
}

async function isChunkCached(name, pathnamePrefix) {
  const key = new Request(self.location.origin + pathnamePrefix + name, { method: "GET" });
  for (const cname of [GL_PACK_CACHE, GL_DATA_CACHE]) {
    try {
      const c = await caches.open(cname);
      if (await c.match(key, { ignoreSearch: true })) return true;
    } catch (_) {}
  }
  return false;
}

async function warmChunkOne(name, opts) {
  await assetBaseReady;
  const pathnamePrefix = "/" + GL_CHUNK_PATH;
  if (await isChunkCached(name, pathnamePrefix)) return { cached: true };
  if (await isEmptyChunkName(name)) return { cached: true };
  const idx = await loadBundleIndex();
  const bMeta = idx && idx.chunkToBundle.get(name);
  if (!bMeta) return { missing: true };
  if (shouldUseRange(bMeta, idx)) {
    return fetchChunkRange(bMeta, name, pathnamePrefix, opts);
  }
  return fetchAndUnpackBundle(bMeta.file, name, pathnamePrefix, opts);
}

function drainToolWarmQueue() {
  while (toolWarmActive < 2 && toolWarmQueue.length > 0) {
    const name = toolWarmQueue.shift();
    if (!name) continue;
    toolWarmActive++;
    warmChunkOne(name, { background: true }).catch(() => {}).finally(() => {
      toolWarmActive--;
      if (toolWarmQueue.length > 0) drainToolWarmQueue();
    });
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  if (data.type === "get-throughput") {
    const bps = measuredThroughput();
    event.source && event.source.postMessage({
      type: "throughput",
      bps,
      effectiveBps: effectiveBps(),
      samples: throughput.samples,
      mode: currentBandwidthMode(),
      pref: bandwidthPref,
    });
    return;
  }

  if (data.type === "report-throughput") {
    seedThroughput(Number(data.bps));
    return;
  }

  if (data.type === "set-bandwidth-mode") {
    const m = data.mode;
    if (m === "auto" || m === "slow" || m === "fast") {
      bandwidthPref = m;
    }
    event.source && event.source.postMessage({
      type: "bandwidth-status",
      bps: effectiveBps(),
      mode: currentBandwidthMode(),
      pref: bandwidthPref,
    });
    return;
  }

  if (data.type === "get-bandwidth-status") {
    event.source && event.source.postMessage({
      type: "bandwidth-status",
      bps: effectiveBps(),
      mode: currentBandwidthMode(),
      pref: bandwidthPref,
    });
    return;
  }

  if (data.type === "abort-idle-warm") {
    abortIdleWarm();
    return;
  }

  if (data.type === "warm-chunks" && Array.isArray(data.names)) {
    const names = data.names.slice(0, 8);
    if (data.priority === "tool") {
      for (const n of names) {
        if (n && !toolWarmQueue.includes(n) && toolWarmQueue.length < 6) {
          toolWarmQueue.push(n);
        }
      }
      drainToolWarmQueue();
      return;
    }

    if (data.priority === "idle") {
      if (diskActivity.pending > 0) {
        event.source && event.source.postMessage({ type: "idle-warm-result", aborted: true });
        return;
      }
      abortIdleWarm();
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      idleWarmAbort = ctrl;
      event.waitUntil((async () => {
        let warmed = 0;
        let bytes = 0;
        let aborted = false;
        for (const n of names) {
          if ((ctrl && ctrl.signal.aborted) || diskActivity.pending > 0) {
            aborted = true;
            break;
          }
          const res = await warmChunkOne(n, {
            background: true,
            idle: true,
            signal: ctrl ? ctrl.signal : undefined,
          });
          if (res && res.aborted) { aborted = true; break; }
          if (res && res.status === 200) {
            warmed++;
            bytes += (res.buf && res.buf.byteLength) || res.totalBytes || 0;
          }
        }
        if (idleWarmAbort === ctrl) idleWarmAbort = null;
        event.source && event.source.postMessage({
          type: "idle-warm-result",
          warmed,
          bytes,
          aborted,
          bps: effectiveBps(),
          mode: currentBandwidthMode(),
        });
      })());
    }
  }
});

/* ---------- fetch handler ---------- */

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Pack downloads carry ?gl_pack=1 so they go straight to GL_PACK_CACHE
  // without being double-cached in GL_DATA_CACHE or triggering disk-activity.
  if (url.searchParams.has("gl_pack")) return;

  const sameOrigin = url.origin === self.location.origin;
  const isChunk = CHUNK_RE.test(url.pathname);
  const isPackList = /\/packs\//.test(url.pathname);

  // Never cache pack/tool JSON lists in GL_SHELL_CACHE: let browser/CDN honor
  // R2's Cache-Control (or the caller's cache: "no-store").
  if (isPackList) return;

  if (!sameOrigin && !isChunk) return;

  if (request.headers.has("range")) return;

  if (request.method === "HEAD") {
    if (isChunk) {
      event.respondWith((async () => {
        await assetBaseReady;
        const cacheKey = new Request(self.location.origin + url.pathname, { method: "GET" });
        const hit = await headFromCache(cacheKey, [GL_PACK_CACHE, GL_DATA_CACHE]);
        if (hit) return hit;

        const name = url.pathname.split("/").pop();
        if (await isEmptyChunkName(name)) {
          const emptyHead = await getEmptyChunkResponse(true);
          if (emptyHead) return emptyHead;
        }
        const idx = await loadBundleIndex();
        const bMeta = idx && idx.chunkToBundle.get(name);
        if (bMeta) {
          return new Response(null, {
            status: 200,
            statusText: "OK",
            headers: { "Content-Length": String(bMeta.len) },
          });
        }

        const upstream = GL_ASSET_BASE ? GL_ASSET_BASE + url.pathname : request.url;
        try {
          return await fetch(upstream, { method: "HEAD" });
        } catch (e) {
          return new Response(null, { status: 408, statusText: "offline" });
        }
      })());
      return;
    }
    event.respondWith((async () => {
      const hit = await headFromCache(request.url, [GL_DATA_CACHE, GL_SHELL_CACHE]);
      if (hit) return hit;
      try {
        return await fetch(request);
      } catch (e) {
        return new Response(null, { status: 404 });
      }
    })());
    return;
  }

  if (request.method !== "GET") return;

  // Disk chunks
  if (isChunk) {
    event.respondWith((async () => {
      await assetBaseReady;

      const cacheKey = new Request(self.location.origin + url.pathname, { method: "GET" });
      for (const cname of [GL_PACK_CACHE, GL_DATA_CACHE]) {
        const cache = await caches.open(cname);
        const hit = await cache.match(cacheKey, { ignoreSearch: true });
        if (hit) return hit;
      }

      const name = url.pathname.split("/").pop();
      const pathnamePrefix = url.pathname.slice(0, url.pathname.length - name.length);

      // Step 1: Short-circuit known-empty chunks locally BEFORE any network
      // fetch — 0 ms latency and 0 R2 404 Class B operations (resilient even
      // if Cache Storage was wiped mid-session).
      if (await isEmptyChunkName(name)) {
        const empty = await getEmptyChunkResponse(false);
        if (empty) return empty;
      }

      // Step 2: Adaptive bundle/range fetch — on slow links (< ~2.4 Mbps or
      // Save-Data) fetch ONLY the exact chunk byte range (206 Partial Content)
      // from the .pack bundle to avoid 2x-18x over-fetching; on fast links or
      // tiny bundles (<= 96 KB) fetch and unpack the whole .pack bundle once.
      const idx = await loadBundleIndex();
      const bMeta = idx && idx.chunkToBundle.get(name);
      if (bMeta) {
        if (shouldUseRange(bMeta, idx)) {
          const res = await fetchChunkRange(bMeta, name, pathnamePrefix);
          if (res.status === 200 && res.buf) {
            return new Response(res.buf, {
              status: 200,
              headers: {
                "Content-Type": "application/zstd",
                "Content-Length": String(res.buf.byteLength),
              },
            });
          }
          if (res.status === 404) {
            broadcast({ type: "chunk-missing-real", url: request.url, name });
            return new Response("", { status: 404, statusText: "bundle missing" });
          }
          if (res.status === 0) {
            broadcast({ type: "chunk-offline", url: request.url, name });
            return new Response("", { status: 408, statusText: "bundle unavailable offline" });
          }
          return res.response || new Response("", { status: res.status || 502 });
        }

        const res = await fetchAndUnpackBundle(bMeta.file, name, pathnamePrefix);
        if (res.status === 200 && res.map && res.map.has(name)) {
          const slice = res.map.get(name);
          return new Response(slice, {
            status: 200,
            headers: {
              "Content-Type": "application/zstd",
              "Content-Length": String(slice.byteLength),
            },
          });
        }
        if (res.status === 404) {
          broadcast({ type: "chunk-missing-real", url: request.url, name });
          return new Response("", { status: 404, statusText: "bundle missing" });
        }
        if (res.status === 0) {
          broadcast({ type: "chunk-offline", url: request.url, name });
          return new Response("", { status: 408, statusText: "bundle unavailable offline" });
        }
        return res.response || new Response("", { status: res.status || 502 });
      }

      // Fallback: direct single-chunk fetch (used only when bundles.json is absent).
      const upstream = GL_ASSET_BASE ? GL_ASSET_BASE + url.pathname : request;
      beginDiskRead(name);
      const fetchStart = Date.now();
      try {
        const response = await fetch(upstream);
        if (response.ok) {
          const cache = await caches.open(GL_DATA_CACHE);
          cache.put(cacheKey, response.clone()).catch(() => {});
          const len = Number(response.headers.get("Content-Length")) || 0;
          noteThroughput(len, Math.max(1, Date.now() - fetchStart));
          endDiskRead(true, len, name, 0, name);
          return response;
        }
        endDiskRead(false, 0, name, 0, name);
        if (response.status === 404) {
          const knownEmpty = await isEmptyChunkName(name);
          if (knownEmpty) {
            const empty = await getEmptyChunkResponse(false);
            if (empty) return empty;
          }
          broadcast({ type: "chunk-missing-real", url: request.url, name });
          return new Response("", { status: 404, statusText: "chunk missing" });
        }
        return response;
      } catch (e) {
        // Offline / network failure.
        endDiskRead(false, 0, name, 0, name);
        const knownEmpty = await isEmptyChunkName(name);
        if (knownEmpty) {
          const empty = await getEmptyChunkResponse(false);
          if (empty) return empty;
        }
        broadcast({ type: "chunk-offline", url: request.url, name });
        return new Response("", { status: 408, statusText: "chunk unavailable offline" });
      }
    })());
    return;
  }

  // Build id must never be served from cache.
  if (url.pathname.endsWith("build-id.json")) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response("{}", { headers: { "Content-Type": "application/json" } })
      )
    );
    return;
  }

  // Snapshot / kernel / initrd: cached on first load in GL_DATA_CACHE (versioned
  // by GL_VERSION). Always fetch with cache:"reload" on miss so the browser's
  // HTTP disk cache can never poison a new GL_DATA_CACHE with an old image.
  if (url.pathname.endsWith(GL_SNAPSHOT_URL) ||
      url.pathname.endsWith("/images/debian-bzImage") ||
      url.pathname.endsWith("/images/debian-initrd")) {
    event.respondWith((async () => {
      const cache = await caches.open(GL_DATA_CACHE);
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;
      const response = await fetch(new Request(request.url, { method: request.method, cache: "reload" }));
      if (response.ok && request.method === "GET") {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })());
    return;
  }

  // HTML navigations: network-first with cache fallback so code deploys appear
  // immediately on reload while keeping full offline support.
  if (request.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith("/index.html") || url.pathname.endsWith("/terminal.html")) {
    event.respondWith((async () => {
      const shell = await caches.open(GL_SHELL_CACHE);
      try {
        const response = await fetch(request);
        if (response.ok) shell.put(request, response.clone()).catch(() => {});
        return response;
      } catch (e) {
        const hit = await shell.match(request, { ignoreSearch: true })
          || await shell.match("./", { ignoreSearch: true });
        if (hit) return hit;
        throw e;
      }
    })());
    return;
  }

  // Static app shell assets: cache-first (invalidated by GL_VERSION bump).
  event.respondWith((async () => {
    const shell = await caches.open(GL_SHELL_CACHE);
    const hit = await shell.match(request, { ignoreSearch: true });
    if (hit) return hit;
    const response = await fetch(request);
    if (response.ok) shell.put(request, response.clone()).catch(() => {});
    return response;
  })());
});
