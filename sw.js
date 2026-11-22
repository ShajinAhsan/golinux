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
const CHUNK_RE = /\/debian-chunks\/chunk-\d+-\d+\.zst$/;

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
    // Keep only this build's caches. Chunk caches are namespaced by GL_VERSION
    // and the URLs carry GL_BUILD_ID, so stale entries for another build can
    // never be served - but deleting them reclaims space.
    const keep = new Set([GL_SHELL_CACHE, GL_DATA_CACHE, GL_PACK_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(n => !keep.has(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// The page tells us where chunks live (it owns the ?assets= override).
self.addEventListener("message", event => {
  if (event.data && event.data.type === "set-asset-base") {
    glSetAssetBase(event.data.base);
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
    // Cache key ignores the origin so a chunk fetched from R2 and one requested
    // same-origin are the same entry. Rewriting happens only for the network
    // fetch; the cache is keyed by the same-origin path.
    const cacheKey = (GL_ASSET_BASE && sameOrigin)
      ? new Request(self.location.origin + url.pathname, { method: "GET" })
      : request;
    const upstream = (GL_ASSET_BASE && sameOrigin)
      ? GL_ASSET_BASE + url.pathname
      : request;

    event.respondWith((async () => {
      for (const name of [GL_PACK_CACHE, GL_DATA_CACHE]) {
        const cache = await caches.open(name);
        const hit = await cache.match(cacheKey, { ignoreSearch: true });
        if (hit) return hit;
      }

      try {
        const response = await fetch(upstream);
        if (response.ok) {
          const cache = await caches.open(GL_DATA_CACHE);
          cache.put(cacheKey, response.clone()).catch(() => {});
          return response;
        }

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
