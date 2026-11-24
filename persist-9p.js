/* GoLinux 9p filesystem helpers:
 *
 * 1. Portable /root persistence over v86's 9p share (/run/host9p/root -> /root):
 *    - exportRootTree / importRootTree walk ONLY the /root subtree while
 *      leaving inode 0 (/run/host9p), rootId (/root, bash cwd), and hostId
 *      (/mnt/host) completely intact so Linux's open 9p fids stay valid on
 *      every fresh snapshot boot.
 *    - encodeRootArchive / decodeRootArchive serialize /root into the compact
 *      binary "GLFS" v1 format (~0.2 ms for typical workspaces, immune to
 *      kernel/snapshot/buildId upgrades).
 *    - watchRootMutations hooks fs9p mutations + TSETATTR (chmod/touch) under
 *      /root while ignoring /mnt/host transfers.
 *
 * 2. Legacy save_state() /mnt/host stripping wrapper (kept for compatibility
 *    and check-9p-state-shape.js): validates v86 9p internals once and falls
 *    back safely to original() if v86's internal shape ever changes.
 */
(function () {
  "use strict";

  const TAG = "[golinux/9p]";
  const S_IFMT = 0xf000;
  const S_IFDIR = 0x4000;
  const S_IFREG = 0x8000;
  const S_IFLNK = 0xa000;
  const ROOT_DIR_NAME = "root";
  const HOST_DIR_NAME = "host";
  const GLFS_MAGIC = [0x47, 0x4c, 0x46, 0x53]; // "GLFS"
  const GLFS_VERSION = 1;
  const MAX_DEPTH = 48;

  const isDir = (mode) => (mode & S_IFMT) === S_IFDIR;
  const isReg = (mode) => (mode & S_IFMT) === S_IFREG;
  const isLnk = (mode) => (mode & S_IFMT) === S_IFLNK;

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

  /* ---------- /root subtree detection, export, import, codec ---------- */

  function findSubdirId(fs, name) {
    if (!fs || !Array.isArray(fs.inodes) || !fs.inodes[0]) return -1;
    if (typeof fs.Search === "function") {
      try {
        const id = fs.Search(0, name);
        if (typeof id === "number" && id > 0 && fs.inodes[id] && isDir(fs.inodes[id].mode)) {
          return id;
        }
      } catch (_) {}
    }
    const root = fs.inodes[0];
    if (root && root.direntries instanceof Map) {
      const id = root.direntries.get(name);
      if (typeof id === "number" && id > 0 && fs.inodes[id] && isDir(fs.inodes[id].mode)) {
        return id;
      }
    }
    return -1;
  }

  function findRootDirId(fs) {
    return findSubdirId(fs, ROOT_DIR_NAME);
  }

  function findHostDirId(fs) {
    return findSubdirId(fs, HOST_DIR_NAME);
  }

  function findParentInode(fs, childId) {
    const ino = fs.inodes[childId];
    if (ino && ino.direntries instanceof Map && ino.direntries.has("..")) {
      return ino.direntries.get("..");
    }
    if (typeof fs.GetParent === "function") {
      try {
        const p = fs.GetParent(childId);
        if (typeof p === "number" && p >= 0) return p;
      } catch (_) {}
    }
    for (let i = 0; i < fs.inodes.length; i++) {
      const dir = fs.inodes[i];
      if (!dir || !isDir(dir.mode) || !(dir.direntries instanceof Map)) continue;
      for (const [name, cid] of dir.direntries) {
        if (name !== "." && name !== ".." && cid === childId) return i;
      }
    }
    return -1;
  }

  function isDescendantOf(fs, inodeId, ancestorId) {
    if (!(inodeId >= 0) || !(ancestorId >= 0) || !fs || !Array.isArray(fs.inodes)) return false;
    if (inodeId === ancestorId) return true;
    let cur = inodeId;
    for (let i = 0; i < MAX_DEPTH + 4; i++) {
      const parent = findParentInode(fs, cur);
      if (parent === ancestorId) return true;
      if (parent < 0 || parent === cur || parent === 0) return false;
      cur = parent;
    }
    return false;
  }

  /**
   * Synchronously walk the /root subtree in fs9p and return portable entries.
   * Never touches /host (/mnt/host) or root inode 0.
   */
  function exportRootTree(fs) {
    const rootId = findRootDirId(fs);
    if (rootId < 1) return null;

    const entries = [];
    const visited = new Set();
    let fileCount = 0;
    let totalBytes = 0;

    function walk(dirId, prefix, depth) {
      if (depth > MAX_DEPTH || visited.has(dirId)) return;
      const ino = fs.inodes[dirId];
      if (!ino || !(ino.direntries instanceof Map)) return;
      visited.add(dirId);

      const names = Array.from(ino.direntries.keys()).sort();
      for (const name of names) {
        if (name === "." || name === "..") continue;
        const cid = ino.direntries.get(name);
        const child = fs.inodes[cid];
        if (!child || typeof child.mode !== "number") continue;
        // Skip deleted/unlinked zombie inodes
        if (child.status === 4 || child.status === -1) continue;

        const rel = prefix ? prefix + "/" + name : name;
        const mtime = typeof child.mtime === "number" ? child.mtime : Math.floor(Date.now() / 1000);
        if (isDir(child.mode)) {
          entries.push({ p: rel, t: "d", m: child.mode, mt: mtime });
          walk(cid, rel, depth + 1);
        } else if (isReg(child.mode)) {
          const size = Math.max(0, Number(child.size) || 0);
          const raw = fs.inodedata && fs.inodedata[cid];
          let bytes;
          if (size === 0 || !raw) {
            bytes = new Uint8Array(0);
          } else if (raw.byteLength >= size) {
            bytes = raw.slice(0, size);
          } else {
            bytes = new Uint8Array(size);
            bytes.set(raw, 0);
          }
          fileCount++;
          totalBytes += bytes.byteLength;
          entries.push({ p: rel, t: "f", m: child.mode, mt: mtime, b: bytes });
        } else if (isLnk(child.mode)) {
          fileCount++;
          entries.push({
            p: rel,
            t: "l",
            m: child.mode,
            mt: mtime,
            s: typeof child.symlink === "string" ? child.symlink : "",
          });
        }
      }
    }

    walk(rootId, "", 0);
    return { entries, fileCount, totalBytes };
  }

  /**
   * Synchronously encode an exported /root tree into compact binary GLFS v1:
   *   [0..3]  "GLFS"
   *   [4..7]  uint32 LE version (1)
   *   [8..11] uint32 LE header JSON byte length
   *   [12..]  UTF-8 header JSON
   *   [..]    concatenated raw Uint8Array bytes of every type "f" entry
   */
  function encodeRootArchive(tree, savedAt) {
    const entries = (tree && Array.isArray(tree.entries)) ? tree.entries : [];
    const metaEntries = [];
    const chunks = [];
    let dataBytes = 0;
    let fileCount = 0;

    for (const e of entries) {
      if (!e || typeof e.p !== "string" || !e.p) continue;
      if (e.t === "d") {
        metaEntries.push({ p: e.p, t: "d", m: e.m >>> 0, mt: e.mt | 0 });
      } else if (e.t === "f") {
        const b = e.b instanceof Uint8Array ? e.b : new Uint8Array(0);
        metaEntries.push({ p: e.p, t: "f", m: e.m >>> 0, mt: e.mt | 0, len: b.byteLength });
        chunks.push(b);
        dataBytes += b.byteLength;
        fileCount++;
      } else if (e.t === "l") {
        metaEntries.push({ p: e.p, t: "l", m: e.m >>> 0, mt: e.mt | 0, s: String(e.s || "") });
        fileCount++;
      }
    }

    const headerObj = {
      v: GLFS_VERSION,
      savedAt: typeof savedAt === "number" ? savedAt : Date.now(),
      fileCount,
      entries: metaEntries,
    };
    const headerBytes = new TextEncoder().encode(JSON.stringify(headerObj));
    const totalLen = 12 + headerBytes.byteLength + dataBytes;
    const out = new Uint8Array(totalLen);
    out[0] = GLFS_MAGIC[0];
    out[1] = GLFS_MAGIC[1];
    out[2] = GLFS_MAGIC[2];
    out[3] = GLFS_MAGIC[3];
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    dv.setUint32(4, GLFS_VERSION, true);
    dv.setUint32(8, headerBytes.byteLength, true);
    out.set(headerBytes, 12);

    let off = 12 + headerBytes.byteLength;
    for (const b of chunks) {
      out.set(b, off);
      off += b.byteLength;
    }
    return out;
  }

  /**
   * Decode and strictly validate a GLFS v1 archive ArrayBuffer/Uint8Array.
   * Throws on corrupt magic, unsupported version, truncated payload, or unsafe paths.
   */
  function decodeRootArchive(input) {
    const bytes = input instanceof Uint8Array
      ? input
      : new Uint8Array(input);
    if (bytes.byteLength < 12) {
      throw new Error(TAG + " archive too short");
    }
    for (let i = 0; i < 4; i++) {
      if (bytes[i] !== GLFS_MAGIC[i]) {
        throw new Error(TAG + " invalid archive magic");
      }
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = dv.getUint32(4, true);
    if (version !== GLFS_VERSION) {
      throw new Error(TAG + " unsupported archive version: " + version);
    }
    const headerLen = dv.getUint32(8, true);
    if (headerLen === 0 || 12 + headerLen > bytes.byteLength) {
      throw new Error(TAG + " invalid archive header length");
    }
    const headerText = new TextDecoder().decode(bytes.subarray(12, 12 + headerLen));
    const header = JSON.parse(headerText);
    if (!header || header.v !== GLFS_VERSION || !Array.isArray(header.entries)) {
      throw new Error(TAG + " malformed archive header");
    }

    let off = 12 + headerLen;
    const entries = [];
    let fileCount = 0;
    for (const item of header.entries) {
      if (!item || typeof item.p !== "string" || !item.p) {
        throw new Error(TAG + " invalid entry path");
      }
      const segs = item.p.split("/");
      if (segs.some((s) => !s || s === "." || s === "..")) {
        throw new Error(TAG + " unsafe entry path: " + item.p);
      }
      if (item.t === "d") {
        entries.push({
          p: item.p,
          t: "d",
          m: (typeof item.m === "number" ? item.m : (S_IFDIR | 0o755)) >>> 0,
          mt: Number(item.mt) || 0,
        });
      } else if (item.t === "f") {
        const len = Number(item.len);
        if (!Number.isInteger(len) || len < 0 || off + len > bytes.byteLength) {
          throw new Error(TAG + " truncated file payload for " + item.p);
        }
        entries.push({
          p: item.p,
          t: "f",
          m: (typeof item.m === "number" ? item.m : (S_IFREG | 0o644)) >>> 0,
          mt: Number(item.mt) || 0,
          b: bytes.slice(off, off + len),
        });
        off += len;
        fileCount++;
      } else if (item.t === "l") {
        entries.push({
          p: item.p,
          t: "l",
          m: (typeof item.m === "number" ? item.m : (S_IFLNK | 0o777)) >>> 0,
          mt: Number(item.mt) || 0,
          s: String(item.s || ""),
        });
        fileCount++;
      } else {
        throw new Error(TAG + " unknown entry type: " + item.t);
      }
    }
    if (off !== bytes.byteLength) {
      throw new Error(TAG + " trailing bytes in archive");
    }

    return {
      v: GLFS_VERSION,
      savedAt: typeof header.savedAt === "number" ? header.savedAt : 0,
      fileCount,
      entries,
    };
  }

  /**
   * Synchronously restore saved /root entries into fs9p under rootId without
   * replacing inode 0, rootId, or hostId (preserving Linux's open 9p fids).
   */
  function importRootTree(fs, entries) {
    const rootId = findRootDirId(fs);
    if (rootId < 1) {
      throw new Error(TAG + " cannot restore /root: fs9p has no root directory");
    }

    function clearDir(dirId) {
      const ino = fs.inodes[dirId];
      if (!ino || !(ino.direntries instanceof Map)) return;
      for (const [name, cid] of Array.from(ino.direntries)) {
        if (name === "." || name === "..") continue;
        const child = fs.inodes[cid];
        if (child && isDir(child.mode)) clearDir(cid);
        fs.Unlink(dirId, name);
        if (fs.inodes[cid] && fs.inodes[cid].nlinks <= 0) {
          delete fs.inodedata[cid];
        }
      }
    }

    clearDir(rootId);

    const dirCache = new Map([["", rootId]]);
    function ensureDir(rel) {
      if (dirCache.has(rel)) return dirCache.get(rel);
      const parts = rel.split("/");
      let cur = "";
      let curId = rootId;
      for (const part of parts) {
        if (!part || part === "." || part === "..") continue;
        cur = cur ? cur + "/" + part : part;
        if (dirCache.has(cur)) {
          curId = dirCache.get(cur);
          continue;
        }
        let nextId = typeof fs.Search === "function"
          ? fs.Search(curId, part)
          : (fs.inodes[curId].direntries.has(part) ? fs.inodes[curId].direntries.get(part) : -1);
        if (nextId === -1) {
          nextId = fs.CreateDirectory(part, curId);
        }
        dirCache.set(cur, nextId);
        curId = nextId;
      }
      return curId;
    }

    let restoredFiles = 0;
    for (const e of entries) {
      if (!e || typeof e.p !== "string" || !e.p) continue;
      const slash = e.p.lastIndexOf("/");
      const parentRel = slash === -1 ? "" : e.p.slice(0, slash);
      const base = slash === -1 ? e.p : e.p.slice(slash + 1);
      const pid = ensureDir(parentRel);

      if (e.t === "d") {
        const id = ensureDir(e.p);
        const ino = fs.inodes[id];
        if (ino) {
          ino.mode = (e.m & 0o7777) | S_IFDIR;
          if (e.mt) ino.mtime = ino.ctime = e.mt;
        }
      } else if (e.t === "f") {
        const existing = typeof fs.Search === "function" ? fs.Search(pid, base) : -1;
        if (existing !== -1) fs.Unlink(pid, base);
        const id = fs.CreateFile(base, pid);
        const ino = fs.inodes[id];
        const data = e.b instanceof Uint8Array ? new Uint8Array(e.b) : new Uint8Array(0);
        if (ino) {
          ino.mode = (e.m & 0o7777) | S_IFREG;
          ino.size = data.byteLength;
          if (e.mt) ino.mtime = ino.ctime = e.mt;
        }
        fs.inodedata[id] = data;
        restoredFiles++;
      } else if (e.t === "l") {
        const existing = typeof fs.Search === "function" ? fs.Search(pid, base) : -1;
        if (existing !== -1) fs.Unlink(pid, base);
        const id = fs.CreateSymlink(base, pid, String(e.s || ""));
        const ino = fs.inodes[id];
        if (ino && e.mt) ino.mtime = ino.ctime = e.mt;
        restoredFiles++;
      }
    }

    return restoredFiles;
  }

  /**
   * Watch fs9p mutations (and TSETATTR chmod/touch) under /root while ignoring
   * temporary /mnt/host transfers. Calls onMutate(action) synchronously.
   */
  function watchRootMutations(emulator, onMutate) {
    const fs = emulator && emulator.fs9p;
    if (!fs || typeof onMutate !== "function") return () => {};

    const hostId = findHostDirId(fs);
    const shouldNotify = (inodeId) => {
      if (hostId > 0 && typeof inodeId === "number" && inodeId >= 0) {
        if (isDescendantOf(fs, inodeId, hostId)) return false;
      }
      return true;
    };

    const origNotify = fs.NotifyListeners;
    fs.NotifyListeners = function wrappedNotify(id, action, info) {
      if (shouldNotify(id)) {
        try { onMutate(action || "mutate", id); } catch (_) {}
      }
      return origNotify ? origNotify.call(this, id, action, info) : undefined;
    };

    const origSymlink = fs.CreateSymlink;
    if (typeof origSymlink === "function") {
      fs.CreateSymlink = function wrappedSymlink(name, parentId, target) {
        const res = origSymlink.call(this, name, parentId, target);
        if (shouldNotify(parentId)) {
          try { onMutate("symlink", res); } catch (_) {}
        }
        return res;
      };
    }

    const origChangeSize = fs.ChangeSize;
    if (typeof origChangeSize === "function") {
      fs.ChangeSize = async function wrappedChangeSize(id, size) {
        const res = await origChangeSize.call(this, id, size);
        if (shouldNotify(id)) {
          try { onMutate("truncate", id); } catch (_) {}
        }
        return res;
      };
    }

    const origUnlink = fs.Unlink;
    if (typeof origUnlink === "function") {
      fs.Unlink = function wrappedUnlink(parentId, name) {
        const notify = shouldNotify(parentId);
        const res = origUnlink.call(this, parentId, name);
        if (res === 0 && notify) {
          try { onMutate("unlink", parentId); } catch (_) {}
        }
        return res;
      };
    }

    const origLink = fs.Link;
    if (typeof origLink === "function") {
      fs.Link = function wrappedLink(parentId, targetId, name) {
        const res = origLink.call(this, parentId, targetId, name);
        if (res === 0 && shouldNotify(parentId)) {
          try { onMutate("link", targetId); } catch (_) {}
        }
        return res;
      };
    }

    // Hook virtio_9p BuildReply for TSETATTR (opcode 26: chmod, chown, touch)
    // so mode/mtime changes trigger immediate persistence too.
    const dev9p = emulator.v86 && emulator.v86.cpu && emulator.v86.cpu.devices &&
                  emulator.v86.cpu.devices.virtio_9p;
    const origBuildReply = dev9p && typeof dev9p.BuildReply === "function"
      ? dev9p.BuildReply
      : null;
    if (dev9p && origBuildReply) {
      dev9p.BuildReply = function wrappedBuildReply(op, tag, payloadSize) {
        if (op === 26) {
          try { onMutate("setattr", -1); } catch (_) {}
        }
        return origBuildReply.call(this, op, tag, payloadSize);
      };
    }

    return function unwatch() {
      fs.NotifyListeners = origNotify;
      if (origSymlink) fs.CreateSymlink = origSymlink;
      if (origChangeSize) fs.ChangeSize = origChangeSize;
      if (origUnlink) fs.Unlink = origUnlink;
      if (origLink) fs.Link = origLink;
      if (dev9p && origBuildReply) dev9p.BuildReply = origBuildReply;
    };
  }

  /* ---------- Legacy save_state() 9p strip wrapper ---------- */

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

  const api = {
    install,
    assertV86StateShape,
    withEmptyShare,
    ROOT_DIR_NAME,
    HOST_DIR_NAME,
    findRootDirId,
    findHostDirId,
    exportRootTree,
    encodeRootArchive,
    decodeRootArchive,
    importRootTree,
    watchRootMutations,
  };
  if (typeof window !== "undefined") window.Go9p = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
