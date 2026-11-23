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
            await cache.put(keyFor(name), new Response(buf, {
              headers: { "Content-Length": String(buf.byteLength) },
            }));
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
    job.total = names.length;
    job.done = 0;
    let deleted = 0;
    for (const n of names) {
      if (!job.cancelled && !keep.has(n)) {
        if (await cache.delete(keyFor(n))) deleted++;
      }
      job.done++;
      if (job.done % 50 === 0) emit({ broadcast: false, recompute: false });
    }
    return { deleted };
  }

  /* ---------------- public actions ---------------- */

  async function install(packId) {
    if (!REAL_PACKS.includes(packId)) {
      return { refused: true, reason: "Unknown pack: " + packId };
    }
    return withJob("download", packId, () => download(packId));
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
      job.total = keys.length;
      let deleted = 0;
      for (const k of keys) {
        if (!job.cancelled && (await cache.delete(k))) deleted++;
        job.done++;
        if (job.done % 50 === 0) emit({ broadcast: false, recompute: false });
      }
      return { deleted };
    });
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
    removePack,
    useMinimal,
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
