/* GoLinux /root filesystem persistence.
 *
 * Persists the user's /root directory (bind-mounted over v86's 9p share) as a
 * compact portable GLFS binary archive in OPFS, rather than freezing 128 MB of
 * VM RAM. Every page refresh, tab reopen, and Restart boots a fresh, clean
 * Alpine Linux instance (<1s) with zero stuck foreground processes (e.g. ping,
 * infinite loops) while restoring all /root files, permissions, and symlinks
 * in <1 ms.
 *
 * Invariants enforced here:
 *   - Instant save latency: fs9p mutation hooks trigger a 350 ms debounced
 *     save (typically ~0.2 ms encode + ~3 ms OPFS write).
 *   - Zero lost files on immediate refresh: pagehide synchronously encodes
 *     /root and transfers the ArrayBuffer to the active Service Worker
 *     ("persist-save"), which writes under the "golinux-state" Web Lock inside
 *     event.waitUntil() (with a universal Cache API fallback for Safari/WebKit
 *     and older Firefox). The reloaded page calls "persist-flush" before read.
 *   - Portable across OS/image updates: /root archives contain clean file/dir/
 *     symlink entries, never raw v86 RAM offsets.
 *   - Monotonic dirtySeq: writes occurring during an async save are never lost.
 *   - Reset latch + Web Lock: clearUserState() permanently disarms unload
 *     saves and clears OPFS + SW pending cache under "golinux-state".
 *   - Ownership lock retry & clean release on pagehide prevent reload races.
 */
(function () {
  "use strict";

  const DIR = "golinux";
  const ROOT_FILE = "root-fs.bin";
  const ROOT_META_FILE = "root-meta.json";
  const LEGACY_STATE_FILE = "state.gz";
  const LEGACY_META_FILE = "meta.json";
  const PENDING_STATE_KEY = "/__golinux_pending_root__";
  const GZIP_THRESHOLD_BYTES = 256 * 1024;
  const SIZE_WARN_BYTES = 20 * 1024 * 1024;
  const SIZE_MAX_BYTES = 100 * 1024 * 1024;
  const DEBOUNCE_QUIET_MS = 350;
  const MIN_AUTOSAVE_GAP_MS = 1200;
  const MAX_DIRTY_AGE_MS = 5000;

  let owner = false;
  let releaseOwnerFn = null;
  let resetting = false;
  let diskBusy = false;
  let dirtySeq = 0;           // monotonic mutation counter
  let savedSeq = 0;           // dirtySeq value captured by last completed save
  let dirtySince = 0;
  let pausedForSize = false;
  let saveInFlight = false;
  let pendingSave = false;
  let lastSavedAt = 0;
  let lastActivity = Date.now();
  let debounceTimer = null;
  let statusCb = () => {};
  let activeEmulator = null;
  let unwatchFs = null;
  let attached = false;

  function pendingCacheName() {
    return typeof GL_PENDING_STATE_CACHE === "string" && GL_PENDING_STATE_CACHE
      ? GL_PENDING_STATE_CACHE
      : "golinux-pending-state";
  }

  function expectedSchema() {
    return typeof GL_STATE_SCHEMA === "number" ? GL_STATE_SCHEMA : 4;
  }

  function fmtSize(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    if (bytes >= 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
    return Math.max(0, bytes | 0) + " B";
  }

  function setStatus(msg, kind) {
    statusCb(msg || "", kind || "");
  }

  function isDirty() {
    return dirtySeq !== savedSeq;
  }

  function clearDebounce() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function scheduleAutosave() {
    clearDebounce();
    if (resetting || !owner || !activeEmulator || pausedForSize || !isDirty()) return;
    const now = Date.now();
    const quietAt = lastActivity + DEBOUNCE_QUIET_MS;
    const gapAt = lastSavedAt ? (lastSavedAt + MIN_AUTOSAVE_GAP_MS) : 0;
    const normalAt = Math.max(quietAt, gapAt);
    const maxAgeAt = dirtySince ? (dirtySince + MAX_DIRTY_AGE_MS) : normalAt;
    const targetAt = Math.min(normalAt, maxAgeAt);
    const delay = Math.max(50, targetAt - now);

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (resetting || !owner || !activeEmulator || !isDirty()) return;
      saveNow(activeEmulator, "auto");
    }, delay);
  }

  function markDirty() {
    if (resetting) return;
    const now = Date.now();
    lastActivity = now;
    if (!isDirty()) dirtySince = now;
    dirtySeq++;
    if (owner && !saveInFlight && !pausedForSize) {
      setStatus("Unsaved", "dirty");
    }
    scheduleAutosave();
  }

  /**
   * Pure validation predicate for portable /root archive metadata.
   */
  function isValidRootMeta(meta) {
    if (!meta || typeof meta !== "object") {
      return { ok: false, reason: "missing-meta" };
    }
    if (meta.format !== "glfs" || meta.version !== 1) {
      return { ok: false, reason: "unsupported-format" };
    }
    if (meta.encoding !== "raw" && meta.encoding !== "gzip") {
      return { ok: false, reason: "unsupported-encoding" };
    }
    return { ok: true };
  }

  /**
   * Pure compatibility predicate for legacy whole-VM metadata (kept exported
   * for unit tests and INV-3 verification).
   */
  function isCompatibleMeta(meta, expectedBuildId, schema) {
    const wantSchema = typeof schema === "number" ? schema : expectedSchema();
    if (!meta || typeof meta !== "object") {
      return { ok: false, reason: "missing-meta" };
    }
    if (meta.schema !== wantSchema) {
      return { ok: false, reason: "schema-mismatch" };
    }
    if (!expectedBuildId) {
      if (!meta.buildId) return { ok: false, reason: "missing-build-id" };
      return { ok: false, reason: "unknown-current-build-id" };
    }
    if (!meta.buildId || meta.buildId !== expectedBuildId) {
      return { ok: false, reason: "build-id-mismatch" };
    }
    return { ok: true };
  }

  /* ---------- OPFS helpers (Chrome + Firefox + Safari/WebKit) ---------- */

  async function opfsDir() {
    if (!navigator.storage || !navigator.storage.getDirectory) {
      const err = new Error("OPFS unavailable");
      err.name = "SecurityError";
      throw err;
    }
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(DIR, { create: true });
  }

  let opfsWorker = null;
  let opfsSeq = 0;
  const opfsPending = new Map();

  function rejectAllPending(map, err) {
    for (const [, p] of map) p.reject(err);
    map.clear();
  }

  function ensureOpfsWorker() {
    if (opfsWorker) return opfsWorker;
    const src = `
      self.onmessage = async (e) => {
        const { id, dirName, fileName, buf } = e.data;
        try {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle(dirName, { create: true });
          const fh = await dir.getFileHandle(fileName, { create: true });
          const ah = await fh.createSyncAccessHandle();
          try {
            const bytes = new Uint8Array(buf);
            ah.truncate(0);
            ah.write(bytes, { at: 0 });
            ah.flush();
          } finally {
            ah.close();
          }
          self.postMessage({ id, ok: true });
        } catch (err) {
          self.postMessage({ id, error: String(err), name: err && err.name || "Error" });
        }
      };`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    opfsWorker = new Worker(url);
    URL.revokeObjectURL(url);
    opfsWorker.onmessage = (e) => {
      const { id, ok, error, name } = e.data || {};
      const p = opfsPending.get(id);
      if (!p) return;
      opfsPending.delete(id);
      if (error) {
        const err = new Error(error);
        err.name = name || "Error";
        p.reject(err);
      } else {
        p.resolve(ok);
      }
    };
    const onCrash = (e) => {
      const err = new Error("OPFS worker failed: " + ((e && e.message) || "worker error"));
      try { opfsWorker && opfsWorker.terminate(); } catch (_) {}
      opfsWorker = null;
      rejectAllPending(opfsPending, err);
    };
    opfsWorker.onerror = onCrash;
    opfsWorker.onmessageerror = onCrash;
    return opfsWorker;
  }

  function writeViaSyncWorker(fileName, arrayBuffer) {
    return new Promise((resolve, reject) => {
      const id = ++opfsSeq;
      opfsPending.set(id, { resolve, reject });
      try {
        ensureOpfsWorker().postMessage(
          { id, dirName: DIR, fileName, buf: arrayBuffer },
          [arrayBuffer]
        );
      } catch (e) {
        opfsPending.delete(id);
        reject(e);
      }
    });
  }

  async function writeFileAtomic(fileName, dataBytes) {
    const buf = dataBytes instanceof ArrayBuffer
      ? dataBytes.slice(0)
      : dataBytes.buffer.slice(dataBytes.byteOffset, dataBytes.byteOffset + dataBytes.byteLength);

    const dir = await opfsDir();
    const tmpName = fileName + ".tmp";
    const tmp = await dir.getFileHandle(tmpName, { create: true });

    if (typeof tmp.createWritable === "function" && typeof tmp.move === "function") {
      try {
        const w = await tmp.createWritable();
        try {
          await w.write(new Blob([buf]));
          await w.close();
        } catch (e) {
          try { await w.abort(); } catch (_) {}
          throw e;
        }
        try {
          await tmp.move(dir, fileName);
        } catch (moveErr) {
          if (moveErr instanceof TypeError) {
            await tmp.move(fileName);
          } else {
            throw moveErr;
          }
        }
        return;
      } catch (writableErr) {
        const n = writableErr && writableErr.name;
        if (n !== "TypeError" && n !== "NotSupportedError") {
          throw writableErr;
        }
      }
    }

    try { await dir.removeEntry(tmpName); } catch (_) {}
    await writeViaSyncWorker(fileName, buf);
  }

  async function readMeta() {
    try {
      const dir = await opfsDir();
      const fh = await dir.getFileHandle(ROOT_META_FILE);
      const text = await (await fh.getFile()).text();
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  async function writeMeta(meta) {
    const bytes = new TextEncoder().encode(JSON.stringify(meta));
    await writeFileAtomic(ROOT_META_FILE, bytes);
  }

  async function hasUserState() {
    try {
      const dir = await opfsDir();
      await dir.getFileHandle(ROOT_FILE);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function cleanupLegacyStateFiles() {
    try {
      const dir = await opfsDir();
      for (const name of [LEGACY_STATE_FILE, LEGACY_META_FILE]) {
        try { await dir.removeEntry(name); } catch (_) {}
      }
    } catch (_) {}
  }

  /* ---------- gzip in a Worker (used only for >256 KB /root archives) ---------- */

  let gzipWorker = null;
  let gzipSeq = 0;
  const gzipPending = new Map();

  function ensureGzipWorker() {
    if (gzipWorker) return gzipWorker;
    const src = `
      self.onmessage = async (e) => {
        const { id, buf } = e.data;
        try {
          if (typeof CompressionStream === "undefined") {
            throw new Error("CompressionStream unsupported in this browser");
          }
          const cs = new CompressionStream("gzip");
          const out = await new Response(new Blob([buf]).stream().pipeThrough(cs)).arrayBuffer();
          self.postMessage({ id, out }, [out]);
        } catch (err) {
          self.postMessage({ id, error: String(err) });
        }
      };`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    gzipWorker = new Worker(url);
    URL.revokeObjectURL(url);
    gzipWorker.onmessage = (e) => {
      const { id, out, error } = e.data || {};
      const p = gzipPending.get(id);
      if (!p) return;
      gzipPending.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(out);
    };
    const onCrash = (e) => {
      const err = new Error("gzip worker failed: " + ((e && e.message) || "worker error"));
      try { gzipWorker && gzipWorker.terminate(); } catch (_) {}
      gzipWorker = null;
      rejectAllPending(gzipPending, err);
    };
    gzipWorker.onerror = onCrash;
    gzipWorker.onmessageerror = onCrash;
    return gzipWorker;
  }

  function gzipBuffer(buffer) {
    return new Promise((resolve, reject) => {
      const id = ++gzipSeq;
      gzipPending.set(id, { resolve, reject });
      try {
        ensureGzipWorker().postMessage({ id, buf: buffer }, [buffer]);
      } catch (e) {
        gzipPending.delete(id);
        reject(e);
      }
    });
  }

  async function gunzipBuffer(buffer) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("DecompressionStream unsupported in this browser");
    }
    const ds = new DecompressionStream("gzip");
    return new Response(new Blob([buffer]).stream().pipeThrough(ds)).arrayBuffer();
  }

  async function withStateLock(fn) {
    if (navigator.locks && navigator.locks.request) {
      return navigator.locks.request("golinux-state", fn);
    }
    return fn();
  }

  /* ---------- Service Worker handoff & flush helpers ---------- */

  function swController() {
    return ("serviceWorker" in navigator && navigator.serviceWorker && navigator.serviceWorker.controller)
      ? navigator.serviceWorker.controller
      : null;
  }

  function encodeRootSync(emu, reason) {
    const go9p = typeof window !== "undefined" ? window.Go9p : null;
    if (!go9p || !emu || !emu.fs9p) return null;
    const tree = go9p.exportRootTree(emu.fs9p);
    if (!tree) return null;
    const savedAt = Date.now();
    const archive = go9p.encodeRootArchive(tree, savedAt);
    return {
      archive,
      meta: {
        format: "glfs",
        version: 1,
        savedAt,
        rawBytes: archive.byteLength,
        fileCount: tree.fileCount,
        reason: reason || "auto",
      },
    };
  }

  function canSwHandoff() {
    const go9p = typeof window !== "undefined" ? window.Go9p : null;
    return !!(swController() && activeEmulator && activeEmulator.fs9p &&
      go9p && typeof go9p.exportRootTree === "function" &&
      go9p.findRootDirId(activeEmulator.fs9p) > 0);
  }

  function handoffSaveToSW(reason) {
    const ctrl = swController();
    if (!ctrl || !activeEmulator || resetting || !owner) return false;
    try {
      const encoded = encodeRootSync(activeEmulator, reason);
      if (!encoded) return false;
      const buf = encoded.archive.buffer.slice(
        encoded.archive.byteOffset,
        encoded.archive.byteOffset + encoded.archive.byteLength
      );
      ctrl.postMessage(
        { type: "persist-save", archive: buf, meta: encoded.meta },
        [buf]
      );
      savedSeq = dirtySeq;
      dirtySince = 0;
      return true;
    } catch (_) {
      return false;
    }
  }

  function flushSwPersist(timeoutMs) {
    const ctrl = swController();
    if (!ctrl || typeof MessageChannel === "undefined") {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let settled = false;
      let ch = null;
      const done = (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          try { ch && ch.port1 && ch.port1.close(); } catch (_) {}
          resolve(v);
        }
      };
      const t = setTimeout(() => done(null), timeoutMs || 6000);
      try {
        ch = new MessageChannel();
        ch.port1.onmessage = (e) => done(e.data || null);
        ctrl.postMessage({ type: "persist-flush" }, [ch.port2]);
      } catch (_) {
        done(null);
      }
    });
  }

  function clearSwPersist(timeoutMs) {
    const ctrl = swController();
    if (!ctrl || typeof MessageChannel === "undefined") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let ch = null;
      const done = () => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          try { ch && ch.port1 && ch.port1.close(); } catch (_) {}
          resolve();
        }
      };
      const t = setTimeout(done, timeoutMs || 3000);
      try {
        ch = new MessageChannel();
        ch.port1.onmessage = () => done();
        ctrl.postMessage({ type: "persist-clear" }, [ch.port2]);
      } catch (_) {
        done();
      }
    });
  }

  function handleSwSaved(msg) {
    if (!msg || resetting) return;
    if (msg.ok) {
      lastSavedAt = msg.savedAt || Date.now();
      if (!isDirty()) {
        setStatus("Saved " + fmtSize(msg.bytes || 0), "ok");
      }
    } else if (!msg.aborted) {
      // Mark dirty again so next cycle retries on main thread.
      dirtySeq++;
      if (msg.errorName === "QuotaExceededError") {
        setStatus("Not saved: storage is full. Use Reset to free space.", "error");
      } else if (msg.errorName === "SizeLimitError") {
        pausedForSize = true;
        setStatus("Autosave paused: /root exceeds 100 MB limit.", "error");
      }
    }
  }

  /* ---------- saving ---------- */

  async function saveNow(emulator, reason) {
    const emu = emulator || activeEmulator;
    if (!emu || resetting) return false;
    if (!owner) {
      setStatus("Not saved: another tab owns this session.", "warn");
      return false;
    }
    if (saveInFlight) {
      pendingSave = true;
      return false;
    }

    if (reason === "auto" && pausedForSize) return false;
    if (reason === "auto" && !isDirty() && lastSavedAt) return false;

    const encoded = encodeRootSync(emu, reason);
    if (!encoded) {
      // Cold-boot fallback without 9p /root bind-mount: nothing to serialize.
      return false;
    }

    clearDebounce();
    saveInFlight = true;
    const seqAtStart = dirtySeq;
    setStatus("Saving…", "");

    let succeeded = false;
    try {
      let payload = encoded.archive;
      let encoding = "raw";

      if (payload.byteLength > GZIP_THRESHOLD_BYTES) {
        const rawCopy = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
        const gz = await gzipBuffer(rawCopy);
        if (resetting) return false;
        if (gz && gz.byteLength < payload.byteLength) {
          payload = new Uint8Array(gz);
          encoding = "gzip";
        }
      }

      if (payload.byteLength > SIZE_MAX_BYTES) {
        pausedForSize = true;
        setStatus(
          `Autosave paused: /root is ${(payload.byteLength / 1048576).toFixed(0)} MB ` +
          `(limit ${SIZE_MAX_BYTES / 1048576} MB). Delete large files to resume saving.`,
          "error"
        );
        return false;
      }

      const meta = {
        format: "glfs",
        version: 1,
        encoding,
        savedAt: encoded.meta.savedAt,
        bytes: payload.byteLength,
        rawBytes: encoded.meta.rawBytes,
        fileCount: encoded.meta.fileCount,
        reason: reason || "manual",
      };

      await withStateLock(async () => {
        if (resetting) return;
        await writeFileAtomic(ROOT_FILE, payload);
        if (resetting) return;
        await writeMeta(meta);
        if (typeof caches !== "undefined") {
          try {
            const pc = await caches.open(pendingCacheName());
            await pc.delete(PENDING_STATE_KEY);
          } catch (_) {}
        }
      });

      if (resetting) return false;

      if (!lastSavedAt) cleanupLegacyStateFiles();
      lastSavedAt = meta.savedAt;
      savedSeq = seqAtStart;
      dirtySince = isDirty() ? Date.now() : 0;
      const wasPaused = pausedForSize;
      pausedForSize = false;
      succeeded = true;

      const label = fmtSize(payload.byteLength);
      if (payload.byteLength > SIZE_WARN_BYTES) {
        setStatus(`Saved ${label} — /root is getting large.`, "warn");
      } else if (wasPaused) {
        setStatus(`Saving resumed (${label})`, "ok");
      } else {
        setStatus(`Saved ${label}`, "ok");
      }
    } catch (e) {
      const name = e && e.name;
      if (name === "QuotaExceededError") {
        setStatus("Not saved: storage is full. Use Reset to free space.", "error");
      } else if (name === "SecurityError" || name === "InvalidStateError") {
        setStatus("Not saved: storage is blocked (private browsing?).", "error");
      } else {
        setStatus("Not saved: " + ((e && e.message) || name || "unknown error"), "error");
      }
    } finally {
      saveInFlight = false;
    }

    if ((pendingSave || isDirty()) && !resetting && !pausedForSize) {
      pendingSave = false;
      scheduleAutosave();
    }
    return succeeded;
  }

  /* ---------- loading ---------- */

  async function readPendingCacheState() {
    if (typeof caches === "undefined") return null;
    try {
      const pc = await caches.open(pendingCacheName());
      const hit = await pc.match(PENDING_STATE_KEY, { ignoreSearch: true });
      if (!hit || !hit.ok) return null;
      const format = hit.headers.get("X-GL-Format");
      const version = Number(hit.headers.get("X-GL-Version"));
      const encoding = hit.headers.get("X-GL-Encoding") || "raw";
      const savedAt = Number(hit.headers.get("X-GL-Saved-At")) || 0;
      const fileCount = Number(hit.headers.get("X-GL-File-Count")) || 0;
      const rawBytes = Number(hit.headers.get("X-GL-Raw-Bytes")) || 0;
      const meta = { format, version, encoding, savedAt, fileCount, rawBytes };
      if (!isValidRootMeta(meta).ok) return null;
      const buf = await hit.arrayBuffer();
      meta.bytes = buf.byteLength;
      return { source: "cache", meta, buf };
    } catch (_) {
      return null;
    }
  }

  async function readOpfsState() {
    try {
      const meta = await readMeta();
      if (!isValidRootMeta(meta).ok) return null;
      if (!(await hasUserState())) return null;
      const dir = await opfsDir();
      const fh = await dir.getFileHandle(ROOT_FILE);
      const buf = await (await fh.getFile()).arrayBuffer();
      return { source: "opfs", meta, buf };
    } catch (_) {
      return null;
    }
  }

  async function loadUserState() {
    const go9p = typeof window !== "undefined" ? window.Go9p : null;
    if (!go9p || typeof go9p.decodeRootArchive !== "function") return null;

    // Wait for any in-flight Service Worker unload save from the prior page.
    await flushSwPersist(6000);

    const picked = await withStateLock(async () => {
      const [opfsCand, cacheCand] = await Promise.all([
        readOpfsState(),
        readPendingCacheState(),
      ]);
      if (!opfsCand && !cacheCand) return null;
      if (opfsCand && !cacheCand) return opfsCand;
      if (!opfsCand && cacheCand) return cacheCand;
      return (cacheCand.meta.savedAt || 0) >= (opfsCand.meta.savedAt || 0)
        ? cacheCand
        : opfsCand;
    });

    if (!picked) return null;

    try {
      let rawBuf = picked.buf;
      if (picked.meta.encoding === "gzip") {
        rawBuf = await gunzipBuffer(picked.buf);
      }
      const decoded = go9p.decodeRootArchive(rawBuf);

      // Promote Safari/Firefox SW cache fallback into OPFS asynchronously.
      if (picked.source === "cache") {
        withStateLock(async () => {
          if (resetting) return;
          try {
            await writeFileAtomic(ROOT_FILE, picked.buf);
            await writeMeta(picked.meta);
            if (typeof caches !== "undefined") {
              const pc = await caches.open(pendingCacheName());
              await pc.delete(PENDING_STATE_KEY);
            }
          } catch (_) { /* keep cache fallback intact if OPFS unavailable */ }
        }).catch(() => {});
      }

      lastSavedAt = picked.meta.savedAt || decoded.savedAt || Date.now();
      savedSeq = dirtySeq;
      dirtySince = 0;
      setStatus("Saved " + fmtSize(picked.buf.byteLength), "ok");
      return {
        entries: decoded.entries,
        fileCount: decoded.fileCount,
        savedAt: lastSavedAt,
        bytes: picked.buf.byteLength,
      };
    } catch (e) {
      setStatus("Saved /root was unreadable; started fresh.", "warn");
      return null;
    }
  }

  function restoreRootFiles(emulator, savedState) {
    const go9p = typeof window !== "undefined" ? window.Go9p : null;
    if (!emulator || !emulator.fs9p || !savedState || !Array.isArray(savedState.entries)) {
      return 0;
    }
    if (!go9p || typeof go9p.importRootTree !== "function") return 0;
    const count = go9p.importRootTree(emulator.fs9p, savedState.entries);
    savedSeq = dirtySeq;
    dirtySince = 0;
    return count;
  }

  /* ---------- reset ---------- */

  function prepareReset() {
    resetting = true;
    pendingSave = false;
    clearDebounce();
  }

  async function clearUserState() {
    prepareReset();
    try { await clearSwPersist(3000); } catch (_) {}
    try {
      return await withStateLock(async () => {
        if (typeof caches !== "undefined") {
          try { await caches.delete(pendingCacheName()); } catch (_) {}
        }
        const root = await navigator.storage.getDirectory();
        try {
          await root.removeEntry(DIR, { recursive: true });
        } catch (e) {
          if (e && e.name !== "NotFoundError") throw e;
        }
        return true;
      });
    } catch (e) {
      return false;
    }
  }

  /* ---------- ownership ---------- */

  function releaseOwnerLock() {
    if (releaseOwnerFn) {
      const fn = releaseOwnerFn;
      releaseOwnerFn = null;
      try { fn(); } catch (_) {}
    }
  }

  function tryClaimLockOnce() {
    return new Promise((resolve) => {
      navigator.locks.request("golinux-owner", { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        owner = true;
        resolve(true);
        return new Promise((rel) => { releaseOwnerFn = rel; });
      });
    });
  }

  async function claimOwnership() {
    if (!navigator.locks || !navigator.locks.request) {
      owner = true;
      return true;
    }
    // Retry briefly in case a freshly-reloading tab is still releasing its lock.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await tryClaimLockOnce()) return true;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 100));
    }

    owner = false;
    setStatus("Another tab is saving this session. Changes here won't be saved.", "warn");

    // Promote automatically if the other tab closes later.
    navigator.locks.request("golinux-owner", (lock) => {
      if (!lock) return;
      owner = true;
      setStatus("Session saving active.", "ok");
      if (activeEmulator && isDirty()) scheduleAutosave();
      return new Promise((rel) => { releaseOwnerFn = rel; });
    }).catch(() => {});

    return false;
  }

  /* ---------- public ---------- */

  const api = {
    DEBOUNCE_QUIET_MS,
    MIN_AUTOSAVE_GAP_MS,
    MAX_DIRTY_AGE_MS,
    AUTOSAVE_MS: MAX_DIRTY_AGE_MS,
    SIZE_MAX_BYTES,
    claimOwnership,
    releaseOwnerLock,
    saveNow,
    loadUserState,
    loadRootState: loadUserState,
    restoreRootFiles,
    clearUserState,
    prepareReset,
    hasUserState,
    readMeta,
    isValidRootMeta,
    isCompatibleMeta,
    handleSwSaved,
    markDirty,
    setDiskBusy(busy) { diskBusy = !!busy; },
    getOwner: () => owner,
    getLastSavedAt: () => lastSavedAt,
    isDirty,
    isSaveInFlight: () => saveInFlight,
    isResetting: () => resetting,
    isSizePaused: () => pausedForSize,
    setStatusHandler(fn) { statusCb = fn || (() => {}); },

    attach(emulator) {
      if (unwatchFs) {
        try { unwatchFs(); } catch (_) {}
        unwatchFs = null;
      }
      activeEmulator = emulator;
      savedSeq = dirtySeq;
      dirtySince = 0;
      clearDebounce();

      if (!emulator) return;

      const go9p = typeof window !== "undefined" ? window.Go9p : null;
      if (go9p && typeof go9p.watchRootMutations === "function") {
        unwatchFs = go9p.watchRootMutations(emulator, () => markDirty());
      }

      if (attached) return;
      attached = true;

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden" && !resetting && owner && isDirty()) {
          if (!handoffSaveToSW("hide")) {
            saveNow(activeEmulator, "hide");
          }
        }
      });

      window.addEventListener("pagehide", () => {
        clearDebounce();
        if (!resetting && owner && isDirty()) {
          if (!handoffSaveToSW("unload")) {
            saveNow(activeEmulator, "unload");
          }
        }
        releaseOwnerLock();
      });

      window.addEventListener("beforeunload", (e) => {
        if (resetting || !owner || !activeEmulator) return;
        if (!isDirty() && !saveInFlight) return;
        // Seamless refresh when SW handoff can save synchronously on pagehide;
        // only prompt the user if no SW controller is available.
        if (canSwHandoff()) return;
        e.preventDefault();
        e.returnValue = "";
      });
    },
  };

  if (typeof window !== "undefined") window.GoPersist = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
