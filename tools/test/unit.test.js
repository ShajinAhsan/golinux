#!/usr/bin/env node
/**
 * Layer 1 pure-logic unit tests (Node, <2s, no browser):
 *   - persist.js: buildId/schema compatibility (online & offline), dirtySeq
 *     mid-save preservation, Reset unload disarm, worker crash recovery
 *   - persist-9p.js: double save_state() after failed shape validation (BUG-17)
 *   - js/keybar.js: applyModifiers() for Ctrl/Alt + native keyboard chars
 *   - js/terminal.js: computeGrid()
 *   - js/transfer.js: sanitizeFilename()
 *   - js/tool-progress.js: matchTool() most-specific hypothesis
 *
 * Exits non-zero on failure.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..", "..");

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log("ok: " + msg); }
  else { failed++; console.error("FAIL: " + msg); }
}

function loadPersist({ buildId = "aaaaaaaaaaaaaaaa", stateSchema = 2, storage, workerFactory }) {
  const src = fs.readFileSync(path.join(ROOT, "persist.js"), "utf8");
  const win = {};
  const doc = {
    visibilityState: "visible",
    addEventListener() {},
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
  };
  const WorkerStub = workerFactory || class {
    constructor() { this.onmessage = null; this.onerror = null; }
    postMessage({ id, buf }) {
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: { id, out: buf } });
      }, 20);
    }
    terminate() {}
  };
  const runner = new Function(
    "window", "document", "navigator", "Worker", "URL", "Blob",
    "GL_BUILD_ID", "GL_STATE_SCHEMA", "fetch", "console",
    src + "\nreturn window.GoPersist;"
  );
  return runner(
    win, doc, nav, WorkerStub,
    { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    Blob,
    buildId, stateSchema,
    async () => new Response("{}", { status: 200 }),
    { log() {}, warn() {}, error() {} }
  );
}

function makeFakeOpfs() {
  const files = new Map();
  const dirHandle = {
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (opts && opts.create) files.set(name, new Uint8Array(0));
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
        async move(target) {
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

async function testPersistCompatibility() {
  const gp = loadPersist({ buildId: "1111222233334444", stateSchema: 2 });
  check(gp.isCompatibleMeta({ buildId: "1111222233334444", schema: 2 }, "1111222233334444", 2).ok === true,
    "persist: exact buildId + schema match is compatible");
  check(gp.isCompatibleMeta({ buildId: "0000000000000001", schema: 2 }, "1111222233334444", 2).ok === false,
    "persist: mismatched buildId is rejected");
  check(gp.isCompatibleMeta({ buildId: "1111222233334444", schema: 1 }, "1111222233334444", 2).ok === false,
    "persist: legacy schema without virtio-console is rejected");
  check(gp.isCompatibleMeta({ buildId: "1111222233334444", schema: 2 }, null, 2).ok === false,
    "persist: offline null expectedBuildId is rejected (BUG-05)");
  check(gp.isCompatibleMeta({ buildId: null, schema: 2 }, "1111222233334444", 2).ok === false,
    "persist: null meta.buildId is rejected (BUG-05)");
  check(gp.isCompatibleMeta(null, "1111222233334444", 2).ok === false,
    "persist: missing meta is rejected");
}

async function testPersistDirtySeqAndReset() {
  const opfs = makeFakeOpfs();
  const gp = loadPersist({ buildId: "abcdef0123456789", stateSchema: 2, storage: opfs.storage });
  await gp.claimOwnership();

  const emu = {
    async save_state() {
      // Simulate user typing WHILE save_state/gzip is in progress (BUG-14).
      setTimeout(() => gp.markDirty(), 5);
      return new ArrayBuffer(64);
    },
  };
  const ok = await gp.saveNow(emu, "manual");
  check(ok === true, "persist: manual save succeeds");
  check(gp.isDirty() === true, "persist: edits during async save keep isDirty()=true (BUG-14)");

  // Reset latch must disarm any subsequent saveNow (e.g., pagehide during reload, BUG-15).
  await gp.clearUserState();
  check(opfs.files.size === 0, "persist: clearUserState removes OPFS entries");
  const afterReset = await gp.saveNow(emu, "unload");
  check(afterReset === false && opfs.files.size === 0,
    "persist: unload save after clearUserState is a no-op (BUG-15)");
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
          this.onmessage({ data: { id, out: buf } });
        }
      }, 10);
    }
    terminate() {}
  }
  const gp = loadPersist({
    buildId: "abcdef0123456789", stateSchema: 2,
    storage: opfs.storage, workerFactory: FlakyWorker,
  });
  await gp.claimOwnership();
  const emu = { async save_state() { return new ArrayBuffer(32); } };
  const first = await gp.saveNow(emu, "manual");
  check(first === false, "persist: worker crash fails the first save cleanly");
  const second = await gp.saveNow(emu, "manual");
  check(second === true, "persist: saveInFlight recovered after worker crash (BUG-16)");
}

async function testPersist9pBrokenShapeDoubleSave() {
  const { loadPersist9p } = require("./load-persist-9p.js");
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

  const tp = await import(pathToFileURL(path.join(ROOT, "js/tool-progress.js")).href);
  const sets = {
    gcc: { list: ["a", "b", "c"], names: new Set(["a", "b", "c"]) },
    "g++": { list: ["a", "b", "c", "d", "e", "f"], names: new Set(["a", "b", "c", "d", "e", "f"]) },
  };
  check(tp.matchTool(["a", "b"], sets) === "gcc", "tool-progress: prefers smaller gcc set over g++");
  check(tp.matchTool(["d", "e", "f"], sets) === "g++", "tool-progress: selects g++ on g++-specific chunks");
}

(async () => {
  const tests = [
    testPersistCompatibility,
    testPersistDirtySeqAndReset,
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
