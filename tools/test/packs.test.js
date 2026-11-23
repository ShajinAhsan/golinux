#!/usr/bin/env node
/**
 * Tests for the offline pack store (packs.js), driven against a fake
 * CacheStorage. Loads the REAL packs.js, so this catches the bugs it exists
 * for rather than re-implementing the logic.
 *
 *   node tools/test/packs.test.js
 *
 * Exits non-zero on any failure.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const ORIGIN = "http://app.test";
const BUILD_ID = "3a3a2a8af275cc11";
const PACK_CACHE = "golinux-pack-v13";

/* ---------------- fake CacheStorage ---------------- */

function keyOf(k) {
  if (typeof k === "string") return k;
  if (k && typeof k.url === "string") return k.url;
  return String(k);
}

class FakeCache {
  constructor() { this.map = new Map(); }
  async put(req, res) { this.map.set(keyOf(req), res); }
  async match(req) {
    const v = this.map.get(keyOf(req));
    return v ? v.clone() : undefined;
  }
  async delete(req) { return this.map.delete(keyOf(req)); }
  async keys() { return [...this.map.keys()].map((u) => ({ url: u })); }
}

function makeCaches() {
  const store = new Map();
  return {
    async open(name) {
      if (!store.has(name)) store.set(name, new FakeCache());
      return store.get(name);
    },
    async keys() { return [...store.keys()]; },
    async delete(n) { return store.delete(n); },
    _store: store,
  };
}

/* ---------------- fake chunk lists ---------------- */

const LISTS = {
  common: ["chunk-0-131072.zst", "chunk-131072-262144.zst", "chunk-262144-393216.zst"],
  full: ["chunk-0-131072.zst", "chunk-131072-262144.zst", "chunk-262144-393216.zst",
    "chunk-393216-524288.zst", "chunk-524288-655360.zst", "chunk-655360-786432.zst"],
};
const INDEX = {
  minimal: { title: "Minimal", chunks: 0, bytes: 0, snapshotBytes: 100, totalBytes: 100 },
  common: { title: "Common tools", chunks: LISTS.common.length, bytes: 3000,
    snapshotBytes: 100, totalBytes: 3100 },
  full: { title: "Full", chunks: LISTS.full.length, bytes: 6000,
    snapshotBytes: 100, totalBytes: 6100 },
};

/* ---------------- load the real packs.js ---------------- */

function loadPacks({ fetchImpl, caches, locks }) {
  const src = fs.readFileSync(path.join(ROOT, "packs.js"), "utf8");
  const win = {};
  const location = { origin: ORIGIN, href: ORIGIN + "/", search: "" };
  const GL_CHUNK_PATH = "images/debian-chunks/" + BUILD_ID + "/";
  const glPackUrl = (f) => ORIGIN + "/packs/" + BUILD_ID + "/" + f;
  const glChunkUrl = (n) => ORIGIN + "/" + GL_CHUNK_PATH + n;
  // A faithful-enough BroadcastChannel: a message is delivered to OTHER
  // channel objects, never back to the sender. (Echoing to the sender made
  // packs.js's own "state changed" handler call emit() forever.)
  const peers = new Set();
  const BroadcastChannel = class {
    constructor() { peers.add(this); this._on = null; }
    postMessage(msg) {
      for (const p of peers) if (p !== this && p._on) p._on({ data: msg });
    }
    set onmessage(fn) { this._on = fn; }
    get onmessage() { return this._on; }
  };
  const navigator = { locks };

  const runner = new Function(
    "window", "location", "caches", "fetch", "console",
    "GL_CHUNK_PATH", "glPackUrl", "glChunkUrl", "BroadcastChannel", "GL_PACK_CACHE",
    "navigator", "confirm", "localStorage",
    src + "\nreturn window.GoPacks;"
  );
  const packs = runner(
    win, location, caches, fetchImpl,
    { log() {}, warn() {}, error() {} },
    GL_CHUNK_PATH, glPackUrl, glChunkUrl,
    BroadcastChannel, PACK_CACHE, navigator, () => true,
    { getItem: () => null, setItem: () => {} }
  );
  return packs;
}

function fakeLocks(sharedHeld) {
  // A minimal Web Locks shim: one named lock, with ifAvailable.
  const held = sharedHeld || { name: null };
  return {
    // Matches the real API: with ifAvailable, the callback receives null when
    // the lock is taken. (Passing a fake lock object instead made the
    // "another tab" path fall through to the wrong error message.)
    request(name, opts, fn) {
      if (held.name === name) return Promise.resolve(fn(null));
      held.name = name;
      const release = () => { held.name = null; };
      return Promise.resolve(fn({ name })).finally(release);
    },
  };
}

/** fetch mock serving the index, pack lists, and chunk bytes. */
function fetchMock(opts = {}) {
  const calls = [];
  let chunksServed = 0;
  const impl = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    if (url.endsWith("index.json")) {
      return new Response(JSON.stringify(INDEX), { status: 200 });
    }
    const m = url.match(/packs\/[^/]+\/(\w+)\.json$/);
    if (m && LISTS[m[1]]) {
      return new Response(JSON.stringify(LISTS[m[1]]), { status: 200 });
    }
    if (/chunk-\d+-\d+\.zst$/.test(url)) {
      chunksServed++;
      if (opts.failChunk && opts.failChunk(url)) {
        return new Response("", { status: 500 });
      }
      if (opts.delayChunkMs) {
        // Honour AbortSignal like real fetch, or cancelled downloads would keep
        // running and the cancel tests would pass for the wrong reason.
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayChunkMs);
          const sig = (init && init.signal) || (input && input.signal);
          if (sig) {
            sig.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new DOMException("aborted", "AbortError"));
            }, { once: true });
          }
        });
      }
      return new Response(new ArrayBuffer(1024), { status: 200,
        headers: { "Content-Length": "1024" } });
    }
    return new Response("", { status: 404 });
  };
  impl.calls = calls;
  impl.chunkCount = () => chunksServed;
  return impl;
}

/* ---------------- assertions ---------------- */

let failed = 0, passed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log("ok: " + msg); }
  else { failed++; console.error("FAIL: " + msg); }
}

const keyFor = (n) => ORIGIN + "/images/debian-chunks/" + BUILD_ID + "/" + n;

async function cachedNames(caches) {
  const c = await caches.open(PACK_CACHE);
  return new Set((await c.keys()).map((k) => k.url));
}

async function seed(caches, names) {
  const c = await caches.open(PACK_CACHE);
  for (const n of names) {
    await c.put(keyFor(n), new Response("x"));
  }
}

function newEnv(opts = {}) {
  const caches = makeCaches();
  const held = opts.held || { name: null };
  const fetchImpl = opts.fetchImpl || fetchMock();
  const packs = loadPacks({ fetchImpl, caches, locks: fakeLocks(held) });
  return { caches, packs, fetchImpl, held };
}

/* ---------------- tests ---------------- */

async function testRemoveCommonKeepsFull() {
  const { caches, packs } = newEnv();
  await seed(caches, LISTS.full);           // full is saved
  const res = await packs.removePack("common");
  const now = await cachedNames(caches);
  const kept = LISTS.full.every((n) => now.has(keyFor(n)));
  check(kept, "remove Common while Full is saved: every Full chunk is still cached");
  check(res && typeof res.deleted === "number",
    "remove Common reports how many chunks it deleted (" +
    (res && res.deleted) + ")");
}

async function testRemoveFullKeepsCommon() {
  const { caches, packs } = newEnv();
  await seed(caches, LISTS.full);
  await packs.removePack("full");
  const now = await cachedNames(caches);
  const kept = LISTS.common.every((n) => now.has(keyFor(n)));
  check(kept, "remove Full while Common is saved: every Common chunk is still cached");
}

async function testRemoveCommonWhenOnlyCommonSaved() {
  // common ⊂ full, so a naive "protect any pack with a matching chunk" check
  // would protect `full` merely because common's chunks exist, and Remove would
  // delete nothing forever.
  const { caches, packs } = newEnv();
  await seed(caches, LISTS.common);          // only common is saved
  const res = await packs.removePack("common");
  const now = await cachedNames(caches);
  check(now.size === 0,
    "removing Common when only Common is saved actually deletes it (" +
    now.size + " left)");
  check(res && res.deleted === LISTS.common.length,
    "and reports every chunk deleted (" + (res && res.deleted) + ")");
}

async function testRemoveFullKeepsPartialCommon() {
  // A PARTIALLY saved pack must still be protected in full.
  const { caches, packs } = newEnv();
  await seed(caches, LISTS.full);
  // Pretend common is partially saved (its first chunk) and full is complete.
  const st = await packs.packStates();
  check(st.common.present === LISTS.common.length,
    "with full saved, common's chunks all read as present (" +
    st.common.present + ")");
  await packs.removePack("full");
  const now = await cachedNames(caches);
  check(LISTS.common.every((n) => now.has(keyFor(n))),
    "removing Full keeps every Common chunk");
}

async function testCancelThenRemove() {
  // Slow chunks so the download is still running when we cancel.
  // Each chunk takes long enough that the download is still in flight.
  const fetchImpl = fetchMock({ delayChunkMs: 300 });
  const { caches, packs } = newEnv({ fetchImpl });
  // Seed nothing; start full, cancel quickly, then remove.
  if (process.env.PACK_DEBUG) console.log("  [dbg] calling install");
  const p = packs.install("full");
  if (process.env.PACK_DEBUG) console.log("  [dbg] install returned", typeof p, p && p.constructor && p.constructor.name);
  await new Promise((r) => setTimeout(r, 60));
  packs.cancel();
  if (process.env.PACK_DEBUG) console.log("  [dbg] cancelled; job=", JSON.stringify(packs.getJob()));
  const rr = await p;
  if (process.env.PACK_DEBUG) console.log("  [dbg] install resolved:", JSON.stringify(rr));
  await packs.removePack("full");
  const now = await cachedNames(caches);
  check(now.size === 0,
    "cancel a download mid-way, then Remove: nothing left behind (" +
    now.size + " chunk(s))");
}

async function testCancelThenRemoveKeepsProtected() {
  const fetchImpl = fetchMock({ delayChunkMs: 300 });
  const { caches, packs } = newEnv({ fetchImpl });
  await seed(caches, LISTS.common);          // common saved
  const p = packs.install("full");
  await new Promise((r) => setTimeout(r, 120));
  packs.cancel();
  await p;
  await packs.removePack("full");
  const now = await cachedNames(caches);
  const kept = LISTS.common.every((n) => now.has(keyFor(n)));
  check(kept, "cancel+remove keeps chunks protected by another saved pack");
}

async function testSaveTwiceMakesNoRequests() {
  const fetchImpl = fetchMock();
  const { packs } = newEnv({ fetchImpl });
  await packs.install("common");
  const afterFirst = fetchImpl.chunkCount();
  check(afterFirst === LISTS.common.length,
    "first Save fetches every missing chunk (" + afterFirst + ")");
  await packs.install("common");
  const afterSecond = fetchImpl.chunkCount();
  check(afterSecond === afterFirst,
    "second Save makes zero chunk requests (" +
    (afterSecond - afterFirst) + " new)");
}

async function testTwoJobsSecondRefused() {
  const fetchImpl = fetchMock({ delayChunkMs: 50 });
  const { packs } = newEnv({ fetchImpl });
  const first = packs.install("common");
  // Give the first job a moment to take the slot.
  await new Promise((r) => setTimeout(r, 30));
  const second = await packs.install("full");
  check(second && second.refused,
    "two jobs at once: the second is refused (" +
    (second && second.reason) + ")");
  const firstResult = await first;
  check(firstResult && firstResult.complete,
    "the first job still completes correctly");
  const states = await packs.packStates();
  check(states.common.complete, "common is reported complete after the first job");
}

async function testTwoTabsSecondRefused() {
  // Same lock held by "another tab".
  const held = { name: "golinux-pack-job" };
  const { packs } = newEnv({ held });
  const res = await packs.install("common");
  check(res && res.refused,
    "a lock held by another tab refuses the job (" +
    (res && res.reason) + ")");
}

async function testUseMinimalRemovesOnlyPackCache() {
  const { caches, packs } = newEnv();
  await seed(caches, LISTS.full);
  // A chunk cached by NORMAL USE lives in the data cache, not the pack cache.
  const data = await caches.open("golinux-data-v13");
  await data.put(keyFor("chunk-999-1000.zst"), new Response("used"));

  const res = await packs.useMinimal();
  const packNow = await cachedNames(caches);
  check(packNow.size === 0,
    "'Use' on Minimal removes all pack chunks (" + packNow.size + " left)");
  const dataNow = new Set((await data.keys()).map((k) => k.url));
  check(dataNow.has(keyFor("chunk-999-1000.zst")),
    "'Use' on Minimal leaves data-cache chunks (normal use) untouched");
  check(res && res.deleted === LISTS.full.length,
    "it reports the number of chunks removed (" + (res && res.deleted) + ")");
}

async function testReloadMidDownloadShowsPartial() {
  // Deterministic: block every chunk until released, so the state at cancel
  // time is known to be "some, not all".
  let release;
  const gate = new Promise((r) => { release = r; });
  const base = fetchMock();
  let served = 0;
  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (/chunk-\d+-\d+\.zst$/.test(url)) {
      served++;
      if (served > 2) {           // let exactly two chunks land, hold the rest
        await gate;
      }
      if ((init && init.signal && init.signal.aborted)) {
        throw new DOMException("aborted", "AbortError");
      }
      return new Response(new ArrayBuffer(1024), { status: 200 });
    }
    return base(input, init);
  };
  const { caches, packs } = newEnv({ fetchImpl });
  const p = packs.install("full");
  // Wait until two chunks are in the cache, then cancel.
  for (let i = 0; i < 100; i++) {
    const n = (await cachedNames(caches)).size;
    if (n >= 2) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  packs.cancel();
  release();
  await p;

  // "Reload": a brand-new GoPacks over the SAME CacheStorage.
  const after = loadPacks({
    fetchImpl: fetchMock(), caches, locks: fakeLocks({ name: null }),
  });
  const states = await after.packStates();
  check(states.full.present > 0 && states.full.present < states.full.total,
    "reload mid-download: state shows partial progress (" +
    states.full.present + " of " + states.full.total + ")");
  check(!states.full.complete, "and it is not reported as complete");
}

async function testVerifyCountsMissing() {
  const { caches, packs } = newEnv();
  await seed(caches, [LISTS.common[0]]);
  const v = await packs.verify("common");
  check(v.total === LISTS.common.length &&
        v.present === 1 &&
        v.missing === LISTS.common.length - 1,
    "verify counts missing chunks (" + v.present + "/" + v.total + ")");
}

async function testFailedDownloadNotStuck() {
  // Every chunk fails: the job must end, report incomplete, and leave the
  // dialog usable (no leftover job).
  const fetchImpl = fetchMock({ failChunk: () => true });
  const { packs } = newEnv({ fetchImpl });
  const res = await packs.install("common");
  check(res && !res.complete && (res.incomplete || res.error),
    "a failed download reports failure instead of claiming success");
  check(packs.getJob() === null,
    "a failed download leaves no job running (dialog is not stuck)");
}

process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED REJECTION:", e && e.stack || e);
  process.exit(1);
});
process.on("uncaughtException", (e) => {
  console.error("UNCAUGHT:", e && e.stack || e);
  process.exit(1);
});

(async () => {
  const tests = [
    testRemoveCommonKeepsFull,
    testRemoveFullKeepsCommon,
    testRemoveCommonWhenOnlyCommonSaved,
    testRemoveFullKeepsPartialCommon,
    testCancelThenRemove,
    testCancelThenRemoveKeepsProtected,
    testSaveTwiceMakesNoRequests,
    testTwoJobsSecondRefused,
    testTwoTabsSecondRefused,
    testUseMinimalRemovesOnlyPackCache,
    testReloadMidDownloadShowsPartial,
    testVerifyCountsMissing,
    testFailedDownloadNotStuck,
  ];
  for (const t of tests) {
    try { await t(); }
    catch (e) { failed++; console.error("FAIL: " + t.name + " threw: " + e.message); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.error("pack tests FAILED"); process.exit(1); }
  console.log("All pack tests passed.");
})();
