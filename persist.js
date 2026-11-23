/* GoLinux persistence.
 *
 * Saves v86 machine state (RAM + IDE write-back block cache) into OPFS,
 * gzip-compressed, and restores it on the next visit when buildId and schema
 * match.
 *
 * Invariants enforced here:
 *   - Build id single source of truth: uses stamped GL_BUILD_ID (falling back
 *     to images/build-id.json only in local unversioned dev). Never restores a
 *     saved state when buildId or schema differs, is missing, or is offline-null.
 *   - Monotonic dirtySeq: edits happening during an async save are never lost.
 *   - Atomic writes for BOTH state.gz and meta.json, with a Worker
 *     createSyncAccessHandle() fallback for Safari/WebKit and older Firefox.
 *   - Reset latch + Web Lock: clearUserState() permanently disarms unload saves
 *     before removing OPFS files, so Reset can never race with pagehide.
 *   - Worker error recovery: gzip/OPFS worker crashes never leave saveInFlight
 *     stuck true.
 */
(function () {
  "use strict";

  const DIR = "golinux";
  const SIZE_WARN_BYTES = 40 * 1024 * 1024;
  const SIZE_MAX_BYTES = 150 * 1024 * 1024;
  const STATE_FILE = "state.gz";
  const META_FILE = "meta.json";
  const BUILD_FILE = "images/build-id.json";
  const AUTOSAVE_MS = 30000;
  const IDLE_QUIET_MS = 2000;

  let owner = false;
  let resetting = false;
  let diskBusy = false;
  let dirtySeq = 1;           // monotonic edit counter
  let savedSeq = 0;           // dirtySeq value captured by last completed save
  let pausedForSize = false;
  let saveInFlight = false;
  let pendingSave = false;
  let lastSavedAt = 0;
  let lastActivity = Date.now();
  let buildId = null;
  let statusCb = () => {};
  let activeEmulator = null;
  let attached = false;

  function expectedSchema() {
    return typeof GL_STATE_SCHEMA === "number" ? GL_STATE_SCHEMA : 2;
  }

  function stampedBuildId() {
    return typeof GL_BUILD_ID === "string" && GL_BUILD_ID ? GL_BUILD_ID : "";
  }

  function setStatus(msg, kind) {
    statusCb(msg || "", kind || "");
  }

  function markDirty() {
    lastActivity = Date.now();
    dirtySeq++;
  }

  function isDirty() {
    return dirtySeq !== savedSeq;
  }

  /**
   * Pure compatibility predicate (exported for unit tests).
   * Returns { ok: boolean, reason?: string }.
   * Never allows restoring when buildId is unknown/mismatched or schema differs.
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
      // Even in local dev, require a non-empty matching id if both exist;
      // if expectedBuildId could not be determined at all, refuse rather than risk corruption.
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

  /**
   * Inline worker using FileSystemFileHandle.createSyncAccessHandle() for
   * browsers where main-thread createWritable() or handle.move() are missing
   * (Safari/WebKit, older Firefox).
   */
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

  /**
   * Write a file into OPFS atomically when createWritable()+move() are
   * supported, falling back to Worker createSyncAccessHandle() otherwise.
   */
  async function writeFileAtomic(fileName, dataBytes) {
    const buf = dataBytes instanceof ArrayBuffer
      ? dataBytes
      : dataBytes.buffer.slice(dataBytes.byteOffset, dataBytes.byteOffset + dataBytes.byteLength);

    let dir = null;
    try {
      dir = await opfsDir();
    } catch (e) {
      throw e;
    }

    const tmpName = fileName + ".tmp";
    let tmp = null;
    try {
      tmp = await dir.getFileHandle(tmpName, { create: true });
    } catch (e) {
      throw e;
    }

    if (typeof tmp.createWritable === "function" && typeof tmp.move === "function") {
      const w = await tmp.createWritable();
      try {
        await w.write(new Blob([buf]));
        await w.close();
      } catch (e) {
        try { await w.abort(); } catch (_) {}
        throw e;
      }
      await tmp.move(fileName);
      return;
    }

    // Cleanup unused .tmp handle best-effort, then write via SyncAccessHandle worker.
    try { await dir.removeEntry(tmpName); } catch (_) {}
    await writeViaSyncWorker(fileName, buf);
  }

  async function readMeta() {
    try {
      const dir = await opfsDir();
      const fh = await dir.getFileHandle(META_FILE);
      const text = await (await fh.getFile()).text();
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  async function writeMeta(meta) {
    const bytes = new TextEncoder().encode(JSON.stringify(meta));
    await writeFileAtomic(META_FILE, bytes);
  }

  async function hasUserState() {
    try {
      const dir = await opfsDir();
      await dir.getFileHandle(STATE_FILE);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Single source of truth: prefer stamped GL_BUILD_ID; fallback to build-id.json only in local dev. */
  async function loadBuildId() {
    const stamped = stampedBuildId();
    if (stamped) return stamped;
    try {
      const r = await fetch(BUILD_FILE, { cache: "no-store" });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.buildId ? String(j.buildId) : null;
    } catch (e) {
      return null;
    }
  }

  /* ---------- gzip in a Worker (with crash recovery) ---------- */

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

    // Never snapshot while the guest is mid-chunk-fetch (would freeze a pending
    // IDE read inside the state). For hide/manual saves, allow saving even inside
    // nano/vim/REPL because nothing injects into stdin on restore anymore.
    if (diskBusy) {
      pendingSave = true;
      if (reason !== "auto") setStatus("Waiting for disk load to finish before saving…", "");
      return false;
    }

    // Ensure we have a valid buildId before writing; never stamp null.
    if (!buildId) buildId = await loadBuildId();
    if (!buildId) {
      setStatus("Not saved: build id unknown.", "warn");
      return false;
    }

    saveInFlight = true;
    const seqAtStart = dirtySeq;
    setStatus("Saving…", "");

    let succeeded = false;
    try {
      const raw = await emu.save_state();
      if (resetting) return false;
      const gz = await gzipBuffer(raw);
      if (resetting) return false;

      if (gz.byteLength > SIZE_MAX_BYTES) {
        pausedForSize = true;
        setStatus(
          `Autosave paused: saved state is ${(gz.byteLength / 1048576).toFixed(0)} MB ` +
          `(limit ${SIZE_MAX_BYTES / 1048576} MB). Delete large files to resume saving.`,
          "error"
        );
        return false;
      }

      await withStateLock(async () => {
        if (resetting) return;
        await writeFileAtomic(STATE_FILE, gz);
        if (resetting) return;
        const prev = (await readMeta()) || {};
        await writeMeta({
          ...prev,
          schema: expectedSchema(),
          buildId,
          savedAt: Date.now(),
          bytes: gz.byteLength,
          reason: reason || "manual",
        });
      });

      if (resetting) return false;

      lastSavedAt = Date.now();
      savedSeq = seqAtStart;
      const wasPaused = pausedForSize;
      pausedForSize = false;
      succeeded = true;

      const mb = (gz.byteLength / 1048576).toFixed(1);
      if (gz.byteLength > SIZE_WARN_BYTES) {
        setStatus(`Saved ${mb} MB — getting large, saves may be slower.`, "warn");
      } else if (wasPaused) {
        setStatus(`Saving resumed (${mb} MB)`, "ok");
      } else {
        setStatus(`Saved ${mb} MB`, "ok");
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

    if (pendingSave && !resetting && !pausedForSize) {
      pendingSave = false;
      if (isDirty()) saveNow(emu, "auto");
    }
    return succeeded;
  }

  /* ---------- loading ---------- */

  async function loadUserState() {
    buildId = await loadBuildId();

    const meta = await readMeta();
    if (!meta || !(await hasUserState())) return null;

    const compat = isCompatibleMeta(meta, buildId, expectedSchema());
    if (!compat.ok) {
      if (compat.reason === "build-id-mismatch" || compat.reason === "schema-mismatch") {
        setStatus(
          "GoLinux was updated, so the previous saved session cannot be loaded. " +
          "Starting a fresh machine.",
          "warn"
        );
      } else {
        setStatus(
          "Saved session could not be verified for this version; starting fresh.",
          "warn"
        );
      }
      return null;
    }

    try {
      const dir = await opfsDir();
      const fh = await dir.getFileHandle(STATE_FILE);
      const gz = await (await fh.getFile()).arrayBuffer();
      const raw = await gunzipBuffer(gz);
      savedSeq = dirtySeq;
      setStatus("Restored (" + (gz.byteLength / 1048576).toFixed(1) + " MB)", "ok");
      return raw;
    } catch (e) {
      setStatus("Saved session was unreadable; started fresh.", "warn");
      return null;
    }
  }

  /* ---------- reset ---------- */

  function prepareReset() {
    resetting = true;
    pendingSave = false;
  }

  async function clearUserState() {
    prepareReset();
    try {
      return await withStateLock(async () => {
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

  async function claimOwnership() {
    if (!navigator.locks || !navigator.locks.request) {
      owner = true;
      return true;
    }
    return new Promise((resolve) => {
      navigator.locks.request("golinux-owner", { ifAvailable: true }, (lock) => {
        if (!lock) {
          owner = false;
          setStatus("Another tab is saving this session. Changes here won't be saved.", "warn");
          resolve(false);
          return;
        }
        owner = true;
        resolve(true);
        return new Promise(() => {});
      });
    });
  }

  /* ---------- public ---------- */

  const api = {
    AUTOSAVE_MS,
    SIZE_MAX_BYTES,
    claimOwnership,
    saveNow,
    loadUserState,
    clearUserState,
    prepareReset,
    hasUserState,
    readMeta,
    isCompatibleMeta,
    markDirty,
    setDiskBusy(busy) { diskBusy = !!busy; },
    getOwner: () => owner,
    getLastSavedAt: () => lastSavedAt,
    isDirty,
    isResetting: () => resetting,
    isSizePaused: () => pausedForSize,
    setStatusHandler(fn) { statusCb = fn || (() => {}); },

    attach(emulator) {
      activeEmulator = emulator;
      if (!owner || !emulator) return;

      emulator.add_listener("serial0-output-byte", markDirty);
      emulator.add_listener("virtio-console0-output-bytes", markDirty);

      if (attached) return;
      attached = true;

      document.addEventListener("keydown", markDirty, { capture: true });

      setInterval(() => {
        if (resetting || !activeEmulator) return;
        if (Date.now() - lastActivity < IDLE_QUIET_MS) return;
        if (pendingSave) {
          pendingSave = false;
          saveNow(activeEmulator, "auto");
          return;
        }
        saveNow(activeEmulator, "auto");
      }, AUTOSAVE_MS);

      setInterval(() => {
        if (resetting || !activeEmulator) return;
        if (pendingSave && !saveInFlight && !diskBusy &&
            Date.now() - lastActivity >= IDLE_QUIET_MS) {
          pendingSave = false;
          saveNow(activeEmulator, "auto");
        }
      }, 5000);

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden" && !resetting && isDirty()) {
          saveNow(activeEmulator, "hide");
        }
      });

      window.addEventListener("pagehide", () => {
        if (!resetting && isDirty()) {
          saveNow(activeEmulator, "unload");
        }
      });
    },
  };

  if (typeof window !== "undefined") window.GoPersist = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
