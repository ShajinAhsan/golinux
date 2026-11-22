/* Keeps uploaded files out of the saved machine state, and guarantees the
 * restored /mnt/host is empty without running anything in the guest.
 *
 * WHY
 * v86's 9p filesystem serialises, in FS.get_state():
 *   state[0] = the inode array, where each directory inode carries
 *              `direntries` (a Map of filename -> inode id)
 *   state[2] = [inodeId, Uint8Array] pairs holding every FILE's contents
 *
 * Uploads land there through create_file(), so a 40 MB upload made every
 * autosave 40 MB bigger and added ~0.5-1 s of freeze, even though /mnt/host is
 * only a drop zone.
 *
 * WHAT WE DO
 * While the snapshot is taken, the share is presented as an EMPTY TREE: file
 * contents are dropped AND the directory entries pointing at them are removed.
 * Both are restored immediately afterwards. The inode objects themselves stay
 * in place (they are the array slots), so nothing has to be rebuilt and no
 * inode is orphaned; the restored guest simply has a /mnt/host that lists
 * nothing.
 *
 * Because the saved state already contains an empty tree, nothing needs to run
 * in the guest after restore. That matters: sending `rm` over the serial
 * console echoes into whatever the user is running (a prompt, vim, a
 * half-typed command) and cannot be suppressed.
 *
 * NO PATCHING OF v86. This relies on internals, so assertV86StateShape()
 * validates them and fails loudly rather than silently regressing.
 * tools/test/check-9p-state-shape.js runs that check out of the browser against
 * the real emulator.
 */
(function () {
  "use strict";

  const TAG = "[golinux/9p]";

  /** 9p / POSIX mode helpers (S_IFMT is 0xF000). */
  const S_IFMT = 0xf000;
  const S_IFDIR = 0x4000;

  const isDir = (mode) => (mode & S_IFMT) === S_IFDIR;

  /**
   * Validate the v86 internals we depend on. Throws a precise error if an
   * upgrade changed them, so the wrapper degrades loudly instead of quietly
   * putting uploads back into the state.
   */
  function assertV86StateShape(fs) {
    if (!fs || typeof fs.get_state !== "function") {
      throw new Error(TAG + " fs9p.get_state() is missing; v86 changed");
    }
    if (!fs.inodedata || typeof fs.inodedata !== "object") {
      throw new Error(TAG + " fs9p.inodedata is missing; v86 changed");
    }
    if (!Array.isArray(fs.inodes) || fs.inodes.length === 0) {
      throw new Error(TAG + " fs9p.inodes is missing or empty; v86 changed");
    }

    const root = fs.inodes[0];
    if (!root || !(root.direntries instanceof Map)) {
      throw new Error(TAG + " root inode.direntries is not a Map; v86 changed");
    }
    if (typeof root.mode !== "number") {
      throw new Error(TAG + " inode.mode is not a number; v86 changed");
    }
    if (!isDir(root.mode)) {
      throw new Error(TAG + " inode 0 is no longer a directory; v86 changed");
    }

    // FS.get_state() must still be the shape we strip.
    const probe = fs.get_state();
    if (!Array.isArray(probe) || probe.length < 5) {
      throw new Error(TAG + " FS.get_state() no longer returns 5+ slots");
    }
    if (!Array.isArray(probe[0])) {
      throw new Error(TAG + " FS.get_state()[0] is no longer the inode array");
    }
    if (!Array.isArray(probe[2])) {
      throw new Error(TAG + " FS.get_state()[2] is no longer the file-data array");
    }
    for (const entry of probe[2]) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
        throw new Error(TAG + " FS.get_state()[2] entries are no longer [id, data]");
      }
      if (!(entry[1] instanceof Uint8Array)) {
        throw new Error(TAG + " FS.get_state()[2][i][1] is no longer a Uint8Array");
      }
    }
    return true;
  }

  /**
   * Run `fn` with the 9p share presented as an empty tree, then restore exactly
   * what was there - even if fn throws.
   *
   * "Empty tree" means:
   *   - inodedata replaced with {}, so no file contents are serialised
   *   - every directory's direntries cleared except "." and "..", so no
   *     filename points at a file whose contents are gone
   */
  async function withEmptyShare(fs, fn) {
    const savedData = fs.inodedata;
    const savedDirs = [];

    let strippedBytes = 0;
    for (const id of Object.keys(savedData)) {
      const buf = savedData[id];
      if (buf && typeof buf.byteLength === "number") strippedBytes += buf.byteLength;
    }

    let strippedEntries = 0;
    for (const inode of fs.inodes) {
      if (!inode || !(inode.direntries instanceof Map) || !isDir(inode.mode)) continue;
      // Keep "." and ".." so the directory stays traversable and nlinks stays
      // consistent; drop everything else.
      const drop = [...inode.direntries.keys()].filter((n) => n !== "." && n !== "..");
      if (!drop.length) continue;
      savedDirs.push([inode, inode.direntries]);
      const kept = new Map();
      for (const [name, idx] of inode.direntries) {
        if (name === "." || name === "..") kept.set(name, idx);
      }
      inode.direntries = kept;
      strippedEntries += drop.length;
    }

    fs.inodedata = {};
    try {
      const result = await fn();
      return { result, strippedBytes, strippedEntries };
    } finally {
      fs.inodedata = savedData;
      for (const [inode, map] of savedDirs) inode.direntries = map;
    }
  }

  /**
   * Replace emulator.save_state with one that never captures uploads.
   * Returns an uninstall function.
   */
  function install(emulator) {
    if (!emulator || typeof emulator.save_state !== "function") {
      throw new Error(TAG + " emulator.save_state is missing");
    }
    if (emulator.__pl9pWrapped) return () => {};

    const original = emulator.save_state.bind(emulator);
    let validated = false;

    emulator.save_state = async function wrappedSaveState() {
      const fs = emulator.fs9p;
      if (!fs) return original();          // no 9p device: unchanged behaviour

      if (!validated) {
        validated = true;
        try {
          assertV86StateShape(fs);
        } catch (e) {
          // Never break saving: fall back to the old (bloated) behaviour and
          // say exactly why, once.
          console.error(e.message +
            " Uploads will be saved inside the state image until this is fixed.");
          return original();
        }
      }

      const r = await withEmptyShare(fs, () => original());
      window.__lastStrippedBytes = r.strippedBytes;
      window.__lastStrippedEntries = r.strippedEntries;
      return r.result;
    };

    emulator.__pl9pWrapped = true;
    return function uninstall() {
      emulator.save_state = original;
      emulator.__pl9pWrapped = false;
    };
  }

  window.Go9p = { install, assertV86StateShape, withEmptyShare };
})();
