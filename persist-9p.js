/* Keeps uploaded files out of the saved machine state, and guarantees the
 * restored /mnt/host is empty without running anything in the guest.
 *
 * NO PATCHING OF v86. assertV86StateShape() validates the v86 9p internals
 * before stripping. If a v86 upgrade ever changes the shape, shapeState becomes
 * "broken" and EVERY save safely falls back to original() (never crashing on
 * save #2).
 */
(function () {
  "use strict";

  const TAG = "[golinux/9p]";
  const S_IFMT = 0xf000;
  const S_IFDIR = 0x4000;

  const isDir = (mode) => (mode & S_IFMT) === S_IFDIR;

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
        throw new Error(TAG + " FS.get_state()[2] entries are not [id, data]");
      }
      if (!(entry[1] instanceof Uint8Array)) {
        throw new Error(TAG + " FS.get_state()[2][i][1] is not a Uint8Array");
      }
    }
    return true;
  }

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

  function install(emulator) {
    if (!emulator || typeof emulator.save_state !== "function") {
      throw new Error(TAG + " emulator.save_state is missing");
    }
    if (emulator.__gl9pWrapped) return () => {};

    const original = emulator.save_state.bind(emulator);
    let shapeState = "unchecked";   // "unchecked" | "ok" | "broken"

    emulator.save_state = async function wrappedSaveState() {
      const fs = emulator.fs9p;
      if (!fs || shapeState === "broken") return original();

      if (shapeState === "unchecked") {
        try {
          assertV86StateShape(fs);
          shapeState = "ok";
        } catch (e) {
          shapeState = "broken";
          console.error(e.message +
            " Uploads will be saved inside the state image until this is fixed.");
          return original();
        }
      }

      const r = await withEmptyShare(fs, () => original());
      if (typeof window !== "undefined") {
        window.__lastStrippedBytes = r.strippedBytes;
        window.__lastStrippedEntries = r.strippedEntries;
      }
      return r.result;
    };

    emulator.__gl9pWrapped = true;
    return function uninstall() {
      emulator.save_state = original;
      emulator.__gl9pWrapped = false;
    };
  }

  const api = { install, assertV86StateShape, withEmptyShare };
  if (typeof window !== "undefined") window.Go9p = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
