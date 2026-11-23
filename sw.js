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

/* ---------- real chunk manifest ---------- */

let realChunkSet = null;
let realChunkPromise = null;

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
  pending: 0, files: 0, bytes: 0, lastPost: 0,
  timer: null, settleTimer: null, recent: [],
};
const BURST_SETTLE_MS = 250;

function postDiskActivity() {
  diskActivity.lastPost = Date.now();
  diskActivity.timer = null;
  const msg = {
    type: "disk-activity",
    pending: diskActivity.pending,
    files: diskActivity.files,
    bytes: diskActivity.bytes,
    names: diskActivity.recent,
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
      broadcast({
        type: "disk-activity",
        pending: 0,
        files: diskActivity.files,
        bytes: diskActivity.bytes,
        names: [],
        idle: true,
      });
    }, BURST_SETTLE_MS);
  }

  if (force || since >= 250) {
    if (diskActivity.timer) { clearTimeout(diskActivity.timer); diskActivity.timer = null; }
    postDiskActivity();
  } else if (!diskActivity.timer) {
    diskActivity.timer = setTimeout(postDiskActivity, 250 - since);
  }
}

function beginDiskRead() {
  diskActivity.pending++;
  scheduleDiskPost(false);
}

function endDiskRead(counted, bytes, name) {
  diskActivity.pending = Math.max(0, diskActivity.pending - 1);
  if (counted) {
    diskActivity.files++;
    diskActivity.bytes += bytes || 0;
    if (name && diskActivity.recent.length < 256) diskActivity.recent.push(name);
  }
  scheduleDiskPost(diskActivity.pending === 0);
}

/* ---------- throughput probe ---------- */

const throughput = { samples: 0, bytes: 0, ms: 0 };

function noteThroughput(bytes, ms) {
  if (throughput.samples >= 10) return;
  if (!(bytes > 0) || !(ms > 0)) return;
  throughput.samples++;
  throughput.bytes += bytes;
  throughput.ms += ms;
}

function measuredThroughput() {
  if (throughput.samples < 3 || throughput.ms <= 0) return null;
  return throughput.bytes / (throughput.ms / 1000);
}

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "get-throughput") {
    const bps = measuredThroughput();
    event.source && event.source.postMessage({
      type: "throughput",
      bps,
      samples: throughput.samples,
    });
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
      const upstream = GL_ASSET_BASE ? GL_ASSET_BASE + url.pathname : request;

      for (const name of [GL_PACK_CACHE, GL_DATA_CACHE]) {
        const cache = await caches.open(name);
        const hit = await cache.match(cacheKey, { ignoreSearch: true });
        if (hit) return hit;
      }

      beginDiskRead();
      const fetchStart = Date.now();
      const name = url.pathname.split("/").pop();
      try {
        const response = await fetch(upstream);
        if (response.ok) {
          const cache = await caches.open(GL_DATA_CACHE);
          cache.put(cacheKey, response.clone()).catch(() => {});
          const len = Number(response.headers.get("Content-Length")) || 0;
          noteThroughput(len, Date.now() - fetchStart);
          endDiskRead(true, len, name);
          return response;
        }
        endDiskRead(false, 0);
        if (response.status === 404) {
          const knownEmpty = await isEmptyChunkName(name);
          if (knownEmpty) {
            const shell = await caches.open(GL_SHELL_CACHE);
            const empty = await shell.match(GL_EMPTY_CHUNK_PATH, { ignoreSearch: true });
            if (empty) return empty;
          }
          broadcast({ type: "chunk-missing-real", url: request.url, name });
          return new Response("", { status: 404, statusText: "chunk missing" });
        }
        return response;
      } catch (e) {
        // Offline / network failure.
        endDiskRead(false, 0);
        const knownEmpty = await isEmptyChunkName(name);
        if (knownEmpty) {
          const shell = await caches.open(GL_SHELL_CACHE);
          const empty = await shell.match(GL_EMPTY_CHUNK_PATH, { ignoreSearch: true });
          if (empty) return empty;
        }
        // Real chunk unavailable offline: tell the page to show the offline
        // banner (NOT "out of date") and return 408 (outside 5xx so v86 does
        // not spin an infinite background retry loop).
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

  // Snapshot: cached on first load in GL_DATA_CACHE (versioned by GL_VERSION).
  if (url.pathname.endsWith(GL_SNAPSHOT_URL)) {
    event.respondWith((async () => {
      const cache = await caches.open(GL_DATA_CACHE);
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    })());
    return;
  }

  // HTML navigations: network-first with cache fallback so code deploys appear
  // immediately on reload while keeping full offline support.
  if (request.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith("/index.html")) {
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
