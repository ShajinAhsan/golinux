/* Offline pack downloader.
 *
 * Installs one of the packs listed in packs/index.json into the pack cache.
 * Runs in the page (not the service worker) so it can be paused, resumed and
 * cancelled with immediate feedback; the service worker then serves those
 * chunks from cache like any other cached chunk.
 */
(function () {
  const PACKS = [
    { id: "minimal", label: "Minimal", file: null, desc: "Snapshot only — boots instantly. No extra tools cached." },
    { id: "common", label: "Common tools", file: "common.json", desc: "ls, nano, git, gcc, g++, make, man" },
    { id: "full", label: "Full", file: "full.json", desc: "Every data chunk of the disk image" },
  ];

  let manifest = {};      // packs/index.json { id: {chunks, bytes} }
  let state = {
    running: false,
    paused: false,
    cancelled: false,
    packId: null,
    total: 0,
    done: 0,
    bytes: 0,       // bytes counted for the pack
    loaded: 0,      // bytes actually transferred this run
  };
  let abort = null;
  let onUpdate = () => {};

  async function loadManifest() {
    if (Object.keys(manifest).length) return manifest;
    try {
      const r = await fetch(glPackUrl("index.json"), { cache: "no-store" });
      if (r.ok) manifest = await r.json();
      else console.warn("pack index unavailable (offline?)");
    } catch (e) { /* offline; sizes unknown */ }
    return manifest;
  }

  function installedPack() {
    try { return localStorage.getItem(GL_PACK_KEY) || "minimal"; } catch (e) { return "minimal"; }
  }

  function setInstalledPack(id) {
    try { localStorage.setItem(GL_PACK_KEY, id); } catch (e) {}
  }

  function emit() {
    onUpdate({ ...state, installed: installedPack(), manifest });
  }

  async function pausedWait() {
    while (state.paused && !state.cancelled) {
      await new Promise(r => setTimeout(r, 120));
    }
  }

  /**
   * Install a pack. Cached chunks are skipped, so re-installing or resuming
   * after a cancel only fetches what is missing.
   */
  async function install(packId) {
    if (state.running) return;
    await loadManifest();

    if (packId === "minimal") {
      // Nothing beyond the snapshot, which first load already cached.
      const cache = await caches.open(GL_PACK_CACHE);
      await pruneTo(cache, []);
      setInstalledPack("minimal");
      emit();
      return;
    }

    const info = manifest[packId];
    const list = info && info.list;
    if (!list) {
      // index.json holds counts only; load the pack file for the chunk names.
      const r = await fetch(glPackUrl(PACKS.find(p => p.id === packId).file), { cache: "no-store" });
      if (!r.ok) throw new Error("could not load pack list");
      const names = await r.json();
      return installList(packId, names);
    }
    return installList(packId, list);
  }

  async function installList(packId, names) {
    abort = new AbortController();
    state = {
      running: true, paused: false, cancelled: false, packId,
      total: names.length, done: 0, bytes: 0, loaded: 0,
    };
    emit();

    const cache = await caches.open(GL_PACK_CACHE);
    // Keys are same-origin paths (see the put() below); normalise for lookup.
    const existing = new Set((await cache.keys()).map(k => k.url));

    // The other pack is superseded; a full install implies common.
    const queue = names.slice();

    const worker = async () => {
      for (;;) {
        if (state.cancelled) return;
        await pausedWait();
        if (state.cancelled) return;

        const name = queue.shift();
        if (!name) return;

        // Plain fetch, not v86 use_parts, so an absolute cross-origin URL is
        // safe here (unlike the disk URL the emulator builds itself).
        const url = glChunkUrl(name);
        const localKey = location.origin + "/" + GL_CHUNK_PATH + name;
        if (existing.has(localKey)) {
          state.done++;
          if (state.done % 40 === 0) emit();
          continue;
        }

        try {
          const res = await fetch(url, { signal: abort.signal });
          if (!res.ok) continue;
          const buf = await res.arrayBuffer();
          state.loaded += buf.byteLength;
          state.bytes += buf.byteLength;
          // Cache under the same-origin path, matching what the service worker
          // looks up. Keying by the absolute asset URL would make every pack
          // chunk invisible offline.
          const cacheKey = location.origin + "/" + GL_CHUNK_PATH + name;
          await cache.put(cacheKey, new Response(buf, {
            headers: { "Content-Length": String(buf.byteLength) },
          }));
        } catch (e) {
          if (state.cancelled) return;
          // Network hiccup: leave it out; re-running the pack will retry.
        }

        state.done++;
        if (state.done % 20 === 0 || state.done === state.total) emit();
      }
    };

    try {
      await Promise.all(Array.from({ length: 6 }, worker));
    } finally {
      const finished = !state.cancelled && state.done >= state.total;
      state.running = false;
      abort = null;
      if (finished) {
        setInstalledPack(packId);
        // Installing one pack supersedes the other tier. Prune anything that is
        // not part of this pack (does NOT wipe the pack we just downloaded).
        await pruneTo(cache, names);
      }
      emit();
    }
  }

  /** Delete cached pack chunks that are not in `names`. */
  async function pruneTo(cache, names) {
    // Same key shape as installList writes and the SW reads.
    const keep = new Set(names.map(n => location.origin + "/" + GL_CHUNK_PATH + n));
    const keys = await cache.keys();
    await Promise.all(
      keys.filter(k => !keep.has(k.url)).map(k => cache.delete(k)));
  }

  /** Remove a pack's cached chunks. Does not touch the snapshot. */
  async function removePack(packId, opts = {}) {
    if (packId === "minimal") {
      // Minimal has no chunks of its own; keep the snapshot (it is the pack).
      if (!opts.keepInstalled) { setInstalledPack("minimal"); emit(); }
      return;
    }
    const cache = await caches.open(GL_PACK_CACHE);
    const keys = await cache.keys();
    await Promise.all(keys.map(k => cache.delete(k)));
    if (!opts.keepInstalled && installedPack() === packId) setInstalledPack("minimal");
    emit();
  }

  function pause() { if (state.running) { state.paused = true; emit(); } }
  function resume() { if (state.running) { state.paused = false; emit(); } }
  function cancel() {
    if (!state.running) return;
    state.cancelled = true;
    state.paused = false;
    if (abort) abort.abort();
    emit();
  }

  window.GoPacks = {
    PACKS,
    loadManifest,
    install,
    removePack,
    pause,
    resume,
    cancel,
    installedPack,
    onUpdate(fn) { onUpdate = fn; },
    getState() { return { ...state }; },
  };
})();
