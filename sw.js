/* GoLinux service worker.
 *
 * How v86 loads things (verified in src/lib.js and against real traffic):
 *   - It uses XMLHttpRequest, not fetch. XHR still passes through this handler.
 *   - Disk chunks (use_parts) are individual files, fetched with a plain GET.
 *     No Range header is sent, because every chunk is its own URL. Range is only
 *     used for a single-file image read at offsets, which we do not use.
 *   - The snapshot is a plain GET, preceded by a HEAD probe.
 *
 * Download policy:
 *   - First load caches only the app shell + the snapshot. Nothing else.
 *   - Disk chunks are cached on demand as the guest reads them.
 *   - Larger packs are installed only when the user asks (see packs.js).
 */

importScripts("packs-config.js");

const SHELL_FILES = [
  "./",
  "index.html",
  "about.html",
  "manifest.json",
  "packs-config.js",
  "packs.js",
  "persist.js",
  "persist-9p.js",
  "assets/v86/libv86.js",
  "assets/v86/v86.wasm",
  "assets/v86/v86-fallback.wasm",
  "assets/xterm/xterm.js",
  "assets/xterm/addon-fit.js",
  "assets/xterm/xterm.css",
  "assets/bios/seabios.bin",
  "assets/bios/vgabios.bin",
  "images/debian-bzImage",
  "images/debian-initrd",
  "assets/empty-chunk.zst",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

// Chunks may live on another origin; match by path, not by full URL.
// NOTE: production URLs include the build id segment
// (…/debian-chunks/<buildId>/chunk-….zst). Without the optional segment below,
// this regex only matched local dev's flat paths, so production chunk requests
// fell through to the shell handler and 404ed against Pages instead of being
// proxied to GL_ASSET_BASE.
const CHUNK_RE = /\/debian-chunks\/(?:[^/]+\/)?chunk-\d+-\d+\.zst$/;

/* The ?assets= override is a LOCAL-only switch and must survive the worker
 * restarting (a worker with no activity is torn down; its memory is lost).
 * Persist it in CacheStorage so the base never silently reverts to the
 * production constant mid-session. */
const GL_CONFIG_CACHE = "golinux-config";
const GL_ASSET_OVERRIDE_KEY = "asset-base-override";

let assetBaseReady = (async () => {
  try {
    const cache = await caches.open(GL_CONFIG_CACHE);
    const hit = await cache.match(GL_ASSET_OVERRIDE_KEY);
    if (hit) {
      const base = await hit.text();
      if (base) glSetAssetBase(base);
    }
  } catch (e) { /* no persisted override */ }
})();

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(GL_SHELL_CACHE);
    // Add files individually. cache.addAll() is atomic: one failed request
    // rejects the whole batch and leaves the shell cache EMPTY, which then
    // breaks the app offline even though every other file was fine.
    const results = await Promise.allSettled(
      SHELL_FILES.map(f => cache.add(new Request(f, { cache: "reload" }))));

    const failed = results
      .map((r, i) => (r.status === "rejected" ? SHELL_FILES[i] : null))
      .filter(Boolean);

    if (failed.length) {
      console.warn("service worker: could not precache", failed);
      // Only fail the install if a boot-critical file is missing. A nice-to-have
      // that 404s must not take the whole offline mode down with it.
      const critical = failed.filter(f => !f.endsWith("empty-chunk.zst"));
      if (critical.length) throw new Error("precache failed: " + critical.join(", "));
    }

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    // Keep this build's caches, plus the config cache that stores the local
    // ?assets= override. Chunk caches are namespaced by GL_VERSION and the URLs
    // carry GL_BUILD_ID, so stale entries for another build can never be
    // served - but deleting them reclaims space.
    const keep = new Set([GL_SHELL_CACHE, GL_DATA_CACHE, GL_PACK_CACHE,
                          GL_CONFIG_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(n => !keep.has(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// The page tells us where chunks live (it owns the ?assets= override).
// Persisted so it survives the worker being torn down and restarted.
self.addEventListener("message", event => {
  if (event.data && event.data.type === "set-asset-base") {
    const base = glSetAssetBase(event.data.base);
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(GL_CONFIG_CACHE);
        if (base) {
          await cache.put(GL_ASSET_OVERRIDE_KEY,
            new Response(base, { headers: { "Content-Type": "text/plain" } }));
        } else {
          await cache.delete(GL_ASSET_OVERRIDE_KEY);
        }
      } catch (e) { /* non-fatal: the in-memory value still applies */ }
    })());
  }
});

/* Which chunk names hold real data for this build.
 *
 * chunks-precache.json is the authoritative list of real chunks. Anything not
 * in it is a zeroed region (35,358 of 40,960), which the guest only ever reads
 * as zeros, so a 404 for such a name can safely be answered with the empty
 * template. A 404 for a name that IS in the list is data loss and must be
 * surfaced, never hidden. */
let realChunkSet = null;
let realChunkPromise = null;

function loadRealChunks() {
  if (realChunkPromise) return realChunkPromise;
  realChunkPromise = (async () => {
    try {
      const res = await fetch("chunks-precache.json", { cache: "no-store" });
      if (!res.ok) return null;
      const list = await res.json();
      realChunkSet = new Set(list);
      return realChunkSet;
    } catch (e) {
      return null;
    }
  })();
  return realChunkPromise;
}

/**
 * True when this chunk name is a known zeroed region.
 * Returns false when the list is unavailable: without evidence, assume it is
 * real and show the error rather than silently serve zeros.
 */
async function isEmptyChunkName(name) {
  const set = realChunkSet || (await loadRealChunks());
  if (!set) return false;
  return !set.has(name);
}

/** Answer a HEAD from a cached GET entry, so v86's snapshot probe works offline. */
async function headFromCache(url) {
  for (const name of [GL_DATA_CACHE, GL_SHELL_CACHE]) {
    const cache = await caches.open(name);
    const hit = await cache.match(url, { ignoreSearch: true });
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

/* ---------- disk activity, for the "Loading from disk…" indicator ----------
 *
 * The worker sees every chunk fetch, so it is the only place that can report
 * disk activity accurately. It counts in-flight chunk requests and their bytes
 * and posts a summary to the page, throttled, so the toolbar can show
 * "Loading from disk… N files, X MB".
 *
 * Nothing here types into the guest: this is a postMessage to the page chrome.
 * The PAGE decides when to show anything (it waits 500 ms so short loads never
 * flash), so a fast disk read produces no UI at all.
 */
const diskActivity = { pending: 0, files: 0, bytes: 0, lastPost: 0, timer: null,
  settleTimer: null, recent: [] };

function postDiskActivity() {
  diskActivity.lastPost = Date.now();
  diskActivity.timer = null;
  const msg = {
    type: "disk-activity",
    pending: diskActivity.pending,
    files: diskActivity.files,
    bytes: diskActivity.bytes,
    // Names fetched since the last post, so the page can tell which tool's set
    // this activity belongs to. Bounded: it is only a hint for labelling.
    names: diskActivity.recent,
  };
  diskActivity.recent = [];
  self.clients.matchAll({ includeUncontrolled: true }).then(cs => {
    for (const c of cs) c.postMessage(msg);
  }).catch(() => {});
}

/**
 * Coalesce to at most one message per 250 ms, and always send a final
 * BURST-END message once things go quiet.
 *
 * The idle signal cannot be inferred from pending===0 alone: the last post of a
 * burst still carries newly-arrived files, so it looks busy. The page needs an
 * unambiguous "the burst is over" event, which is sent here after a short
 * settle delay with no new activity.
 */
const BURST_SETTLE_MS = 250;

function scheduleDiskPost(force) {
  const since = Date.now() - diskActivity.lastPost;

  // Any activity restarts the settle timer.
  if (diskActivity.settleTimer) {
    clearTimeout(diskActivity.settleTimer);
    diskActivity.settleTimer = null;
  }
  if (diskActivity.pending === 0) {
    diskActivity.settleTimer = setTimeout(() => {
      diskActivity.settleTimer = null;
      diskActivity.lastPost = Date.now();
      self.clients.matchAll({ includeUncontrolled: true }).then(cs => {
        for (const c of cs) {
          c.postMessage({
            type: "disk-activity",
            pending: 0,
            files: diskActivity.files,
            bytes: diskActivity.bytes,
            names: [],
            idle: true,
          });
        }
      }).catch(() => {});
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
/** @param counted true once the chunk's bytes are known (cache hit or fetch). */
function endDiskRead(counted, bytes, name) {
  diskActivity.pending = Math.max(0, diskActivity.pending - 1);
  if (counted) {
    diskActivity.files++;
    diskActivity.bytes += bytes || 0;
    // Remember which chunk this was, for per-tool labelling. Cap the list so a
    // long compile cannot grow it without bound between posts.
    if (name && diskActivity.recent.length < 256) diskActivity.recent.push(name);
  }
  // The final "idle" message must always go out, or the indicator never hides.
  scheduleDiskPost(diskActivity.pending === 0);
}

/* ---------- throughput probe, for deciding whether to prefetch ----------
 *
 * navigator.connection.effectiveType is Chromium-only, so prefetch cannot be
 * gated on it. Instead measure what actually arrives: time the first few real
 * chunk downloads in the worker and derive bytes/second. The page reads this
 * with {type:"get-throughput"} when it is considering a prefetch.
 *
 * Only successful network fetches count. Cache hits cost nothing and would
 * make a slow link look fast.
 */
const throughput = { samples: 0, bytes: 0, ms: 0 };

function noteThroughput(bytes, ms) {
  if (throughput.samples >= 10) return;   // enough to judge; stop measuring
  if (!(bytes > 0) || !(ms > 0)) return;
  throughput.samples++;
  throughput.bytes += bytes;
  throughput.ms += ms;
}

/** Estimated bytes/second, or null while there is not enough evidence yet. */
function measuredThroughput() {
  if (throughput.samples < 3 || throughput.ms <= 0) return null;
  return throughput.bytes / (throughput.ms / 1000);
}

self.addEventListener("message", event => {
  if (event.data && event.data.type === "get-throughput") {
    const bps = measuredThroughput();
    event.source && event.source.postMessage({
      type: "throughput",
      bps,
      samples: throughput.samples,
    });
  }
});

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);

  // Chunks arrive as SAME-ORIGIN paths (v86's use_parts cannot handle an
  // absolute cross-origin URL; see packs-config.js) and this worker forwards
  // them to GL_ASSET_BASE. Pack downloads may be absolute already.
  const sameOrigin = url.origin === self.location.origin;
  const isAsset = /\/debian-chunks\/|\/packs\//.test(url.pathname);
  if (!sameOrigin && !isAsset) return;

  // v86 does not send Range requests in this configuration. If one appears,
  // pass it through untouched rather than returning a cached whole body.
  if (request.headers.has("range")) return;

  if (request.method === "HEAD") {
    // Chunk HEADs must also reach the asset origin, never Pages.
    if (CHUNK_RE.test(url.pathname)) {
      event.respondWith((async () => {
        await assetBaseReady;
        const upstream = GL_ASSET_BASE
          ? GL_ASSET_BASE + url.pathname
          : request;
        try {
          return await fetch(upstream);
        } catch (e) {
          return new Response(null, { status: 404 });
        }
      })());
      return;
    }
    event.respondWith((async () => {
      const hit = await headFromCache(request.url);
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

  // Disk chunks: serve from any cache that has them (installed pack or
  // on-demand), else fetch and cache on demand. Offline misses fall back to the
  // empty chunk so v86's unbounded retry loop cannot hang the guest.
  if (CHUNK_RE.test(url.pathname)) {
    event.respondWith((async () => {
      // Wait for the persisted ?assets= override (if any) before deciding where
      // to fetch from, or a restarted worker would send this chunk to the
      // production origin.
      await assetBaseReady;

      // Cache key ignores the origin so a chunk fetched from R2 and one
      // requested same-origin are the same entry. The cache is always keyed by
      // the same-origin path.
      const cacheKey = new Request(self.location.origin + url.pathname,
                                   { method: "GET" });
      // ALWAYS fetch chunks from the asset origin when one is configured - not
      // only when the request arrived same-origin. Otherwise a request that
      // somehow bypassed the rewrite (or a stale absolute URL) would hit Pages.
      const upstream = GL_ASSET_BASE
        ? GL_ASSET_BASE + url.pathname
        : request;

      for (const name of [GL_PACK_CACHE, GL_DATA_CACHE]) {
        const cache = await caches.open(name);
        const hit = await cache.match(cacheKey, { ignoreSearch: true });
        if (hit) {
          // A cache hit costs no network, so it is not reported as disk loading.
          return hit;
        }
      }

      beginDiskRead();
      const fetchStart = Date.now();
      try {
        const response = await fetch(upstream);
        if (response.ok) {
          const cache = await caches.open(GL_DATA_CACHE);
          cache.put(cacheKey, response.clone()).catch(() => {});
          const len = Number(response.headers.get("Content-Length")) || 0;
          // Throughput evidence for the prefetch decision (network only).
          noteThroughput(len, Date.now() - fetchStart);
          endDiskRead(true, len, url.pathname.split("/").pop());
          return response;
        }
        endDiskRead(false, 0);
        // A 404 is only safe to paper over when the chunk is KNOWN to be a
        // zeroed region. Substituting zeros for a real data chunk would feed
        // the guest corrupt binaries, which is exactly the bug this guards
        // against - a wipe of real data must be loud, not silent.
        if (response.status === 404) {
          const name = url.pathname.split("/").pop();
          const knownEmpty = await isEmptyChunkName(name);
          if (knownEmpty) {
            const shell = await caches.open(GL_SHELL_CACHE);
            const empty = await shell.match(GL_EMPTY_CHUNK_PATH, { ignoreSearch: true });
            if (empty) return empty;
          }
          // Real chunk missing: tell the page to show "outdated, reload" and
          // fail the request, so v86's retry loop stops instead of hanging.
          self.clients.matchAll({ includeUncontrolled: true }).then(cs => {
            for (const c of cs) c.postMessage({ type: "chunk-missing-real", url: request.url, name });
          }).catch(() => {});
          return new Response("", { status: 404, statusText: "chunk missing" });
        }
        return response;
      } catch (e) {
        // Offline (or the host is unreachable) and this chunk is not cached.
        // Same rule as the 404 path: zeros are only substituted for names that
        // are known zeroed regions. For a real data chunk, serving zeros would
        // corrupt the guest silently, so report it instead and let the page
        // tell the user to reconnect or install an offline pack.
        // Release the activity counter too, or a failed read would leave the
        // "Loading from disk…" indicator stuck on forever.
        endDiskRead(false, 0);
        const name = url.pathname.split("/").pop();
        const knownEmpty = await isEmptyChunkName(name);

        self.clients.matchAll({ includeUncontrolled: true }).then(cs => {
          for (const c of cs) {
            c.postMessage({
              type: knownEmpty ? "chunk-miss" : "chunk-missing-real",
              url: request.url,
              name,
            });
          }
        }).catch(() => {});

        if (knownEmpty) {
          const shell = await caches.open(GL_SHELL_CACHE);
          const empty = await shell.match(GL_EMPTY_CHUNK_PATH, { ignoreSearch: true });
          if (empty) return empty;
        }
        return new Response("", { status: 503, statusText: "chunk unavailable offline" });
      }
    })());
    return;
  }

  // Build id must never be served from cache: it is how the page detects that
  // the shipped image changed and a saved user state is no longer compatible.
  if (url.pathname.endsWith("build-id.json")) {
    event.respondWith(fetch(request).catch(() =>
      new Response("{}", { headers: { "Content-Type": "application/json" } })));
    return;
  }

  // Snapshot: cached on first load, then always served from cache.
  if (url.pathname.endsWith(GL_SNAPSHOT_URL)) {
    event.respondWith((async () => {
      const cache = await caches.open(GL_DATA_CACHE);
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })());
    return;
  }

  // App shell and navigations.
  event.respondWith((async () => {
    const shell = await caches.open(GL_SHELL_CACHE);
    const hit = await shell.match(request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const response = await fetch(request);
      if (response.ok) shell.put(request, response.clone()).catch(() => {});
      return response;
    } catch (e) {
      if (request.mode === "navigate") {
        const fallback = await shell.match("./", { ignoreSearch: true });
        if (fallback) return fallback;
      }
      throw e;
    }
  })());
});
