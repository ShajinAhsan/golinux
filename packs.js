/* Offline pack store.
 *
 * Three packs: minimal (nothing but the shipped snapshot), common and full.
 *
 * Design rules, which the old version broke:
 *   1. THE CACHE IS THE SOURCE OF TRUTH. There is no "installed tier" flag;
 *      every pack's state is computed from which of its chunks are actually in
 *      GL_PACK_CACHE. A flag can disagree with reality after a failed or
 *      cancelled download, a manual cache clear, or another tab's actions.
 *   2. ONE JOB AT A TIME, ACROSS TABS. Download, remove and "use minimal" all
 *      take the same Web Lock, so a second tab is refused instead of racing.
 *   3. REMOVAL IS SHARED-AWARE. `common` is a subset of `full`, so deleting one
 *      pack must never delete chunks the other still needs. Removal computes
 *      the union of the other packs' lists (plus anything currently
 *      downloading) and protects it.
 *   4. ONLY THE PACK CACHE IS TOUCHED. Chunks cached by normal use live in the
 *      service worker's data cache and must never be deleted here.
 */
(function () {
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

  let manifest = {};        // packs/index.json: { id: {chunks, bytes, ...} }
  let lists = {};           // id -> [chunk names]
  let onUpdate = () => {};
  let job = null;           // { kind, packId, total, done, loaded, paused, cancelled }
  let abort = null;
  let channel = null;
  try { channel = new BroadcastChannel(BC_NAME); } catch (e) { /* unsupported */ }

  /* ---------------- cache helpers ---------------- */

  const keyFor = (name) => location.origin + "/" + GL_CHUNK_PATH + name;

  async function openPackCache() { return caches.open(GL_PACK_CACHE); }

  /** One keys() call, so a 5,600-chunk pack costs one scan, not 5,600. */
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
    } catch (e) { /* offline; sizes unknown */ }
    return manifest;
  }

  /** Chunk names for a pack, from its list file. Cached in memory. */
  async function loadList(id) {
    if (lists[id]) return lists[id];
    const meta = PACKS.find((p) => p.id === id);
    if (!meta || !meta.file) return [];
    const r = await fetch(glPackUrl(meta.file), { cache: "no-store" });
    if (!r.ok) throw new Error("could not load the " + id + " pack list");
    lists[id] = await r.json();
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
        // List unavailable (offline, first visit): report unknown rather than 0.
        total = (manifest[id] && manifest[id].chunks) || 0;
        present = 0;
      }
      out[id] = {
        id, present, total,
        complete: total > 0 && present >= total,
        started: present > 0 && present < total,
      };
    }
    out.minimal = { id: "minimal", present: 0, total: 0,
      complete: !out.common.complete && !out.full.complete, started: false };
    return out;
  }

  function jobSnapshot() {
    return job ? { ...job } : null;
  }

  async function emit() {
    const states = await packStates();
    const payload = { job: jobSnapshot(), states, manifest, busy: !!job };
    onUpdate(payload);
    try { channel && channel.postMessage({ type: "state" }); } catch (e) {}
    return payload;
  }

  /* ---------------- the single job slot ---------------- */

  async function withJob(kind, packId, fn) {
    if (job) {
      await emit();
      return { refused: true, reason: "Another pack job is already running." };
    }
    if (!navigator.locks || !navigator.locks.request) {
      // No Web Locks: still run, but only one at a time in this tab (checked
      // above). Cross-tab safety is best-effort on such browsers.
      return runJob(kind, packId, fn);
    }
    let result = null;
    let refused = false;
    await navigator.locks.request(JOB_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) { refused = true; return; }
      result = await runJob(kind, packId, fn);
    });
    if (refused) {
      return { refused: true,
        reason: "Another tab is installing packs right now." };
    }
    return result || { refused: true, reason: "Pack job did not start." };
  }

  async function runJob(kind, packId, fn) {
    job = { kind, packId, total: 0, done: 0, loaded: 0,
      paused: false, cancelled: false };
    abort = new AbortController();
    await emit();
    try {
      return await fn();
    } catch (e) {
      return { error: e && e.message ? e.message : String(e) };
    } finally {
      const wasCancelled = job.cancelled;
      job = null;
      abort = null;
      await emit();
      void wasCancelled;
    }
  }

  function cancel() {
    if (!job) return false;
    job.cancelled = true;
    job.paused = false;
    if (abort) { try { abort.abort(); } catch (e) {} }
    emit();
    return true;
  }

  function pause() { if (job) { job.paused = true; emit(); } }
  function resume() { if (job) { job.paused = false; emit(); } }

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
    await emit();

    const cache = await openPackCache();
    // Re-read the cache here, not once at the top: a resumed or second Save
    // must see what is already present and fetch nothing.
    const cached = await cachedUrlSet();
    const queue = names.filter((n) => !cached.has(keyFor(n)));
    job.done = names.length - queue.length;   // already-cached count toward done

    const CONCURRENCY = 6;
    const worker = async () => {
      for (;;) {
        if (!job || job.cancelled) return;
        await waitWhilePaused();
        if (!job || job.cancelled) return;
        const name = queue.shift();
        if (!name) return;
        try {
          // Plain fetch: unlike the emulator's own disk URL, an absolute
          // cross-origin URL is safe here.
          const res = await fetch(glChunkUrl(name), { signal: abort.signal });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            job.loaded += buf.byteLength;
            // Same key shape the service worker looks up.
            await cache.put(keyFor(name), new Response(buf, {
              headers: { "Content-Length": String(buf.byteLength) },
            }));
          }
        } catch (e) {
          if (job.cancelled) return;
          // Leave it missing; a later Save retries just this chunk.
        }
        // Counted either way: a failed chunk is "attempted", and the next Save
        // recomputes from the cache, so nothing is silently hidden.
        job.done++;
        if (job.done % 20 === 0 || job.done >= job.total) emit();
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const cancelled = job.cancelled;
    const states = await packStates();
    if (cancelled) {
      return { cancelled: true,
        reason: "Download cancelled. Chunks already saved were kept." };
    }
    if (!states[packId].complete) {
      return { incomplete: true,
        reason: `Saved ${states[packId].present} of ${states[packId].total} ` +
          "chunks. Press Save again to resume." };
    }
    return { complete: true };
  }

  /* ---------------- removal ---------------- */

  /**
   * Chunks that must survive a removal.
   *
   * The union of the chunk lists of every OTHER pack that actually has chunks
   * saved (or is downloading). A pack that is present at all is protected in
   * full, because a partially saved pack still depends on what it already has.
   *
   * Only packs with content count: `common` is a strict subset of `full`, so
   * protecting *every* other pack's list unconditionally would mean "Remove
   * common" could never delete anything. Protecting only saved packs keeps
   * Remove meaningful while still never breaking a saved one.
   */
  async function protectedNames(exceptId, inProgressId, cached) {
    const keep = new Set();
    const present = cached || (await cachedUrlSet());
    for (const id of REAL_PACKS) {
      if (id === exceptId) continue;
      let names;
      try { names = await loadList(id); } catch (e) { continue; }
      // A pack counts as "saved" only if essentially ALL of it is present.
      // Testing "any chunk" is wrong: common ⊂ full, so installing common makes
      // full look present and nothing could ever be removed.
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

  /**
   * Delete this pack's chunks that no other pack needs.
   *
   * Only GL_PACK_CACHE is touched: chunks the service worker cached during
   * normal use live in the data cache and are never removed here.
   */
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
      if (job.done % 50 === 0) emit();
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
    // Removing the pack that is downloading means: cancel, then remove.
    if (job && job.packId === packId) cancel();
    return withJob("remove", packId, () => removePackChunks(packId, null));
  }

  /** "Use Minimal": remove every pack chunk (the snapshot is kept). */
  async function useMinimal() {
    if (job) cancel();
    return withJob("minimal", "minimal", async () => {
      const cache = await openPackCache();
      const keys = await cache.keys();
      job.total = keys.length;
      let deleted = 0;
      for (const k of keys) {
        if (!job.cancelled && (await cache.delete(k))) deleted++;
        job.done++;
        if (job.done % 50 === 0) emit();
      }
      return { deleted };
    });
  }

  /** Cheap verify: how many of a pack's chunks are missing. */
  async function verify(packId) {
    const names = await loadList(packId);
    const cached = await cachedUrlSet();
    let missing = 0;
    for (const n of names) if (!cached.has(keyFor(n))) missing++;
    return { total: names.length, present: names.length - missing, missing };
  }

  // Reflect changes made by another tab: recompute from the cache on notice.
  if (channel) {
    channel.onmessage = () => { if (!job) emit(); };
  }

  window.GoPacks = {
    PACKS,
    loadManifest,
    packStates,
    install,
    removePack,
    useMinimal,
    verify,
    cancel,
    pause,
    resume,
    onUpdate(fn) { onUpdate = fn; },
    getJob() { return jobSnapshot(); },
  };
})();
