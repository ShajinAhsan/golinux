/* GoLinux persistence.
 *
 * Approach: save_state() into OPFS, gzip-compressed, restored on the next visit
 * instead of the shipped snapshot.
 *
 * Why this works: v86 serves the disk from read-only chunks, so every guest
 * write lands in the IDE write-back block cache, and save_state() serialises
 * that cache. A state therefore contains the user's files, compiled binaries,
 * working directory, shell history and running processes. Proven by
 * tools/image/experiment-persist.js.
 *
 * Why gzip and not zstd: save_state() has no compression option, restore_state
 * natively understands only raw or zstd, and CompressionStream has no zstd
 * (verified: gzip, deflate, deflate-raw only). So we gzip here and inflate
 * before handing the bytes to v86.
 *
 * Why a Worker: save_state() itself blocks ~160 ms (it walks guest RAM), which
 * we cannot avoid, but gzip costs another ~600 ms and runs in a Worker so the
 * terminal stays responsive.
 */
(function () {
  const DIR = "golinux";

  // Above this, autosaves get slow and storage grows fast. Measured: 50 MB of
  // files in /root produced a 108 MB state and a ~1.85 s freeze per save.
  const SIZE_WARN_BYTES = 40 * 1024 * 1024;

  // Hard limit. Above this autosave stops entirely rather than grinding the
  // page to a halt: measured, 50 MB of files in /root already produced a
  // 108 MB state and a ~1.85 s freeze per save, and it grows linearly.
  const SIZE_MAX_BYTES = 150 * 1024 * 1024;
  const STATE_FILE = "state.gz";
  const META_FILE = "meta.json";
  const BUILD_FILE = "images/build-id.json";

  // Autosave cadence. 30 s bounds worst-case loss to half a minute, while a
  // save costs ~160 ms of main-thread time plus a background gzip; doing that
  // every 30 s is invisible in practice, more often is not worth the churn.
  const AUTOSAVE_MS = 30000;

  let owner = false;          // this tab holds the persistence lock
  let atPrompt = false;       // the shell is idle at a prompt (safe to save)
  // "Dirty" means guest output or user input happened since the last save.
  // We cannot compare instruction counters: they advance ~1M/sec even while
  // idle, because IRQ timers keep firing, so a counter check would never skip
  // a save. Terminal activity is the cheap signal that actually corresponds to
  // a state change, and reading a boolean costs nothing.
  let dirty = true;
  // Set when the last attempt exceeded SIZE_MAX_BYTES. Autosave stays paused
  // until a later attempt (manual, or after files are deleted) is back under
  // the limit, so we do not keep hammering a state we know is too big.
  let pausedForSize = false;
  let saveInFlight = false;
  let pendingSave = false;
  let lastSavedAt = 0;
  let buildId = null;
  let statusCb = () => {};

  /* ---------- helpers ---------- */

  function setStatus(msg, kind) {
    statusCb(msg || "", kind || "");
  }

  async function opfsDir() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(DIR, { create: true });
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
    const dir = await opfsDir();
    const fh = await dir.getFileHandle(META_FILE, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(meta));
    await w.close();
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

  /** The shipped build fingerprint. User states are only valid for this build. */
  async function loadBuildId() {
    try {
      const r = await fetch(BUILD_FILE, { cache: "no-cache" });
      if (!r.ok) return null;
      const j = await r.json();
      return j.buildId || null;
    } catch (e) {
      return null;
    }
  }

  /* ---------- gzip in a Worker ---------- */

  let gzipWorker = null;
  let gzipSeq = 0;
  const gzipPending = new Map();

  function ensureWorker() {
    if (gzipWorker) return gzipWorker;
    const src = `
      self.onmessage = async (e) => {
        const { id, buf } = e.data;
        try {
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
    gzipWorker.onmessage = e => {
      const { id, out, error } = e.data;
      const p = gzipPending.get(id);
      if (!p) return;
      gzipPending.delete(id);
      if (error) p.reject(new Error(error)); else p.resolve(out);
    };
    return gzipWorker;
  }

  function gzipBuffer(buffer) {
    return new Promise((resolve, reject) => {
      const id = ++gzipSeq;
      gzipPending.set(id, { resolve, reject });
      ensureWorker().postMessage({ id, buf: buffer }, [buffer]);
    });
  }

  async function gunzipBuffer(buffer) {
    const ds = new DecompressionStream("gzip");
    return new Response(new Blob([buffer]).stream().pipeThrough(ds)).arrayBuffer();
  }

  /* ---------- saving ---------- */

  /**
   * Serialise the machine and write it to OPFS.
   * Writes go to a temp file and are then renamed, and the whole operation is
   * wrapped in a Web Lock, so two tabs can never interleave a half-written
   * state.
   */
  async function saveNow(emulator, reason) {
    if (!emulator) return;
    if (!owner) {
      // Return loudly: silently doing nothing made a failed save look like it
      // had succeeded, because the previous status text stayed on screen.
      setStatus("Not saved: another tab is saving this session.", "warn");
      return;
    }
    if (saveInFlight) { pendingSave = true; return; }

    // Paused because the state got too large: skip automatic saves, but keep
    // manual ones working so the user can still force a save if they want.
    if (reason === "auto" && pausedForSize) {
      return;
    }

    // Nothing has happened since the last save: skip it. This costs one
    // boolean read, and avoids a ~150 ms main-thread walk plus a gzip pass.
    if (reason === "auto" && !dirty && lastSavedAt) {
      return;
    }

    // Never snapshot a guest that is in the middle of a command. If a program
    // is blocked (for example on a chunk that cannot be fetched), saving it
    // makes that blocked process part of the saved state: on restore the shell
    // never returns to its prompt and typing appears to do nothing.
    if (!atPrompt) {
      // Defer, do not drop: remember that a save is owed and retry on the next
      // tick. Dropping it silently was losing user data.
      pendingSave = true;
      setStatus("Waiting for the shell to be idle before saving…", "");
      return;
    }

    saveInFlight = true;
    setStatus(reason === "auto" ? "Saving…" : "Saving…", "");

    try {
      const raw = await emulator.save_state();     // ~160 ms, main thread
      const gz = await gzipBuffer(raw);            // ~600 ms, in a Worker

      // Hard limit: do not write an oversized state at all. Check before the
      // write so storage is not spent on a file we would immediately abandon.
      if (gz.byteLength > SIZE_MAX_BYTES) {
        pausedForSize = true;
        dirty = true;   // still unsaved: a later save must try again
        setStatus(
          `Autosave paused: your files make the saved state ` +
          `${(gz.byteLength / 1048576).toFixed(0)} MB, over the ` +
          `${SIZE_MAX_BYTES / 1048576} MB limit. Use Download /root to keep a ` +
          `copy, then delete files you no longer need — saving resumes ` +
          `automatically once you are under the limit.`, "error");
        saveInFlight = false;
        return;
      }

      await navigator.locks.request("golinux-state", async () => {
        const dir = await opfsDir();

        // Temp file, then move() for an atomic replace. A crash mid-write
        // leaves the previous good state untouched.
        const tmp = await dir.getFileHandle(STATE_FILE + ".tmp", { create: true });
        const w = await tmp.createWritable();
        await w.write(new Blob([gz]));
        await w.close();
        await tmp.move(STATE_FILE);

        const meta = await readMeta() || {};
        await writeMeta({
          ...meta,
          buildId,
          savedAt: Date.now(),
          bytes: gz.byteLength,
          reason: reason || "manual",
        });
      });

      lastSavedAt = Date.now();
      dirty = false;   // state now matches what is on disk
      if (pausedForSize) {
        pausedForSize = false;
        setStatus("Saving resumed: the state is under the size limit again.", "ok");
        lastSavedAt = Date.now();
      }

      const mb = gz.byteLength / 1048576;
      if (gz.byteLength > SIZE_WARN_BYTES) {
        setStatus(
          `Saved ${mb.toFixed(1)} MB — your files are getting large, so saves ` +
          `are slower. Use Download /root to keep a copy, then delete what you ` +
          `no longer need.`, "warn");
      } else {
        setStatus("Saved " + mb.toFixed(1) + " MB", "ok");
      }
    } catch (e) {
      const name = e && e.name;
      if (name === "QuotaExceededError") {
        setStatus("Not saved: storage is full. Use Reset to free space.", "error");
      } else if (name === "SecurityError" || name === "InvalidStateError") {
        setStatus("Not saved: storage is blocked (private browsing?).", "error");
      } else {
        setStatus("Not saved: " + (e.message || name), "error");
      }
    } finally {
      saveInFlight = false;
    }

    if (pendingSave) {
      pendingSave = false;
      saveNow(emulator, "auto");
    }
  }

  /* ---------- loading ---------- */

  /**
   * Returns an ArrayBuffer of a restorable user state, or null.
   * Refuses states saved against a different shipped build, because a state
   * embeds guest RAM and the IDE cache: restoring it on top of a changed disk
   * would show stale file contents.
   */
  async function loadUserState() {
    buildId = await loadBuildId();

    const meta = await readMeta();
    if (!meta || !(await hasUserState())) return null;

    if (buildId && meta.buildId && meta.buildId !== buildId) {
      // Tell the user what happened to their files, and what to do next time.
      // A saved state embeds guest RAM and the disk cache, so restoring it onto
      // a changed image would show stale file contents.
      setStatus(
        "This app was updated, so your previously saved session cannot be " +
        "loaded — files saved in the old version are not available here. " +
        "Next time, use Download /root to keep a copy outside the browser " +
        "before updating. Starting a fresh machine.", "warn");
      // Keep the bytes but never restore them; Reset clears them.
      return null;
    }

    try {
      const dir = await opfsDir();
      const fh = await dir.getFileHandle(STATE_FILE);
      const gz = await (await fh.getFile()).arrayBuffer();
      const raw = await gunzipBuffer(gz);
      setStatus("Restored your session (" + (gz.byteLength / 1048576).toFixed(1) + " MB)", "ok");
      return raw;
    } catch (e) {
      // Corrupt or unreadable: fall back to the shipped snapshot.
      setStatus("Your saved session was unreadable and has been ignored; " +
        "the machine started fresh.", "warn");
      return null;
    }
  }

  /* ---------- reset ---------- */

  async function clearUserState() {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(DIR, { recursive: true });
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------- ownership ---------- */

  /**
   * Only one tab may autosave. Two tabs each holding a whole VM would overwrite
   * one another's files, so the first tab takes the lock and the others say so.
   * The lock is held for the lifetime of the tab and released automatically
   * when it closes, letting a later tab take over on its next visit.
   */
  async function claimOwnership() {
    if (!navigator.locks) { owner = true; return true; }
    return new Promise(resolve => {
      navigator.locks.request("golinux-owner", { ifAvailable: true }, lock => {
        if (!lock) {
          owner = false;
          setStatus("Another tab is saving this session. Changes here will not be saved.", "warn");
          resolve(false);
          return;
        }
        owner = true;
        resolve(true);
        // Hold the lock until the tab goes away.
        return new Promise(() => {});
      });
    });
  }

  /* ---------- public ---------- */

  window.GoPersist = {
    AUTOSAVE_MS,
    claimOwnership,
    saveNow,
    loadUserState,
    clearUserState,
    hasUserState,
    readMeta,
    getOwner: () => owner,
    getLastSavedAt: () => lastSavedAt,
    isDirty: () => dirty,
    isSizePaused: () => pausedForSize,
    SIZE_MAX_BYTES,
    setStatusHandler(fn) { statusCb = fn; },

    /**
     * Wire autosave to the emulator: interval, tab hide, and page unload.
     *
     * save_state() is synchronous and walks all of guest RAM, so it freezes the
     * page for ~150 ms (measured). There is no async variant in v86, so instead
     * of saving blindly every 30 s we wait for a quiet moment: if the user typed
     * or the guest produced output in the last IDLE_QUIET_MS, the save is
     * deferred. The hitch then lands while nothing is happening.
     */
    attach(emulator) {
      if (!owner) return;

      let lastActivity = Date.now();
      const markActivity = () => { lastActivity = Date.now(); };

      // Track whether the shell is sitting at a prompt, so we only snapshot a
      // quiescent guest. Our prompt ends with "# " for root; the same check
      // works for the "$ " of a normal user.
      atPrompt = false;
      let tail = "";
      emulator.add_listener("serial0-output-byte", byte => {
        markActivity();
        dirty = true;
        tail = (tail + String.fromCharCode(byte)).slice(-400);
      });
      document.addEventListener("keydown", () => { markActivity(); dirty = true; },
        { capture: true });

      // Re-evaluated just before each save.
      setInterval(() => {
        const clean = tail.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
        atPrompt = /[#$]\s*$/.test(clean.trimEnd());
      }, 500);

      const IDLE_QUIET_MS = 2000;

      setInterval(() => {
        if (Date.now() - lastActivity < IDLE_QUIET_MS) return;  // busy: skip

        // Run a pending (previously deferred) save even if the timer has not
        // come round again, so a save owed from a busy moment is not lost.
        if (pendingSave) { pendingSave = false; saveNow(emulator, "auto"); return; }
        saveNow(emulator, "auto");
      }, AUTOSAVE_MS);

      // Faster retry for a save that was deferred because the shell was busy.
      setInterval(() => {
        if (pendingSave && !saveInFlight && atPrompt &&
            Date.now() - lastActivity >= IDLE_QUIET_MS) {
          pendingSave = false;
          saveNow(emulator, "auto");
        }
      }, 5000);

      // Hidden fires before pagehide and while async work can still complete,
      // so this is the reliable "tab switched away / closed" save point.
      // Save immediately here: correctness beats smoothness, and the page is
      // about to stop being visible anyway.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") saveNow(emulator, "hide");
      });

      window.addEventListener("pagehide", () => { saveNow(emulator, "unload"); });
    },
  };
})();
