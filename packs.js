/* Offline pack store.
 *
 * Design rules:
 *   1. THE CACHE IS THE SOURCE OF TRUTH (no localStorage "installed" flag).
 *   2. ONE JOB AT A TIME, ACROSS TABS (Web Lock golinux-pack-job).
 *   3. CANCEL AWAITS CLEANUP before removePack()/useMinimal() acquire the lock.
 *   4. BROADCAST NEVER ECHOES (receiver redraws locally without re-broadcasting).
 *   5. PACK FETCHES USE ?gl_pack=1 so sw.js never double-caches into GL_DATA_CACHE.
 *   6. QUOTA ERRORS ABORT IMMEDIATELY instead of burning bandwidth on 5,600 retries.
 */
(function () {
  "use strict";

  const PACKS = [
    { id: "minimal", label: "Minimal", file: null,
      desc: "Snapshot only — boots instantly. No extra tools cached." },
    { id: "common", label: "Common tools", file: "common.json",
      desc: "ls, nano, git, gcc, g++, make, man" },
    { id: "full", label: "Full", file: "full.json",
      desc: "Every data chunk of the disk image." },
  ];
  const REAL_PACKS = ["common", "full"];

  const JOB_LOCK = "golinux-pack-job";
  const BC_NAME = "golinux-packs";

  let manifest = {};
  let lists = {};
  let bundleIndexCache = undefined; // undefined=unloaded, null=unavailable, object=loaded
  let onUpdate = () => {};
  let job = null;
  let activeJobPromise = null;
  let abort = null;
  let lastStates = null;
  let channel = null;
  try { channel = new BroadcastChannel(BC_NAME); } catch (e) { /* unsupported */ }

  /* ---------------- cache helpers ---------------- */

  const keyFor = (name) => location.origin + "/" + GL_CHUNK_PATH + name;

  async function openPackCache() { return caches.open(GL_PACK_CACHE); }

  async function cachedUrlSet() {
    const cache = await openPackCache();
    return new Set((await cache.keys()).map((k) => k.url));
  }

  async function loadBundleIndex() {
    if (bundleIndexCache !== undefined) return bundleIndexCache;
    try {
      if (typeof glBundleUrl !== "function") {
        bundleIndexCache = null;
        return null;
      }
      const r = await fetch("bundles.json");
      if (!r.ok) {
        bundleIndexCache = null;
        return null;
      }
      const data = await r.json();
      if (!data || !Array.isArray(data.files) || !Array.isArray(data.entries)) {
        bundleIndexCache = null;
        return null;
      }
      const chunkSize = Number(data.chunkSize) || (128 * 1024);
      const chunkToBundle = new Map();
      const bundleCounts = new Map();
      const bundleSizes = new Map();
      for (const f of data.files) {
        bundleCounts.set(f, 0);
        bundleSizes.set(f, 0);
      }
      for (const row of data.entries) {
        const [idx, fileIdx, off, len] = row;
        const file = data.files[fileIdx];
        if (!file) continue;
        const start = idx * chunkSize;
        const name = `chunk-${start}-${start + chunkSize}.zst`;
        chunkToBundle.set(name, { file, off, len });
        bundleCounts.set(file, (bundleCounts.get(file) || 0) + 1);
        if (off + len > (bundleSizes.get(file) || 0)) bundleSizes.set(file, off + len);
      }
      bundleIndexCache = { chunkToBundle, bundleCounts, bundleSizes };
      return bundleIndexCache;
    } catch (e) {
      bundleIndexCache = null;
      return null;
    }
  }

  async function loadManifest() {
    if (Object.keys(manifest).length) return manifest;
    try {
      const r = await fetch(glPackUrl("index.json"), { cache: "no-store" });
      if (r.ok) manifest = await r.json();
      else console.warn("pack index unavailable (offline?)");
    } catch (e) { /* offline */ }
    return manifest;
  }

  async function loadList(id) {
    if (lists[id]) return lists[id];
    const meta = PACKS.find((p) => p.id === id);
    if (!meta || !meta.file) return [];
    const r = await fetch(glPackUrl(meta.file), { cache: "no-store" });
    if (!r.ok) throw new Error("could not load the " + id + " pack list");
    const parsed = await r.json();
    if (!Array.isArray(parsed)) throw new Error("invalid pack list for " + id);
    lists[id] = parsed;
    return lists[id];
  }

  /* ---------------- state, derived from the cache ---------------- */

  async function packStates() {
    const cached = await cachedUrlSet();
    const out = {};
    for (const id of REAL_PACKS) {
      let total = 0, present = 0;
      try {
        const names = await loadList(id);
        total = names.length;
        for (const n of names) if (cached.has(keyFor(n))) present++;
      } catch (e) {
        total = (manifest[id] && manifest[id].chunks) || 0;
        present = 0;
      }
      out[id] = {
        id, present, total,
        complete: total > 0 && present >= total,
        started: present > 0 && present < total,
      };
    }
    out.minimal = {
      id: "minimal", present: 0, total: 0,
      complete: !out.common.complete && !out.full.complete,
      started: false,
    };
    lastStates = out;
    return out;
  }

  function jobSnapshot() {
    return job ? { ...job } : null;
  }

  async function emit(opts) {
    const broadcast = !(opts && opts.broadcast === false);
    const recompute = !(opts && opts.recompute === false);
    const states = (recompute || !lastStates) ? await packStates() : lastStates;
    const payload = { job: jobSnapshot(), states, manifest, busy: !!job };
    onUpdate(payload);
    if (broadcast) {
      try { channel && channel.postMessage({ type: "state" }); } catch (e) {}
    }
    return payload;
  }

  /* ---------------- the single job slot ---------------- */

  async function withJob(kind, packId, fn) {
    if (job) {
      await emit({ broadcast: false });
      return { refused: true, reason: "Another pack job is already running." };
    }
    if (!navigator.locks || !navigator.locks.request) {
      const p = runJob(kind, packId, fn);
      activeJobPromise = p;
      return p;
    }
    let result = null;
    let refused = false;
    const lockPromise = navigator.locks.request(JOB_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) { refused = true; return; }
      result = await runJob(kind, packId, fn);
    });
    activeJobPromise = lockPromise;
    await lockPromise;
    if (activeJobPromise === lockPromise) activeJobPromise = null;
    if (refused) {
      return { refused: true, reason: "Another tab is installing packs right now." };
    }
    return result || { refused: true, reason: "Pack job did not start." };
  }

  async function runJob(kind, packId, fn) {
    job = {
      kind, packId, total: 0, done: 0, loaded: 0,
      paused: false, cancelled: false, quotaError: false,
    };
    abort = new AbortController();
    await emit({ broadcast: true, recompute: true });
    try {
      return await fn();
    } catch (e) {
      return { error: e && e.message ? e.message : String(e) };
    } finally {
      job = null;
      abort = null;
      await emit({ broadcast: true, recompute: true });
    }
  }

  function cancel() {
    if (!job) return false;
    job.cancelled = true;
    job.paused = false;
    if (abort) { try { abort.abort(); } catch (e) {} }
    emit({ broadcast: false, recompute: false });
    return true;
  }

  async function cancelAndWait() {
    const p = activeJobPromise;
    cancel();
    if (p) {
      try { await p; } catch (e) {}
    }
  }

  function pause() { if (job) { job.paused = true; emit({ broadcast: false, recompute: false }); } }
  function resume() { if (job) { job.paused = false; emit({ broadcast: false, recompute: false }); } }

  async function waitWhilePaused() {
    while (job && job.paused && !job.cancelled) {
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  /* ---------------- download ---------------- */

  async function storeChunk(cache, name, buf) {
    await cache.put(keyFor(name), new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": "application/zstd",
        "Content-Length": String(buf.byteLength),
      },
    }));
  }

  /**
   * Bundle-native downloader: groups missing chunks by .pack bundle when
   * bundles.json is available, fetching whole bundles when >= 50% of a bundle
   * (or <= 96 KB) is needed and exact HTTP Range slices otherwise. Falls back
   * cleanly to individual chunk URLs when bundles.json is absent.
   */
  async function downloadChunkQueue(queue, targetCache) {
    const bIdx = await loadBundleIndex();
    const smallLimit = typeof GL_SMALL_BUNDLE_BYTES === "number" ? GL_SMALL_BUNDLE_BYTES : (96 * 1024);

    if (bIdx && bIdx.chunkToBundle && queue.every((n) => bIdx.chunkToBundle.has(n))) {
      const byFile = new Map();
      for (const name of queue) {
        const meta = bIdx.chunkToBundle.get(name);
        if (!byFile.has(meta.file)) byFile.set(meta.file, []);
        byFile.get(meta.file).push({ name, off: meta.off, len: meta.len });
      }

      const tasks = [];
      for (const [file, items] of byFile) {
        const totalInBundle = bIdx.bundleCounts.get(file) || items.length;
        const bSize = bIdx.bundleSizes.get(file) || 0;
        const whole = (items.length > 1 && items.length >= Math.ceil(totalInBundle * 0.65)) ||
          (bSize > 0 && bSize <= smallLimit);
        if (whole) {
          tasks.push({ kind: "bundle", file, items });
        } else {
          for (const it of items) tasks.push({ kind: "range", file, item: it });
        }
      }

      const CONCURRENCY = 3;
      const worker = async () => {
        for (;;) {
          if (!job || job.cancelled || job.quotaError) return;
          await waitWhilePaused();
          if (!job || job.cancelled || job.quotaError) return;
          const task = tasks.shift();
          if (!task) return;
          try {
            const base = glBundleUrl(task.file);
            const sep = base.includes("?") ? "&" : "?";
            const url = base + sep + "gl_pack=1";

            if (task.kind === "bundle") {
              const res = await fetch(url, { signal: abort.signal });
              if (res.ok) {
                const buf = await res.arrayBuffer();
                if (!job || job.cancelled || job.quotaError) return;
                job.loaded += buf.byteLength;
                for (const it of task.items) {
                  if (!job || job.cancelled || job.quotaError) return;
                  const slice = buf.slice(it.off, it.off + it.len);
                  await storeChunk(targetCache, it.name, slice);
                  job.done++;
                }
                emit({ broadcast: false, recompute: false });
              } else {
                job.done += task.items.length;
              }
            } else {
              const it = task.item;
              const res = await fetch(url, {
                signal: abort.signal,
                headers: { Range: `bytes=${it.off}-${it.off + it.len - 1}` },
              });
              if (res.ok) {
                const buf = await res.arrayBuffer();
                if (!job || job.cancelled || job.quotaError) return;
                job.loaded += buf.byteLength;
                const slice = (res.status === 200 && buf.byteLength >= it.off + it.len)
                  ? buf.slice(it.off, it.off + it.len)
                  : buf;
                if (slice.byteLength === it.len) {
                  await storeChunk(targetCache, it.name, slice);
                }
              }
              if (job) {
                job.done++;
                if (job.done % 4 === 0 || job.done >= job.total) {
                  emit({ broadcast: false, recompute: false });
                }
              }
            }
          } catch (e) {
            if (!job || job.cancelled) return;
            if (e && e.name === "QuotaExceededError") {
              job.quotaError = true;
              try { abort && abort.abort(); } catch (_) {}
              return;
            }
            if (job) job.done += (task.kind === "bundle" ? task.items.length : 1);
          }
        }
      };

      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return;
    }

    // Fallback when bundles.json is absent: direct chunk URL fetches.
    const CONCURRENCY = 6;
    const worker = async () => {
      for (;;) {
        if (!job || job.cancelled || job.quotaError) return;
        await waitWhilePaused();
        if (!job || job.cancelled || job.quotaError) return;
        const name = queue.shift();
        if (!name) return;
        try {
          const base = glChunkUrl(name);
          const sep = base.includes("?") ? "&" : "?";
          const res = await fetch(base + sep + "gl_pack=1", { signal: abort.signal });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            if (!job || job.cancelled || job.quotaError) return;
            job.loaded += buf.byteLength;
            await storeChunk(targetCache, name, buf);
          }
        } catch (e) {
          if (!job || job.cancelled) return;
          if (e && e.name === "QuotaExceededError") {
            job.quotaError = true;
            try { abort && abort.abort(); } catch (_) {}
            return;
          }
        }
        if (!job) return;
        job.done++;
        if (job.done % 20 === 0 || job.done >= job.total) {
          emit({ broadcast: false, recompute: false });
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  async function download(packId) {
    const names = await loadList(packId);
    if (!names.length) throw new Error("pack list is empty");

    job.total = names.length;
    job.done = 0;
    await emit({ broadcast: false, recompute: true });

    const cache = await openPackCache();
    const cached = await cachedUrlSet();
    const queue = names.filter((n) => !cached.has(keyFor(n)));
    job.done = names.length - queue.length;

    await downloadChunkQueue(queue, cache);

    const quotaError = job.quotaError;
    const cancelled = job.cancelled;
    const states = await packStates();
    if (quotaError) {
      return {
        error: "Storage quota exceeded. Remove a pack or free browser storage and retry.",
      };
    }
    if (cancelled) {
      return {
        cancelled: true,
        reason: "Download cancelled. Chunks already saved were kept.",
      };
    }
    if (!states[packId].complete) {
      return {
        incomplete: true,
        reason: `Saved ${states[packId].present} of ${states[packId].total} chunks. Press Save again to resume.`,
      };
    }
    return { complete: true };
  }

  async function downloadTool(toolId, chunkNames) {
    const unique = [...new Set(chunkNames || [])];
    if (!unique.length) return { complete: true };

    job.total = unique.length;
    job.done = 0;
    await emit({ broadcast: false, recompute: false });

    const dataCache = await caches.open(GL_DATA_CACHE);
    const have = new Set();
    for (const cn of [GL_PACK_CACHE, GL_DATA_CACHE]) {
      try {
        const c = await caches.open(cn);
        for (const k of await c.keys()) have.add(k.url);
      } catch (_) {}
    }

    const queue = unique.filter((n) => !have.has(keyFor(n)));
    job.done = unique.length - queue.length;

    await downloadChunkQueue(queue, dataCache);

    if (job.quotaError) {
      return { error: "Storage quota exceeded. Free browser storage and retry." };
    }
    if (job.cancelled) {
      return { cancelled: true, reason: `Cancelled preloading ${toolId}.` };
    }
    return { complete: true, toolId };
  }

  /* ---------------- removal ---------------- */

  async function protectedNames(exceptId, inProgressId, cached) {
    const keep = new Set();
    const present = cached || (await cachedUrlSet());
    for (const id of REAL_PACKS) {
      if (id === exceptId) continue;
      let names;
      try { names = await loadList(id); } catch (e) { continue; }
      let found = 0;
      for (const n of names) if (present.has(keyFor(n))) found++;
      const saved = names.length > 0 && found >= names.length;
      if (!saved && id !== inProgressId) continue;
      for (const n of names) keep.add(n);
    }
    if (inProgressId && inProgressId !== exceptId) {
      try { for (const n of await loadList(inProgressId)) keep.add(n); } catch (e) {}
    }
    return keep;
  }

  async function removePackChunks(packId, inProgressId) {
    const names = await loadList(packId);
    const keep = await protectedNames(packId, inProgressId);
    const cache = await openPackCache();
    const existingKeys = await cache.keys();
    const existingUrls = new Set(existingKeys.map((k) => k.url));

    const toDelete = [];
    for (const n of names) {
      if (!keep.has(n) && existingUrls.has(keyFor(n))) {
        toDelete.push(n);
      }
    }
    if (!toDelete.length) return { deleted: 0 };

    const deleteUrls = new Set(toDelete.map((n) => keyFor(n)));
    const survivingKeys = existingKeys.filter((k) => !deleteUrls.has(k.url));

    // Safari/WebKit does NOT reclaim disk space on per-key cache.delete() calls
    // (leaving hundreds of MB of orphaned blobs across repeated download/cancel
    // cycles). Drop the entire GL_PACK_CACHE via caches.delete() to force
    // immediate compaction, atomically preserving any surviving pack chunks.
    job.total = toDelete.length;
    job.done = 0;

    if (survivingKeys.length === 0) {
      await caches.delete(GL_PACK_CACHE);
      job.done = job.total;
      emit({ broadcast: false, recompute: false });
      return { deleted: toDelete.length };
    }

    // Snapshot the surviving entries (e.g. Common pack ~6 MB), wipe the bloated
    // cache directory via caches.delete(), then write only survivors back.
    const keptRecords = [];
    for (const req of survivingKeys) {
      try {
        const res = await cache.match(req);
        if (res && res.ok) {
          const buf = await res.arrayBuffer();
          keptRecords.push({ url: req.url, buf });
        }
      } catch (_) {}
    }
    await caches.delete(GL_PACK_CACHE);
    const fresh = await openPackCache();
    for (const rec of keptRecords) {
      await fresh.put(rec.url, new Response(rec.buf, {
        status: 200,
        headers: {
          "Content-Type": "application/zstd",
          "Content-Length": String(rec.buf.byteLength),
        },
      }));
    }
    job.done = job.total;
    emit({ broadcast: false, recompute: false });
    return { deleted: toDelete.length };
  }

  /* ---------------- public actions ---------------- */

  async function install(packId) {
    if (!REAL_PACKS.includes(packId)) {
      return { refused: true, reason: "Unknown pack: " + packId };
    }
    return withJob("download", packId, () => download(packId));
  }

  async function installTool(toolId, chunkNames) {
    if (!toolId || !Array.isArray(chunkNames) || !chunkNames.length) {
      return { refused: true, reason: "No chunks to preload for " + toolId };
    }
    return withJob("tool", toolId, () => downloadTool(toolId, chunkNames));
  }

  async function removePack(packId) {
    if (!REAL_PACKS.includes(packId)) {
      return { refused: true, reason: "Unknown pack: " + packId };
    }
    if (job && job.packId === packId) await cancelAndWait();
    return withJob("remove", packId, () => removePackChunks(packId, null));
  }

  async function useMinimal() {
    if (job) await cancelAndWait();
    return withJob("minimal", "minimal", async () => {
      const cache = await openPackCache();
      const keys = await cache.keys();
      const deleted = keys.length;
      job.total = Math.max(1, deleted);
      // Drop the whole cache so Safari/WebKit immediately reclaims disk space.
      await caches.delete(GL_PACK_CACHE);
      job.done = job.total;
      emit({ broadcast: false, recompute: false });
      return { deleted };
    });
  }

  /**
   * Drop all cached packs AND on-demand tool chunks from GL_DATA_CACHE while
   * preserving the 9.1 MB boot snapshot (compacting both caches for Safari).
   */
  async function clearToolCaches() {
    if (job) await cancelAndWait();
    return withJob("clear", "cache", async () => {
      let deleted = 0;
      try {
        const packCache = await openPackCache();
        deleted += (await packCache.keys()).length;
        await caches.delete(GL_PACK_CACHE);
      } catch (_) {}

      let snapBuf = null;
      let snapUrl = null;
      try {
        const dataCache = await caches.open(GL_DATA_CACHE);
        const dataKeys = await dataCache.keys();
        for (const req of dataKeys) {
          if (typeof GL_SNAPSHOT_URL === "string" && req.url.endsWith(GL_SNAPSHOT_URL)) {
            const hit = await dataCache.match(req);
            if (hit && hit.ok) {
              snapBuf = await hit.arrayBuffer();
              snapUrl = req.url;
            }
          } else {
            deleted++;
          }
        }
        await caches.delete(GL_DATA_CACHE);
        if (snapBuf && snapUrl) {
          const fresh = await caches.open(GL_DATA_CACHE);
          await fresh.put(snapUrl, new Response(snapBuf, {
            status: 200,
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(snapBuf.byteLength),
            },
          }));
        }
      } catch (_) {}

      return { deleted };
    });
  }

  async function estimateActualCacheBytes() {
    const bIdx = await loadBundleIndex();
    let chunkBytes = 0;
    let snapshotBytes = 0;
    let count = 0;
    for (const cname of [GL_PACK_CACHE, GL_DATA_CACHE]) {
      try {
        const c = await caches.open(cname);
        for (const req of await c.keys()) {
          const pathname = new URL(req.url).pathname;
          if (typeof GL_SNAPSHOT_URL === "string" && pathname.endsWith(GL_SNAPSHOT_URL)) {
            snapshotBytes = (manifest && manifest.minimal && manifest.minimal.snapshotBytes) || (9.1 * 1048576);
            continue;
          }
          const name = pathname.split("/").pop();
          const meta = bIdx && bIdx.chunkToBundle && bIdx.chunkToBundle.get(name);
          if (meta) {
            chunkBytes += meta.len;
            count++;
          }
        }
      } catch (_) {}
    }
    return { chunkBytes, snapshotBytes, totalBytes: chunkBytes + snapshotBytes, count };
  }

  async function verify(packId) {
    const names = await loadList(packId);
    const cached = await cachedUrlSet();
    let missing = 0;
    for (const n of names) if (!cached.has(keyFor(n))) missing++;
    return { total: names.length, present: names.length - missing, missing };
  }

  // Reflect changes made by another tab WITHOUT re-broadcasting (prevents ping-pong loop).
  if (channel) {
    channel.onmessage = () => {
      if (!job) emit({ broadcast: false, recompute: true });
    };
  }

  const api = {
    PACKS,
    loadManifest,
    packStates,
    install,
    installTool,
    removePack,
    useMinimal,
    clearToolCaches,
    estimateActualCacheBytes,
    verify,
    cancel,
    cancelAndWait,
    pause,
    resume,
    onUpdate(fn) { onUpdate = fn || (() => {}); },
    getJob() { return jobSnapshot(); },
  };

  if (typeof window !== "undefined") window.GoPacks = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
