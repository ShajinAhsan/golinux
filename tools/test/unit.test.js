#!/usr/bin/env node
/**
 * Layer 1 pure-logic unit tests (Node, <2s, no browser):
 *   - persist-9p.js: GLFS v1 archive encode/decode/import/export, corrupt archive
 *     rejection, double save_state() after failed shape validation (BUG-17)
 *   - persist.js: legacy compatibility predicate, fast debounced autosave,
 *     dirtySeq mid-save preservation, Safari strict 2-arg move, Reset unload
 *     disarm, worker crash recovery, synchronous pagehide SW handoff,
 *     pending-cache Safari/Firefox restore fallback, targeted beforeunload guard
 *   - js/keybar.js: applyModifiers() for Ctrl/Alt + native keyboard chars
 *   - js/terminal.js: computeGrid()
 *   - js/transfer.js: sanitizeFilename() + listHostFiles() (both legacy & /host)
 *   - js/tool-progress.js: matchTool() most-specific hypothesis
 *
 * Exits non-zero on failure.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..", "..");
const { loadPersist9p } = require("./load-persist-9p.js");

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log("ok: " + msg); }
  else { failed++; console.error("FAIL: " + msg); }
}

function makeMockFs9p(initialRootFiles = {}) {
  const S_IFDIR = 0x4000;
  const S_IFREG = 0x8000;
  const S_IFLNK = 0xa000;
  const inodes = [];
  const inodedata = {};

  function mkDir(parentId, name, mode = S_IFDIR | 0o755) {
    const id = inodes.length;
    const map = new Map([[".", id], ["..", parentId >= 0 ? parentId : id]]);
    inodes.push({ mode, direntries: map, size: 0, mtime: 1700000000, nlinks: 2, status: 0 });
    if (parentId >= 0) inodes[parentId].direntries.set(name, id);
    return id;
  }

  const fs9p = {
    inodes,
    inodedata,
    NotifyListeners() {},
    Search(dirId, name) {
      const ino = inodes[dirId];
      if (!ino || !(ino.direntries instanceof Map)) return -1;
      return ino.direntries.has(name) ? ino.direntries.get(name) : -1;
    },
    CreateDirectory(name, parentId) {
      const id = mkDir(parentId, name);
      this.NotifyListeners(id, "newdir");
      return id;
    },
    CreateFile(name, parentId) {
      const id = inodes.length;
      inodes.push({ mode: S_IFREG | 0o644, size: 0, mtime: 1700000000, nlinks: 1, status: 0 });
      inodes[parentId].direntries.set(name, id);
      inodedata[id] = new Uint8Array(0);
      this.NotifyListeners(id, "newfile");
      return id;
    },
    CreateSymlink(name, parentId, target) {
      const id = inodes.length;
      inodes.push({ mode: S_IFLNK | 0o777, size: target.length, symlink: target, mtime: 1700000000, nlinks: 1, status: 0 });
      inodes[parentId].direntries.set(name, id);
      return id;
    },
    Unlink(parentId, name) {
      const dir = inodes[parentId];
      if (!dir || !dir.direntries.has(name)) return -1;
      const cid = dir.direntries.get(name);
      dir.direntries.delete(name);
      if (inodes[cid]) inodes[cid].nlinks--;
      this.NotifyListeners(cid, "delete");
      return 0;
    },
  };

  mkDir(-1, ""); // inode 0: /run/host9p
  const rootId = mkDir(0, "root", S_IFDIR | 0o700);
  const hostId = mkDir(0, "host", S_IFDIR | 0o755);

  for (const [name, content] of Object.entries(initialRootFiles)) {
    const id = fs9p.CreateFile(name, rootId);
    const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(String(content));
    inodes[id].size = bytes.byteLength;
    inodedata[id] = bytes;
  }

  return { fs9p, rootId, hostId };
}

function makeFakeOpfs(opts = {}) {
  const files = new Map();
  const dirHandle = {
    async getFileHandle(name, fhOpts) {
      if (!files.has(name)) {
        if (fhOpts && fhOpts.create) files.set(name, new Uint8Array(0));
        else throw Object.assign(new Error("not found: " + name), { name: "NotFoundError" });
      }
      return {
        async getFile() {
          const bytes = files.get(name);
          return {
            async text() { return new TextDecoder().decode(bytes); },
            async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
          };
        },
        async createWritable() {
          let buf = new Uint8Array(0);
          return {
            async write(blob) { buf = new Uint8Array(await blob.arrayBuffer()); },
            async close() { files.set(name, buf); },
            async abort() {},
          };
        },
        async move(dirOrName, maybeName) {
          if (opts.safariStrictTwoArgMove) {
            if (arguments.length < 2 || dirOrName !== dirHandle || typeof maybeName !== "string") {
              throw new TypeError("Not enough arguments");
            }
            files.set(maybeName, files.get(name));
            files.delete(name);
            return;
          }
          const target = typeof dirOrName === "string" ? dirOrName : maybeName;
          files.set(target, files.get(name));
          files.delete(name);
        },
      };
    },
    async removeEntry(name) { files.delete(name); },
  };
  return {
    files,
    storage: {
      async getDirectory() {
        return {
          async getDirectoryHandle() { return dirHandle; },
          async removeEntry() { files.clear(); },
        };
      },
    },
  };
}

function makeFakeCaches() {
  const store = new Map();
  return {
    store,
    api: {
      async open(name) {
        if (!store.has(name)) store.set(name, new Map());
        const m = store.get(name);
        return {
          async put(key, resp) { m.set(typeof key === "string" ? key : key.url, resp); },
          async match(key) { return m.get(typeof key === "string" ? key : key.url) || undefined; },
          async delete(key) { return m.delete(typeof key === "string" ? key : key.url); },
        };
      },
      async delete(name) { return store.delete(name); },
    },
  };
}

function loadPersist({
  buildId = "aaaaaaaaaaaaaaaa",
  stateSchema = 4,
  storage,
  workerFactory,
  swController = null,
  cachesApi,
} = {}) {
  const go9p = loadPersist9p({});
  const src = fs.readFileSync(path.join(ROOT, "persist.js"), "utf8");
  const winListeners = {};
  const docListeners = {};
  const win = {
    Go9p: go9p,
    addEventListener(ev, fn) { (winListeners[ev] ||= []).push(fn); },
    dispatch(ev, arg) { for (const fn of (winListeners[ev] || [])) fn(arg); },
  };
  const doc = {
    visibilityState: "visible",
    addEventListener(ev, fn) { (docListeners[ev] ||= []).push(fn); },
    dispatch(ev, arg) { for (const fn of (docListeners[ev] || [])) fn(arg); },
  };
  const nav = {
    storage: storage || {
      async getDirectory() { throw Object.assign(new Error("no opfs"), { name: "SecurityError" }); },
    },
    locks: {
      request(name, optsOrFn, maybeFn) {
        const fn = typeof optsOrFn === "function" ? optsOrFn : maybeFn;
        return Promise.resolve(fn({ name }));
      },
    },
    serviceWorker: swController ? { controller: swController } : undefined,
  };
  const WorkerStub = workerFactory || class {
    constructor() { this.onmessage = null; this.onerror = null; }
    postMessage({ id, buf }) {
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: { id, out: buf.slice(0, Math.max(1, buf.byteLength - 1)) } });
      }, 15);
    }
    terminate() {}
  };
  const runner = new Function(
    "window", "document", "navigator", "Worker", "URL", "Blob",
    "GL_BUILD_ID", "GL_STATE_SCHEMA", "GL_PENDING_STATE_CACHE",
    "caches", "fetch", "console",
    src + "\nreturn window.GoPersist;"
  );
  const gp = runner(
    win, doc, nav, WorkerStub,
    { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    Blob,
    buildId, stateSchema, "golinux-pending-state",
    cachesApi,
    async () => new Response("{}", { status: 200 }),
    { log() {}, warn() {}, error() {} }
  );
  return { gp, go9p, win, doc };
}

async function testRootArchiveCodecAndImport() {
  const go9p = loadPersist9p({});
  const { fs9p, rootId, hostId } = makeMockFs9p({
    "pattern.c": "#include <stdio.h>\nint main(){return 0;}\n",
  });
  const binId = fs9p.CreateFile("pattern", rootId);
  fs9p.inodes[binId].mode = 0x8000 | 0o755;
  fs9p.inodes[binId].size = 4;
  fs9p.inodedata[binId] = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
  const subId = fs9p.CreateDirectory("sub", rootId);
  fs9p.CreateSymlink("link.c", subId, "../pattern.c");
  // Put a temporary upload in /host: must NEVER be exported with /root!
  const hostFile = fs9p.CreateFile("temp-upload.bin", hostId);
  fs9p.inodes[hostFile].size = 3;
  fs9p.inodedata[hostFile] = new Uint8Array([9, 8, 7]);

  const tree = go9p.exportRootTree(fs9p);
  check(tree && tree.fileCount === 3, "go9p: exportRootTree captures /root files+symlinks and excludes /host");
  check(!tree.entries.some((e) => e.p.includes("temp-upload")), "go9p: /mnt/host upload excluded from /root export");

  const encoded = go9p.encodeRootArchive(tree, 1234567890);
  const decoded = go9p.decodeRootArchive(encoded);
  check(decoded.savedAt === 1234567890 && decoded.fileCount === 3, "go9p: GLFS v1 archive round-trips cleanly");

  const binEntry = decoded.entries.find((e) => e.p === "pattern");
  check(binEntry && (binEntry.m & 0o777) === 0o755 && binEntry.b[0] === 0x7f && binEntry.b[1] === 0x45,
    "go9p: GLFS preserves +x mode and raw binary ELF bytes");

  // Restore into a fresh mock fs9p while keeping inode 0, rootId, hostId intact
  const fresh = makeMockFs9p({ ".bashrc": "default" });
  const restored = go9p.importRootTree(fresh.fs9p, decoded.entries);
  check(restored === 3 && fresh.fs9p.Search(0, "root") === fresh.rootId && fresh.fs9p.Search(0, "host") === fresh.hostId,
    "go9p: importRootTree restores /root without altering inode 0/rootId/hostId");
  const restoredBinId = fresh.fs9p.Search(fresh.rootId, "pattern");
  check(restoredBinId > 0 && (fresh.fs9p.inodes[restoredBinId].mode & 0o777) === 0o755,
    "go9p: restored executable keeps 0755 permissions");

  // Reject corrupt / truncated / unsafe archives
  let threwMagic = false;
  try { go9p.decodeRootArchive(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])); } catch (_) { threwMagic = true; }
  check(threwMagic, "go9p: decodeRootArchive rejects invalid magic");

  let threwTrunc = false;
  try { go9p.decodeRootArchive(encoded.slice(0, encoded.byteLength - 2)); } catch (_) { threwTrunc = true; }
  check(threwTrunc, "go9p: decodeRootArchive rejects truncated payload");
}

async function testPersistCompatibility() {
  const { gp } = loadPersist({ buildId: "1111222233334444", stateSchema: 4 });
  check(gp.isCompatibleMeta({ buildId: "1111222233334444", schema: 4 }, "1111222233334444", 4).ok === true,
    "persist: exact buildId + schema match is compatible");
  check(gp.isCompatibleMeta({ buildId: "0000000000000001", schema: 4 }, "1111222233334444", 4).ok === false,
    "persist: mismatched buildId is rejected");
  check(gp.isCompatibleMeta({ buildId: "1111222233334444", schema: 1 }, "1111222233334444", 4).ok === false,
    "persist: legacy schema without virtio-console is rejected");
  check(gp.isCompatibleMeta({ buildId: "1111222233334444", schema: 4 }, null, 4).ok === false,
    "persist: offline null expectedBuildId is rejected (BUG-05)");
  check(gp.isValidRootMeta({ format: "glfs", version: 1, encoding: "raw" }).ok === true,
    "persist: valid glfs root meta accepted");
  check(gp.isValidRootMeta({ format: "legacy", version: 1, encoding: "raw" }).ok === false,
    "persist: invalid root meta format rejected");
}

async function testPersistDirtySeqAndReset() {
  const opfs = makeFakeOpfs();
  const { gp } = loadPersist({ storage: opfs.storage });
  await gp.claimOwnership();

  const { fs9p } = makeMockFs9p({ "pattern.c": "int main(){return 0;}" });
  const emu = { fs9p };
  gp.attach(emu);

  // Trigger a mid-save mutation (BUG-14): create a >256 KB file so async gzip worker runs
  const bigId = fs9p.CreateFile("big.bin", fs9p.Search(0, "root"));
  fs9p.inodes[bigId].size = 300 * 1024;
  fs9p.inodedata[bigId] = new Uint8Array(300 * 1024);
  setTimeout(() => gp.markDirty(), 5);
  const ok = await gp.saveNow(emu, "manual");
  check(ok === true, "persist: manual save succeeds");
  check(gp.isDirty() === true, "persist: edits during async save keep isDirty()=true (BUG-14)");

  // Safari/WebKit strictly requires 2-arg move(dirHandle, fileName).
  const safariOpfs = makeFakeOpfs({ safariStrictTwoArgMove: true });
  const { gp: gpSafari } = loadPersist({ storage: safariOpfs.storage });
  await gpSafari.claimOwnership();
  const safariOk = await gpSafari.saveNow({ fs9p: makeMockFs9p({ "a.c": "int x;" }).fs9p }, "manual");
  check(safariOk === true && safariOpfs.files.has("root-fs.bin") && safariOpfs.files.has("root-meta.json"),
    "persist: Safari strict 2-arg OPFS move(dir, fileName) saves cleanly");

  // Reset latch must disarm any subsequent saveNow (e.g., pagehide during reload, BUG-15).
  await gp.clearUserState();
  check(opfs.files.size === 0, "persist: clearUserState removes OPFS entries");
  const afterReset = await gp.saveNow(emu, "unload");
  check(afterReset === false && opfs.files.size === 0,
    "persist: unload save after clearUserState is a no-op (BUG-15)");
}

async function testPersistDebounceSwHandoffAndCacheFallback() {
  const opfs = makeFakeOpfs();
  const fakeCaches = makeFakeCaches();
  const swMessages = [];
  const swCtrl = {
    postMessage(msg, transfer) {
      swMessages.push({ msg, transfer });
      if (msg && msg.type === "persist-flush" && transfer && transfer[0]) {
        transfer[0].postMessage({ ok: true });
      }
    },
  };

  const { gp, go9p, win } = loadPersist({
    storage: opfs.storage,
    swController: swCtrl,
    cachesApi: fakeCaches.api,
  });
  await gp.claimOwnership();

  const { fs9p, rootId, hostId } = makeMockFs9p({ "hello.c": "int main(){}" });
  gp.attach({ fs9p });
  check(gp.isDirty() === false, "persist: fresh attached session starts clean");

  // Writing to /host (/mnt/host) must NOT mark /root dirty
  fs9p.CreateFile("upload.txt", hostId);
  check(gp.isDirty() === false, "persist: /mnt/host transfer does not falsely mark /root dirty");

  // Writing to /root MUST mark dirty and trigger fast debounced autosave (~350ms, not 30s!)
  const pId = fs9p.CreateFile("pattern.c", rootId);
  fs9p.inodes[pId].size = 5;
  fs9p.inodedata[pId] = new TextEncoder().encode("hello");
  check(gp.isDirty() === true, "persist: fs9p mutation under /root marks session dirty immediately");

  // Wait 500ms -> fast debounced autosave must complete automatically!
  await new Promise((r) => setTimeout(r, 550));
  check(opfs.files.has("root-fs.bin") && gp.isDirty() === false,
    "persist: fast debounced autosave persists /root automatically in <600ms");

  // Now mutate again and fire immediate pagehide -> must synchronously hand off to SW!
  const p2 = fs9p.CreateFile("instant.c", rootId);
  fs9p.inodes[p2].size = 4;
  fs9p.inodedata[p2] = new TextEncoder().encode("fast");
  check(gp.isDirty() === true, "persist: second mutation marks dirty");

  // beforeunload must NOT prompt when SW handoff is available
  let prevented = false;
  win.dispatch("beforeunload", { preventDefault() { prevented = true; } });
  check(prevented === false, "persist: beforeunload stays seamless when SW handoff is available");

  win.dispatch("pagehide", {});
  const handoff = swMessages.find((m) => m.msg && m.msg.type === "persist-save");
  check(!!handoff && handoff.msg.archive instanceof ArrayBuffer && handoff.msg.meta.fileCount >= 3,
    "persist: pagehide synchronously transfers /root GLFS archive to Service Worker");

  // Test Safari/Firefox SW cache fallback restoration when pending cache is newer than OPFS
  const pendingCache = await fakeCaches.api.open("golinux-pending-state");
  await pendingCache.put("/__golinux_pending_root__", new Response(handoff.msg.archive.slice(0), {
    status: 200,
    headers: {
      "X-GL-Format": "glfs",
      "X-GL-Version": "1",
      "X-GL-Encoding": "raw",
      "X-GL-Saved-At": String(Date.now() + 5000),
      "X-GL-File-Count": String(handoff.msg.meta.fileCount),
    },
  }));
  const loaded = await gp.loadUserState();
  check(loaded && loaded.entries.some((e) => e.p === "instant.c"),
    "persist: loadUserState restores newer /root archive from SW pending cache fallback");
  check(swMessages.some((m) => m.msg && m.msg.type === "persist-flush"),
    "persist: loadUserState awaits SW persist-flush before reading storage");

  // Without SW controller, beforeunload MUST protect dirty unsaved changes
  const { gp: gpNoSw, win: winNoSw } = loadPersist({ storage: opfs.storage, swController: null });
  await gpNoSw.claimOwnership();
  const mockNoSw = makeMockFs9p({});
  gpNoSw.attach({ fs9p: mockNoSw.fs9p });
  mockNoSw.fs9p.CreateFile("unsaved.c", mockNoSw.rootId);
  let warnedNoSw = false;
  winNoSw.dispatch("beforeunload", { preventDefault() { warnedNoSw = true; } });
  check(warnedNoSw === true, "persist: beforeunload warns when dirty and SW handoff is unavailable");
}

async function testPersistWorkerCrashRecovery() {
  const opfs = makeFakeOpfs();
  let calls = 0;
  class FlakyWorker {
    constructor() { this.onmessage = null; this.onerror = null; }
    postMessage({ id, buf }) {
      calls++;
      setTimeout(() => {
        if (calls === 1) {
          if (this.onerror) this.onerror({ message: "simulated OOM" });
        } else if (this.onmessage) {
          this.onmessage({ data: { id, out: buf.slice(0, buf.byteLength - 1) } });
        }
      }, 10);
    }
    terminate() {}
  }
  const { gp } = loadPersist({ storage: opfs.storage, workerFactory: FlakyWorker });
  await gp.claimOwnership();
  // Create a >256 KB file so gzip worker path is exercised
  const { fs9p, rootId } = makeMockFs9p({});
  const big = fs9p.CreateFile("large.bin", rootId);
  fs9p.inodes[big].size = 300 * 1024;
  fs9p.inodedata[big] = new Uint8Array(300 * 1024);
  const emu = { fs9p };

  const first = await gp.saveNow(emu, "manual");
  check(first === false, "persist: worker crash fails the first save cleanly");
  const second = await gp.saveNow(emu, "manual");
  check(second === true, "persist: saveInFlight recovered after worker crash (BUG-16)");
}

async function testPersist9pBrokenShapeDoubleSave() {
  const go9p = loadPersist9p({});
  let origCalls = 0;
  const fakeEmu = {
    fs9p: { inodedata: {}, inodes: [{ mode: 0x4000, direntries: null }], get_state: () => [] },
    async save_state() { origCalls++; return new ArrayBuffer(16); },
  };
  go9p.install(fakeEmu);
  await fakeEmu.save_state();
  await fakeEmu.save_state();
  check(origCalls === 2, "persist-9p: second save after broken shape still falls back without crashing (BUG-17)");
}

async function testPureESModules() {
  const keybar = await import(pathToFileURL(path.join(ROOT, "js/keybar.js")).href);
  check(keybar.applyModifiers("o", { ctrl: true }) === "\x0f", "keybar: Ctrl+o -> 0x0f (nano save)");
  check(keybar.applyModifiers("x", { ctrl: true }) === "\x18", "keybar: Ctrl+x -> 0x18 (nano exit)");
  check(keybar.applyModifiers("c", { ctrl: true }) === "\x03", "keybar: Ctrl+c -> 0x03");
  check(keybar.applyModifiers("d", { ctrl: true }) === "\x04", "keybar: Ctrl+d -> 0x04");
  check(keybar.applyModifiers("b", { alt: true }) === "\x1bb", "keybar: Alt+b -> ESC b");
  check(keybar.applyModifiers("abc", { ctrl: true }) === "abc", "keybar: multi-char paste untouched");

  const term = await import(pathToFileURL(path.join(ROOT, "js/terminal.js")).href);
  const g1 = term.computeGrid(380, 500, 7.2, 15);
  check(g1 && g1.cols === 52 && g1.rows === 33, "terminal: computeGrid computes exact mobile grid");
  const g2 = term.computeGrid(50, 20, 7.2, 15);
  check(g2 && g2.cols === term.MIN_COLS && g2.rows === term.MIN_ROWS, "terminal: computeGrid clamps to min");
  check(term.computeGrid(0, 100, 7, 15) === null, "terminal: zero width returns null");

  const transfer = await import(pathToFileURL(path.join(ROOT, "js/transfer.js")).href);
  check(transfer.sanitizeFilename("../../etc/passwd") === "passwd", "transfer: strips path traversal");
  check(transfer.sanitizeFilename("a\nb\x00.txt") === "a_b_.txt", "transfer: strips control characters");
  check(transfer.sanitizeFilename("..") === "upload", "transfer: rejects bare '..'");
  const fakeFs = {
    inodes: [
      { mode: 0x4000, direntries: new Map([[".", 0], ["..", 0], ["z.txt", 1], ["sub", 2]]) },
      { mode: 0x8000, size: 12 },
      { mode: 0x4000, direntries: new Map([[".", 2], ["..", 0], ["a.bin", 3]]) },
      { mode: 0x8000, size: 4096 },
    ],
  };
  const listed = transfer.listHostFiles(fakeFs);
  check(listed.length === 2 && listed[0].path === "sub/a.bin" && listed[0].size === 4096 && listed[1].path === "z.txt" && listed[1].size === 12,
    "transfer: listHostFiles walks /mnt/host recursively, skips ./.., returns sorted files with sizes");

  const fakeBoundFs = makeMockFs9p({ "secret.c": "in root" });
  const hFile = fakeBoundFs.fs9p.CreateFile("out.txt", fakeBoundFs.hostId);
  fakeBoundFs.fs9p.inodes[hFile].size = 7;
  const listedBound = transfer.listHostFiles(fakeBoundFs.fs9p);
  check(listedBound.length === 1 && listedBound[0].path === "out.txt",
    "transfer: listHostFiles scopes to /host subtree and never exposes /root files");

  const tp = await import(pathToFileURL(path.join(ROOT, "js/tool-progress.js")).href);
  const sets = {
    gcc: { list: ["a", "b", "c"], names: new Set(["a", "b", "c"]) },
    "g++": { list: ["a", "b", "c", "d", "e", "f"], names: new Set(["a", "b", "c", "d", "e", "f"]) },
  };
  check(tp.matchTool(["a", "b"], sets) === "gcc", "tool-progress: prefers smaller gcc set over g++");
  check(tp.matchTool(["d", "e", "f"], sets) === "g++", "tool-progress: selects g++ on g++-specific chunks");
  check(tp.matchTool(["d"], sets) === "g++", "tool-progress: single unique-owner chunk matches immediately on slow links");
  check(tp.matchTool(["a"], sets) === null, "tool-progress: single shared chunk does not false-match");

  const st = await import(pathToFileURL(path.join(ROOT, "js/status.js")).href);
  check(st.fmtSpeed(64 * 1024) === "64 KB/s", "status: fmtSpeed formats KB/s cleanly");
  check(st.fmtSpeed(2.5 * 1048576) === "2.5 MB/s", "status: fmtSpeed formats MB/s cleanly");
  check(st.fmtEta(42) === "~42s left", "status: fmtEta formats seconds cleanly");
  check(st.fmtEta(95) === "~1m 35s left", "status: fmtEta formats minutes+seconds cleanly");
}

(async () => {
  const tests = [
    testRootArchiveCodecAndImport,
    testPersistCompatibility,
    testPersistDirtySeqAndReset,
    testPersistDebounceSwHandoffAndCacheFallback,
    testPersistWorkerCrashRecovery,
    testPersist9pBrokenShapeDoubleSave,
    testPureESModules,
  ];
  for (const t of tests) {
    try { await t(); }
    catch (e) { failed++; console.error("FAIL: " + t.name + " threw: " + e.stack); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log("All Layer-1 unit tests passed.");
})();
