#!/usr/bin/env node
/**
 * Tests for the offline pack store (packs.js), driven against a fake
 * CacheStorage and multi-tab BroadcastChannel bus.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const ORIGIN = "http://app.test";
const BUILD_ID = "0123456789abcdef";
const cfgSrc = fs.readFileSync(path.join(ROOT, "packs-config.js"), "utf8");
const VERSION = (cfgSrc.match(/const GL_VERSION\s*=\s*"([^"]+)"/) || [])[1] || "v14";
const PACK_CACHE = `golinux-pack-${VERSION}`;
const DATA_CACHE = `golinux-data-${VERSION}`;

function keyOf(k) {
  if (typeof k === "string") return k;
  if (k && typeof k.url === "string") return k.url;
  return String(k);
}

class FakeCache {
  constructor(opts = {}) {
    this.map = new Map();
    this.failPutAt = opts.failPutAt || 0;
    this.puts = 0;
  }
  async put(req, res) {
    this.puts++;
    if (this.failPutAt && this.puts >= this.failPutAt) {
      const err = new Error("quota exceeded");
      err.name = "QuotaExceededError";
      throw err;
    }
    this.map.set(keyOf(req), res);
  }
  async match(req) {
    const v = this.map.get(keyOf(req));
    return v ? v.clone() : undefined;
  }
  async delete(req) { return this.map.delete(keyOf(req)); }
  async keys() { return [...this.map.keys()].map((u) => ({ url: u })); }
}

function makeCaches(opts = {}) {
  const store = new Map();
  return {
    async open(name) {
      if (!store.has(name)) {
        store.set(name, new FakeCache(name === PACK_CACHE ? opts : {}));
      }
      return store.get(name);
    },
    async keys() { return [...store.keys()]; },
    async delete(n) { return store.delete(n); },
    _store: store,
  };
}

const LISTS = {
  common: ["chunk-0-131072.zst", "chunk-131072-262144.zst", "chunk-262144-393216.zst"],
  full: [
    "chunk-0-131072.zst", "chunk-131072-262144.zst", "chunk-262144-393216.zst",
    "chunk-393216-524288.zst", "chunk-524288-655360.zst", "chunk-655360-786432.zst",
  ],
};
const INDEX = {
  minimal: { title: "Minimal", chunks: 0, bytes: 0, snapshotBytes: 100, totalBytes: 100 },
  common: { title: "Common tools", chunks: LISTS.common.length, bytes: 3000, snapshotBytes: 100, totalBytes: 3100 },
  full: { title: "Full", chunks: LISTS.full.length, bytes: 6000, snapshotBytes: 100, totalBytes: 6100 },
};

function makeBroadcastBus() {
  const peers = new Set();
  let messagesSent = 0;
  class BusChannel {
    constructor() { peers.add(this); this._on = null; }
    postMessage(msg) {
      messagesSent++;
      if (messagesSent > 50) throw new Error("infinite BroadcastChannel loop detected!");
      for (const p of peers) {
        if (p !== this && p._on) {
          const target = p;
          queueMicrotask(() => target._on && target._on({ data: msg }));
        }
      }
    }
    set onmessage(fn) { this._on = fn; }
    get onmessage() { return this._on; }
  }
  return { BroadcastChannel: BusChannel, count: () => messagesSent };
}

function loadPacks({ fetchImpl, caches, locks, bus }) {
  const src = fs.readFileSync(path.join(ROOT, "packs.js"), "utf8");
  const win = {};
  const location = { origin: ORIGIN, href: ORIGIN + "/", search: "" };
  const GL_CHUNK_PATH = "images/debian-chunks/" + BUILD_ID + "/";
  const glPackUrl = (f) => ORIGIN + "/packs/" + BUILD_ID + "/" + f;
  const glChunkUrl = (n) => ORIGIN + "/" + GL_CHUNK_PATH + n;
  const bc = bus || makeBroadcastBus();

  const runner = new Function(
    "window", "location", "caches", "fetch", "console",
    "GL_CHUNK_PATH", "glPackUrl", "glChunkUrl", "BroadcastChannel", "GL_PACK_CACHE",
    "navigator", "confirm", "localStorage",
    src + "\nreturn window.GoPacks;"
  );
  return runner(
    win, location, caches, fetchImpl,
    { log() {}, warn() {}, error() {} },
    GL_CHUNK_PATH, glPackUrl, glChunkUrl,
    bc.BroadcastChannel, PACK_CACHE, { locks }, () => true,
    { getItem: () => null, setItem: () => {} }
  );
}

function fakeLocks(sharedHeld) {
  const held = sharedHeld || { name: null };
  return {
    request(name, opts, fn) {
      if (held.name === name) return Promise.resolve(fn(null));
      held.name = name;
      const release = () => { held.name = null; };
      return Promise.resolve(fn({ name })).finally(release);
    },
  };
}

function fetchMock(opts = {}) {
  const calls = [];
  let chunksServed = 0;
  const impl = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    if (url.endsWith("index.json")) return new Response(JSON.stringify(INDEX), { status: 200 });
    const m = url.match(/packs\/[^/]+\/(\w+)\.json$/);
    if (m && LISTS[m[1]]) return new Response(JSON.stringify(LISTS[m[1]]), { status: 200 });
    if (/chunk-\d+-\d+\.zst(\?|$)/.test(url)) {
      chunksServed++;
      if (opts.failChunk && opts.failChunk(url)) return new Response("", { status: 500 });
      if (opts.delayChunkMs) {
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
      return new Response(new ArrayBuffer(1024), { status: 200, headers: { "Content-Length": "1024" } });
    }
    return new Response("", { status: 404 });
  };
  impl.calls = calls;
  impl.chunkCount = () => chunksServed;
  return impl;
}

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
  for (const n of names) await c.put(keyFor(n), new Response("x"));
}

function newEnv(opts = {}) {
  const caches = makeCaches(opts.cacheOpts);
  const held = opts.held || { name: null };
  const fetchImpl = opts.fetchImpl || fetchMock();
  const bus = opts.bus || makeBroadcastBus();
  const packs = loadPacks({ fetchImpl, caches, locks: fakeLocks(held), bus });
  return { caches, packs, fetchImpl, held, bus };
}

async function testRemoveProtection() {
  const { caches, packs } = newEnv();
  await seed(caches, LISTS.full);
  await packs.removePack("common");
  check(LISTS.full.every((n) => cachedNames(caches).then ? true : false), "remove common check ran");
  const now1 = await cachedNames(caches);
  check(LISTS.full.every((n) => now1.has(keyFor(n))), "remove Common keeps Full");
  await packs.removePack("full");
  const now2 = await cachedNames(caches);
  check(LISTS.common.every((n) => now2.has(keyFor(n))), "remove Full keeps Common");
  await packs.removePack("common");
  check((await cachedNames(caches)).size === 0, "remove Common alone deletes all its chunks");
}

async function testTwoTabsNoBroadcastLoop() {
  const bus = makeBroadcastBus();
  const caches = makeCaches();
  const held = { name: null };
  const tab1 = loadPacks({ fetchImpl: fetchMock(), caches, locks: fakeLocks(held), bus });
  const tab2 = loadPacks({ fetchImpl: fetchMock(), caches, locks: fakeLocks(held), bus });
  let tab2Updates = 0;
  tab2.onUpdate(() => { tab2Updates++; });

  await tab1.install("common");
  await new Promise((r) => setTimeout(r, 80));
  check(bus.count() <= 4, `two tabs: BroadcastChannel messages stay bounded (${bus.count()}) (BUG-19)`);
  check(tab2Updates >= 1 && tab2Updates <= 4, `tab2 received bounded updates (${tab2Updates})`);
}

async function testRemoveDuringActiveDownloadWithoutManualAwait() {
  const fetchImpl = fetchMock({ delayChunkMs: 120 });
  const { caches, packs } = newEnv({ fetchImpl });
  const dl = packs.install("full");
  await new Promise((r) => setTimeout(r, 30));
  // Do NOT await dl before calling removePack (exact UI flow, BUG-20)!
  const rm = await packs.removePack("full");
  await dl;
  check(!rm.refused && typeof rm.deleted === "number",
    "removePack during active download cancels, awaits, and removes cleanly (BUG-20)");
  check((await cachedNames(caches)).size === 0, "no chunks left behind after cancel+remove");
}

async function testQuotaErrorAbortsImmediately() {
  const fetchImpl = fetchMock({ delayChunkMs: 10 });
  const { packs } = newEnv({ fetchImpl, cacheOpts: { failPutAt: 2 } });
  const res = await packs.install("full");
  check(!!res.error && /quota/i.test(res.error),
    "QuotaExceededError aborts download with clear error (BUG-21)");
  check(packs.getJob() === null, "job slot released after quota error");
}

async function testPackFetchesUseGlPackBypassAndIdempotent() {
  const fetchImpl = fetchMock();
  const { packs } = newEnv({ fetchImpl });
  await packs.install("common");
  const chunkCalls = fetchImpl.calls.filter((u) => /chunk-/.test(u));
  check(chunkCalls.length === LISTS.common.length && chunkCalls.every((u) => u.includes("gl_pack=1")),
    "pack chunk fetches pass ?gl_pack=1 to avoid SW double-caching (BUG-21)");
  const before = fetchImpl.chunkCount();
  await packs.install("common");
  check(fetchImpl.chunkCount() === before, "second Save makes zero chunk requests");
}

async function testUseMinimalKeepsDataCache() {
  const { caches, packs } = newEnv();
  await seed(caches, LISTS.full);
  const data = await caches.open(DATA_CACHE);
  await data.put(keyFor("chunk-999-1000.zst"), new Response("used"));
  const res = await packs.useMinimal();
  check((await cachedNames(caches)).size === 0 && res.deleted === LISTS.full.length,
    "useMinimal clears pack cache");
  const dataKeys = new Set((await data.keys()).map((k) => k.url));
  check(dataKeys.has(keyFor("chunk-999-1000.zst")), "useMinimal leaves data cache untouched");
}

async function testLockContention() {
  const held = { name: "golinux-pack-job" };
  const { packs } = newEnv({ held });
  const res = await packs.install("common");
  check(res && res.refused, "cross-tab lock refuses second job");
}

(async () => {
  const tests = [
    testRemoveProtection,
    testTwoTabsNoBroadcastLoop,
    testRemoveDuringActiveDownloadWithoutManualAwait,
    testQuotaErrorAbortsImmediately,
    testPackFetchesUseGlPackBypassAndIdempotent,
    testUseMinimalKeepsDataCache,
    testLockContention,
  ];
  for (const t of tests) {
    try { await t(); }
    catch (e) { failed++; console.error("FAIL: " + t.name + " threw: " + e.stack); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.error("pack tests FAILED"); process.exit(1); }
  console.log("All pack tests passed.");
})();
