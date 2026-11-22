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
function loadWorker({ fetchImpl }) {
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
    location: { origin: ORIGIN, href: ORIGIN + "/", search: "" },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    clients,
    skipWaiting: async () => {},
  };
  const location = selfObj.location;
  const caches = makeCaches();

  // importScripts is a no-op: packs-config.js is concatenated below, so its
  // consts live in the same scope exactly as importScripts would provide.
  const importScripts = () => {};

  // Exported handles (appended, inside the same function scope) so tests can
  // seed/inspect the caches without hardcoding versioned names.
  const exportLine =
    "\n;globalThis.__SW_TEST__ = { GL_SHELL_CACHE, GL_EMPTY_CHUNK_PATH, isEmptyChunkName };\n";

  const body = configSrc + "\n" + swSrc + exportLine;
  // `fetch` MUST be shimmed: in a real worker it is the global, but inside a
  // Node Function scope it would resolve to Node's real fetch and hit the
  // network. Every network call the worker makes goes through this param.
  const runner = new Function(
    "self", "caches", "location", "importScripts", "console", "fetch",
    body + "\nreturn globalThis.__SW_TEST__;"
  );
  const GL = runner(selfObj, caches, location, importScripts, {
    log() {}, warn() {}, error() {},
  }, fetchImpl);

  async function dispatchFetch(request) {
    let respondWith = null;
    const event = {
      request,
      respondWith(p) { respondWith = p; },
    };
    handlers.fetch(event);
    if (!respondWith) throw new Error("sw did not call respondWith");
    return respondWith;
  }

  return { dispatchFetch, messages, caches, GL };
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
  check(driver.messages.length === 0,
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

/* ---------- run ---------- */

(async () => {
  const tests = [
    testEmptyFallback,
    testRealChunk404,
    testNon404OnReal,
    testNetworkFailureOnReal,
    test500OnEmptyName,
    testPageMessageContract,
  ];
  for (const t of tests) {
    try { await t(); }
    catch (e) { failed++; console.error("FAIL: " + t.name + " threw: " + e.message); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.error("SW chunk fallback tests FAILED"); process.exit(1); }
  console.log("All SW chunk fallback tests passed.");
})();
