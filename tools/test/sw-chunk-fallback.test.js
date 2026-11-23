#!/usr/bin/env node
/**
 * Tests for the service worker's chunk fallback logic (sw.js).
 *
 * Loads the REAL sw.js + packs-config.js into a shimmed worker context (no
 * reimplementation), dispatches synthetic fetch events, and asserts the three
 * behaviours the offline/404 policy depends on:
 *
 *   a. a 404 for a name NOT in chunks-precache.json is answered with the
 *      empty-chunk template (a zeroed region v86 only ever reads as zeros)
 *   b. a 404 for a REAL data chunk is NOT answered with zeros: it must return
 *      a failure and post "chunk-missing-real" so the page shows "out of date"
 *   c. non-404 errors (500, network failure) are never turned into zeros
 *
 * Exits non-zero on any failure.
 *
 * Usage: node tools/test/sw-chunk-fallback.test.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const ORIGIN = "http://app.test";
const SNAPSHOT = "images/debian-state.bin.zst";

// Real chunk names for the fake manifest. Only a few are needed.
const REAL_LIST = [
  "chunk-0-131072.zst",
  "chunk-131072-262144.zst",
  "chunk-1048576-1179648.zst",
];
const EMPTY_NAME = "chunk-999-1000.zst";      // not in REAL_LIST -> zeroed
const REAL_NAME = "chunk-0-131072.zst";       // in REAL_LIST -> real data

/* ---------- minimal-but-faithful CacheStorage / worker shims ---------- */

function keyOf(k) {
  if (typeof k === "string") return k;
  if (k && typeof k.url === "string") return k.url;
  return String(k);
}

class FakeCache {
  constructor() { this.map = new Map(); }
  async put(req, res) { this.map.set(keyOf(req), res); }
  async add(req) {
    const u = keyOf(req);
    const r = await globalThis.__TEST_FETCH__(u);
    if (!r.ok) throw new Error("add failed: " + u);
    this.map.set(u, r);
  }
  async match(req, opts) {
    const want = keyOf(req);
    if (this.map.has(want)) return this.map.get(want).clone();
    if (opts && opts.ignoreSearch) {
      const strip = (u) => u.split("?")[0];
      for (const [k, v] of this.map) {
        if (strip(k) === strip(want)) return v.clone();
      }
    }
    return undefined;
  }
}

function makeCaches() {
  const store = new Map();
  return {
    async open(name) {
      if (!store.has(name)) store.set(name, new FakeCache());
      return store.get(name);
    },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    _store: store,
  };
}

/** Load sw.js + packs-config.js in one shared scope and return a driver. */
function loadWorker({ fetchImpl, caches: givenCaches }) {
  globalThis.__TEST_FETCH__ = fetchImpl;

  const configSrc = fs.readFileSync(path.join(ROOT, "packs-config.js"), "utf8");
  const swSrc = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");

  const handlers = {};
  const messages = [];
  const clients = {
    async matchAll() { return [{ postMessage: (m) => messages.push(m) }]; },
    async claim() {},
  };
  const selfObj = {
    location: { origin: ORIGIN, href: ORIGIN + "/", search: "", hostname: "app.test" },
    // A real worker allows MULTIPLE listeners per event; sw.js registers two
    // "message" handlers (asset-base and throughput), so keep an array.
    addEventListener: (type, fn) => {
      (handlers[type] = handlers[type] || []).push(fn);
    },
    clients,
    skipWaiting: async () => {},
  };
  const location = selfObj.location;
  // Reuse the same CacheStorage between two loads to simulate a worker restart.
  const caches_ = givenCaches || makeCaches();

  // importScripts is a no-op: packs-config.js is concatenated below, so its
  // consts live in the same scope exactly as importScripts would provide.
  const importScripts = () => {};

  // Exported handles (appended, inside the same function scope) so tests can
  // seed/inspect the caches without hardcoding versioned names.
  const exportLine =
    "\n;globalThis.__SW_TEST__ = { GL_SHELL_CACHE, GL_EMPTY_CHUNK_PATH, " +
    "isEmptyChunkName, glSetAssetBase, GL_CONFIG_CACHE, GL_ASSET_OVERRIDE_KEY, " +
    "assetBaseReady };\n";

  const body = configSrc + "\n" + swSrc + exportLine;
  // `fetch` MUST be shimmed: in a real worker it is the global, but inside a
  // Node Function scope it would resolve to Node's real fetch and hit the
  // network. Every network call the worker makes goes through this param.
  const runner = new Function(
    "self", "caches", "location", "importScripts", "console", "fetch",
    body + "\nreturn globalThis.__SW_TEST__;"
  );
  const GL = runner(selfObj, caches_, location, importScripts, {
    log() {}, warn() {}, error() {},
  }, fetchImpl);

  let fetchObserver = null;

  async function dispatchFetch(request) {
    if (fetchObserver) fetchObserver(request.url);
    let respondWith = null;
    const event = {
      request,
      respondWith(p) { respondWith = p; },
      waitUntil(p) { /* message handler persistence */ },
    };
    for (const fn of handlers.fetch || []) fn(event);
    if (!respondWith) throw new Error("sw did not call respondWith");
    return respondWith;
  }

  async function sendMessage(data) {
    const event = {
      data,
      waitUntil(p) { return p; },
    };
    for (const fn of handlers.message || []) fn(event);
    // Let the persistence promise settle before the caller inspects storage.
    await new Promise((r) => setTimeout(r, 0));
  }

  return {
    dispatchFetch,
    sendMessage,
    messages,
    caches: caches_,
    GL,
    /** Simulate the page pushing a base (as postMessage would). */
    setAssetBase: (base) => GL.glSetAssetBase(base),
    /** Record every chunk URL that would be fetched. */
    onFetch: (fn) => { fetchObserver = fn; },
    /** Ask the worker for measured throughput, as the page does. */
    askThroughput: async () => {
      const replies = [];
      const event = {
        data: { type: "get-throughput" },
        source: { postMessage: (m) => replies.push(m) },
        waitUntil: (p) => p,
      };
      for (const fn of handlers.message || []) fn(event);
      await new Promise((r) => setTimeout(r, 0));
      const t = replies.find((m) => m && m.type === "throughput");
      return t || null;
    },
    /** Wait for the persisted override restore to settle. */
    ready: GL.assetBaseReady || Promise.resolve(),
  };
}

/* ---------- test plumbing ---------- */

let failed = 0;
let passed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log("ok: " + msg); }
  else { failed++; console.error("FAIL: " + msg); }
}

function chunkRequest(name) {
  return new Request(ORIGIN + "/images/debian-chunks/" + name, { method: "GET" });
}

/** fetch mock: manifest always OK; chunk behaviour supplied per test. */
function fetchWith(chunkBehaviour) {
  return async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("chunks-precache.json")) {
      return new Response(JSON.stringify(REAL_LIST), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return chunkBehaviour(url);
  };
}

/** Seed the shell cache with the empty-chunk template the SW serves. */
async function seedEmptyTemplate(driver) {
  const shell = await driver.caches.open(driver.GL.GL_SHELL_CACHE);
  await shell.put(driver.GL.GL_EMPTY_CHUNK_PATH, new Response("ZEROBYTES"));
}

/* ---------- (a) unknown name + 404 -> empty-chunk template ---------- */

async function testEmptyFallback() {
  const driver = loadWorker({
    fetchImpl: fetchWith(async () => new Response("", { status: 404 })),
  });
  await seedEmptyTemplate(driver);

  const resp = await driver.dispatchFetch(chunkRequest(EMPTY_NAME));
  const body = await resp.text();

  check(body === "ZEROBYTES",
    "(a) 404 for a name not in chunks-precache.json returns the empty-chunk template");
  // disk-activity messages are expected; only a chunk-missing-real means the
  // worker mistook a zeroed region for lost data.
  check(!driver.messages.some((m) => m && m.type === "chunk-missing-real"),
    "(a) no chunk-missing-real message for a known zeroed region");
}

/* ---------- (b) real chunk + 404 -> failure + chunk-missing-real ---------- */

async function testRealChunk404() {
  const driver = loadWorker({
    fetchImpl: fetchWith(async () => new Response("", { status: 404 })),
  });
  await seedEmptyTemplate(driver);

  const resp = await driver.dispatchFetch(chunkRequest(REAL_NAME));
  const body = await resp.text();

  check(body !== "ZEROBYTES",
    "(b) 404 for a real data chunk is NOT answered with zeros");
  check(resp.status === 404,
    "(b) real chunk 404 fails the request (status " + resp.status + ") instead of faking data");
  const msg = driver.messages.find((m) => m && m.type === "chunk-missing-real");
  check(!!msg, "(b) posts chunk-missing-real to the page");
  check(!!msg && msg.name === REAL_NAME,
    "(b) chunk-missing-real carries the chunk name (" + (msg && msg.name) + ")");
}

/* ---------- (c) non-404 errors are never turned into zeros ---------- */

async function testNon404OnReal() {
  const driver = loadWorker({
    fetchImpl: fetchWith(async () => new Response("boom", { status: 500 })),
  });
  await seedEmptyTemplate(driver);

  const resp = await driver.dispatchFetch(chunkRequest(REAL_NAME));
  const body = await resp.text();
  check(resp.status === 500 && body !== "ZEROBYTES",
    "(c) a 500 on a real chunk passes through, not zeros");
}

async function testNetworkFailureOnReal() {
  const driver = loadWorker({
    fetchImpl: fetchWith(async () => { throw new Error("offline"); }),
  });
  await seedEmptyTemplate(driver);

  const resp = await driver.dispatchFetch(chunkRequest(REAL_NAME));
  const body = await resp.text();
  check(resp.status === 503 && body !== "ZEROBYTES",
    "(c) a network failure on a real chunk returns 503, not zeros");
  check(driver.messages.some((m) => m && m.type === "chunk-missing-real"),
    "(c) a network failure on a real chunk posts chunk-missing-real");
}

async function test500OnEmptyName() {
  // Only a 404 is allowed to map to zeros. Any other error must pass through
  // even when the name is a known zeroed region.
  const driver = loadWorker({
    fetchImpl: fetchWith(async () => new Response("boom", { status: 500 })),
  });
  await seedEmptyTemplate(driver);

  const resp = await driver.dispatchFetch(chunkRequest(EMPTY_NAME));
  const body = await resp.text();
  check(resp.status === 500 && body !== "ZEROBYTES",
    "(c) a 500 on a known-empty name still passes through, not zeros");
}

/* ---------- page contract: chunk-missing-real -> "out of date, reload" ---- */

function testPageMessageContract() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  check(/e\.data\.type === "chunk-missing-real"/.test(html),
    "(b) index.html handles the chunk-missing-real message");
  check(/This version is out of date/i.test(html),
    "(b) the handler shows an 'out of date' fatal message");
  check(/Reload the page/i.test(html),
    "(b) the message tells the user to reload");
  check(/statusEl\.textContent = "outdated"/.test(html),
    "(b) the status becomes 'outdated'");
}

/* ---------- versioned (production) chunk paths --------------------------
 *
 * Regression: production URLs include the build id segment
 * (/debian-chunks/<buildId>/chunk-….zst). CHUNK_RE previously matched only the
 * flat local-dev path, so these requests fell through to the shell handler and
 * 404ed against Pages instead of being proxied to the asset origin.
 */

async function testVersionedPathGoesToAssetOrigin() {
  const fetched = [];
  const driver = loadWorker({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      fetched.push(url);
      if (url.endsWith("chunks-precache.json")) {
        return new Response(JSON.stringify(REAL_LIST), { status: 200 });
      }
      return new Response("DATA", { status: 200 });
    },
  });

  const versioned =
    "/images/debian-chunks/3a3a2a8af275cc11/chunk-0-131072.zst";
  const resp = await driver.dispatchFetch(
    new Request(ORIGIN + versioned, { method: "GET" }));

  check((await resp.text()) === "DATA",
    "(versioned) a build-id chunk request is served, not 404ed");
  const hit = fetched.find((u) => u.includes("debian-chunks"));
  check(!!hit && hit.startsWith("https://assets.golinux.app"),
    "(versioned) chunk fetched from the asset origin, not the page origin " +
    "(got " + hit + ")");
  check(!!hit && hit.includes("/debian-chunks/3a3a2a8af275cc11/"),
    "(versioned) the build-id path is preserved in the upstream URL");
}

async function testVersionedHeadGoesToAssetOrigin() {
  const fetched = [];
  const driver = loadWorker({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      fetched.push(url);
      return new Response(null, { status: 200 });
    },
  });
  const versioned =
    "/images/debian-chunks/3a3a2a8af275cc11/chunk-0-131072.zst";
  await driver.dispatchFetch(new Request(ORIGIN + versioned, { method: "HEAD" }));
  const hit = fetched.find((u) => u.includes("debian-chunks"));
  check(!!hit && hit.startsWith("https://assets.golinux.app"),
    "(versioned) HEAD chunk request also goes to the asset origin");
}

/* A chunk request that arrives from anywhere other than the asset origin must
 * still be redirected to it. This is what "chunk requests ALWAYS go to the
 * asset origin" means: not just same-origin requests. */
async function testForeignOriginChunkRedirected() {
  const fetched = [];
  const driver = loadWorker({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      fetched.push(url);
      if (url.endsWith("chunks-precache.json")) {
        return new Response(JSON.stringify(REAL_LIST), { status: 200 });
      }
      return new Response("DATA", { status: 200 });
    },
  });

  // A chunk URL on some other host (e.g. a stale absolute URL that bypassed the
  // page's relative-path rule).
  const foreign =
    "https://stale.example.net/images/debian-chunks/" +
    "3a3a2a8af275cc11/chunk-0-131072.zst";
  const resp = await driver.dispatchFetch(new Request(foreign, { method: "GET" }));
  check((await resp.text()) === "DATA", "(versioned) foreign-origin chunk served");
  const hit = fetched.find((u) => u.includes("debian-chunks"));
  check(!!hit && hit.startsWith("https://assets.golinux.app"),
    "(versioned) a foreign-origin chunk URL is redirected to the asset origin " +
    "(got " + hit + ")");
}

/* ---------- persisted ?assets= override survives a worker restart -------- */

async function testOverridePersistsAcrossRestart() {
  // First worker: the page pushes a local override through the real message
  // path, which must persist it to the config cache.
  const d1 = loadWorker({
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  await d1.sendMessage({ type: "set-asset-base", base: "http://127.0.0.1:8091" });
  const persisted = await d1.caches.open(d1.GL.GL_CONFIG_CACHE);
  const stored = await persisted.match(d1.GL.GL_ASSET_OVERRIDE_KEY);
  check(!!stored && (await stored.clone().text()) === "http://127.0.0.1:8091",
    "(override) the ?assets= base is persisted to CacheStorage");

  // Hand the config cache to a NEW worker, simulating the worker being torn
  // down and restarted. It must restore the override from storage instead of
  // reverting to the production origin.
  const sharedCaches = d1.caches;
  const fetched = [];
  const d2 = loadWorker({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      fetched.push(url);
      if (url.endsWith("chunks-precache.json")) {
        return new Response(JSON.stringify(REAL_LIST), { status: 200 });
      }
      return new Response("DATA", { status: 200 });
    },
    caches: sharedCaches,
  });
  await d2.ready;
  const resp = await d2.dispatchFetch(chunkRequest(REAL_NAME));
  check((await resp.text()) === "DATA",
    "(override) restarted worker serves the chunk");
  const hit = fetched.find((u) => u.includes("debian-chunks"));
  check(!!hit && hit.startsWith("http://127.0.0.1:8091"),
    "(override) restarted worker still uses the persisted local override " +
    "(got " + hit + ")");
}

/* ---------- disk-activity reporting (for the loading indicator) ---------- */

async function testDiskActivityReported() {
  const d = loadWorker({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("chunks-precache.json")) {
        return new Response(JSON.stringify(REAL_LIST), { status: 200 });
      }
      return new Response("DATA", {
        status: 200, headers: { "Content-Length": "4096" },
      });
    },
  });

  const resp = await d.dispatchFetch(chunkRequest(REAL_NAME));
  await resp.text();
  await new Promise((r) => setTimeout(r, 30));

  const msgs = d.messages.filter((m) => m && m.type === "disk-activity");
  check(msgs.length > 0, "(indicator) the worker reports disk activity");
  const busy = msgs.find((m) => m.pending > 0);
  check(!!busy, "(indicator) a busy message is reported");
  // The first busy message necessarily precedes the response (nothing is known
  // yet); the counts and names arrive on the message that follows the fetch.
  const withData = msgs.find((m) => m.bytes > 0);
  check(!!withData && withData.bytes === 4096,
    "(indicator) a message carries the downloaded bytes (" +
    (withData && withData.bytes) + ")");
  check(!!withData && Array.isArray(withData.names) &&
    withData.names.includes(REAL_NAME),
    "(indicator) a message carries the chunk names, for per-tool labelling");
  // The last message must be the idle one, or the bar would never hide.
  const last = msgs[msgs.length - 1];
  check(last.pending === 0, "(indicator) a final idle message is always sent");
}

async function testBurstEndSignalled() {
  // The page cannot infer "the burst is over" from pending===0, because the last
  // data message of a burst still carries newly-arrived files. Without an
  // explicit idle:true the indicator would stay on screen forever.
  const d = loadWorker({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("chunks-precache.json")) {
        return new Response(JSON.stringify(REAL_LIST), { status: 200 });
      }
      return new Response("DATA", {
        status: 200, headers: { "Content-Length": "4096" },
      });
    },
  });
  await (await d.dispatchFetch(chunkRequest(REAL_NAME))).text();
  // The settle timer is 250 ms; wait past it, then look for the idle message.
  await new Promise((r) => setTimeout(r, 400));
  const idle = d.messages.filter((m) => m && m.type === "disk-activity" && m.idle);
  check(idle.length > 0,
    "(indicator) an explicit idle:true burst-end message is sent");
  check(idle.length > 0 && idle[idle.length - 1].pending === 0,
    "(indicator) the burst-end message reports pending 0");
}

async function testNoDiskActivityOnCacheHit() {
  let fetches = 0;
  const d = loadWorker({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("chunks-precache.json")) {
        return new Response(JSON.stringify(REAL_LIST), { status: 200 });
      }
      fetches++;
      return new Response("DATA", {
        status: 200, headers: { "Content-Length": "2048" },
      });
    },
  });
  // Warm the cache with one fetch...
  await (await d.dispatchFetch(chunkRequest(REAL_NAME))).text();
  await new Promise((r) => setTimeout(r, 30));
  d.messages.length = 0;
  const before = fetches;
  // ...then the same chunk again must be a cache hit.
  await (await d.dispatchFetch(chunkRequest(REAL_NAME))).text();
  await new Promise((r) => setTimeout(r, 30));
  check(fetches === before, "(indicator) a cache hit does not refetch");
  check(d.messages.filter((m) => m && m.type === "disk-activity" &&
    m.pending > 0).length === 0,
    "(indicator) a cache hit is not reported as disk loading (no flicker)");
}

async function testThroughputProbe() {
  let n = 0;
  const d = loadWorker({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("chunks-precache.json")) {
        return new Response(JSON.stringify(REAL_LIST), { status: 200 });
      }
      n++;
      await new Promise((r) => setTimeout(r, 5));   // small measurable delay
      return new Response("DATA", {
        status: 200, headers: { "Content-Length": "1024" },
      });
    },
  });

  const first = await d.askThroughput();
  check(first && first.bps === null,
    "(prefetch) throughput is null until there is enough evidence (got " +
    JSON.stringify(first) + ")");

  for (const name of REAL_LIST) {
    await (await d.dispatchFetch(chunkRequest(name))).text();
  }
  const after = await d.askThroughput();
  check(after && typeof after.bps === "number" && after.bps > 0,
    "(prefetch) throughput is measured from real chunk fetches (" +
    (after && after.bps) + " B/s)");
}

/* ---------- run ---------- */

(async () => {
  const tests = [
    testEmptyFallback,
    testRealChunk404,
    testNon404OnReal,
    testNetworkFailureOnReal,
    test500OnEmptyName,
    testPageMessageContract,
    testVersionedPathGoesToAssetOrigin,
    testVersionedHeadGoesToAssetOrigin,
    testForeignOriginChunkRedirected,
    testOverridePersistsAcrossRestart,
    testDiskActivityReported,
    testBurstEndSignalled,
    testNoDiskActivityOnCacheHit,
    testThroughputProbe,
  ];
  for (const t of tests) {
    try { await t(); }
    catch (e) { failed++; console.error("FAIL: " + t.name + " threw: " + e.message); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.error("SW chunk fallback tests FAILED"); process.exit(1); }
  console.log("All SW chunk fallback tests passed.");
})();
