#!/usr/bin/env node
/**
 * Service worker unit tests (sw.js + packs-config.js).
 *
 * Covers:
 *   - 404 empty -> empty-chunk.zst; 404 real -> 404 + chunk-missing-real (never zeros)
 *   - 500 -> passthrough (never zeros)
 *   - offline real -> 408 + chunk-offline (NOT 503 retry storm, NOT "out of date")
 *   - offline empty -> empty-chunk.zst silently (no offline banner!)
 *   - missing chunks-precache.json returns false AND retries on recovery (BUG-10)
 *   - versioned chunk GET & HEAD go to asset origin AND HEAD preserves method:"HEAD" (BUG-11)
 *   - foreign-origin chunk redirected to asset origin
 *   - ?assets= override persists on localhost, IGNORED on production host (BUG-06)
 *   - /packs/*.json and ?gl_pack=1 bypass SW shell/data caches (BUG-07, BUG-21)
 *   - disk-activity reporting, idle:true settle, cache-hit silence, throughput probe
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PROD_ORIGIN = "https://golinux.app";
const LOCAL_ORIGIN = "http://127.0.0.1:8090";

const REAL_LIST = [
  "chunk-0-131072.zst",
  "chunk-131072-262144.zst",
  "chunk-1048576-1179648.zst",
];
const EMPTY_NAME = "chunk-999-1000.zst";
const REAL_NAME = "chunk-0-131072.zst";

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

function loadWorker({ fetchImpl, caches: givenCaches, origin = PROD_ORIGIN }) {
  globalThis.__TEST_FETCH__ = fetchImpl;

  const configSrc = fs.readFileSync(path.join(ROOT, "packs-config.js"), "utf8");
  const swSrc = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const u = new URL(origin);

  const handlers = {};
  const messages = [];
  const clients = {
    async matchAll() { return [{ postMessage: (m) => messages.push(m) }]; },
    async claim() {},
  };
  const selfObj = {
    location: { origin: u.origin, href: u.origin + "/", search: "", hostname: u.hostname },
    addEventListener: (type, fn) => {
      (handlers[type] = handlers[type] || []).push(fn);
    },
    clients,
    skipWaiting: async () => {},
  };
  const caches_ = givenCaches || makeCaches();
  const importScripts = () => {};

  const exportLine =
    "\n;globalThis.__SW_TEST__ = { GL_SHELL_CACHE, GL_DATA_CACHE, GL_EMPTY_CHUNK_PATH, " +
    "GL_SHELL_FILES, isEmptyChunkName, glSetAssetBase, GL_CONFIG_CACHE, GL_ASSET_OVERRIDE_KEY, " +
    "assetBaseReady };\n";

  const runner = new Function(
    "self", "caches", "location", "importScripts", "console", "fetch",
    configSrc + "\n" + swSrc + exportLine + "\nreturn globalThis.__SW_TEST__;"
  );
  const GL = runner(selfObj, caches_, selfObj.location, importScripts, {
    log() {}, warn() {}, error() {},
  }, fetchImpl);

  async function dispatchFetch(request) {
    let respondWith = null;
    const event = {
      request,
      respondWith(p) { respondWith = p; },
      waitUntil(p) { return p; },
    };
    for (const fn of handlers.fetch || []) fn(event);
    if (!respondWith) return null; // explicitly bypassed SW
    return respondWith;
  }

  async function sendMessage(data) {
    const event = { data, waitUntil(p) { return p; } };
    for (const fn of handlers.message || []) fn(event);
    await new Promise((r) => setTimeout(r, 0));
  }

  return {
    origin: u.origin,
    dispatchFetch,
    sendMessage,
    messages,
    caches: caches_,
    GL,
    ready: GL.assetBaseReady || Promise.resolve(),
    askThroughput: async () => {
      const replies = [];
      const event = {
        data: { type: "get-throughput" },
        source: { postMessage: (m) => replies.push(m) },
        waitUntil: (p) => p,
      };
      for (const fn of handlers.message || []) fn(event);
      await new Promise((r) => setTimeout(r, 0));
      return replies.find((m) => m && m.type === "throughput") || null;
    },
  };
}

let failed = 0, passed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log("ok: " + msg); }
  else { failed++; console.error("FAIL: " + msg); }
}

function chunkRequest(name, origin = PROD_ORIGIN) {
  return new Request(origin + "/images/debian-chunks/" + name, { method: "GET" });
}

function fetchWith(chunkBehaviour) {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("chunks-precache.json")) {
      return new Response(JSON.stringify(REAL_LIST), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("bundles.json")) {
      return new Response("", { status: 404 });
    }
    return chunkBehaviour(url, init);
  };
}

async function seedEmptyTemplate(driver) {
  const shell = await driver.caches.open(driver.GL.GL_SHELL_CACHE);
  await shell.put(driver.GL.GL_EMPTY_CHUNK_PATH, new Response("ZEROBYTES"));
}

async function testShellPrecacheIncludesManifestAndEmpty() {
  const d = loadWorker({ fetchImpl: fetchWith(async () => new Response("", { status: 404 })) });
  check(d.GL.GL_SHELL_FILES.includes("chunks-precache.json"),
    "GL_SHELL_FILES includes chunks-precache.json (BUG-10)");
  check(d.GL.GL_SHELL_FILES.includes("assets/empty-chunk.zst"),
    "GL_SHELL_FILES includes assets/empty-chunk.zst");
}

async function testEmptyFallback() {
  let networkChunkFetches = 0;
  const d = loadWorker({
    fetchImpl: fetchWith(async (url) => {
      networkChunkFetches++;
      return new Response("", { status: 404 });
    }),
  });
  await seedEmptyTemplate(d);
  const resp = await d.dispatchFetch(chunkRequest(EMPTY_NAME));
  check((await resp.text()) === "ZEROBYTES",
    "(a) known-empty chunk returns empty-chunk template");
  check(networkChunkFetches === 0,
    "(a) known-empty chunk short-circuits locally with ZERO R2 network fetches (Step 1)");
  check(!d.messages.some((m) => m && m.type === "chunk-missing-real"),
    "(a) no chunk-missing-real message for zeroed chunk");
}

async function testRealChunk404() {
  const d = loadWorker({ fetchImpl: fetchWith(async () => new Response("", { status: 404 })) });
  await seedEmptyTemplate(d);
  const resp = await d.dispatchFetch(chunkRequest(REAL_NAME));
  check((await resp.text()) !== "ZEROBYTES" && resp.status === 404,
    "(b) 404 for real chunk fails with 404, never zeros");
  const msg = d.messages.find((m) => m && m.type === "chunk-missing-real");
  check(!!msg && msg.name === REAL_NAME,
    "(b) 404 for real chunk posts chunk-missing-real");
}

async function test500NeverZeros() {
  const d = loadWorker({ fetchImpl: fetchWith(async () => new Response("boom", { status: 500 })) });
  await seedEmptyTemplate(d);
  const resp = await d.dispatchFetch(chunkRequest(REAL_NAME));
  check(resp.status === 500 && (await resp.text()) !== "ZEROBYTES",
    `(c) 500 on ${REAL_NAME} passes through, never zeros`);
}

async function testOfflineRealAndEmptyPolicy() {
  // Real chunk offline -> 408 + chunk-offline (NOT 503 retry storm, NOT chunk-missing-real!)
  const d1 = loadWorker({ fetchImpl: fetchWith(async () => { throw new Error("offline"); }) });
  await seedEmptyTemplate(d1);
  const r1 = await d1.dispatchFetch(chunkRequest(REAL_NAME));
  check(r1.status === 408 && (await r1.text()) !== "ZEROBYTES",
    "(offline) real chunk returns 408 (outside 5xx retry storm), never zeros (BUG-09)");
  check(d1.messages.some((m) => m && m.type === "chunk-offline"),
    "(offline) real chunk posts chunk-offline (not out-of-date)");
  check(!d1.messages.some((m) => m && m.type === "chunk-missing-real"),
    "(offline) real chunk does NOT post chunk-missing-real");

  // Empty chunk offline -> empty template SILENTLY (no offline banner)
  const d2 = loadWorker({ fetchImpl: fetchWith(async () => { throw new Error("offline"); }) });
  await seedEmptyTemplate(d2);
  const r2 = await d2.dispatchFetch(chunkRequest(EMPTY_NAME));
  check((await r2.text()) === "ZEROBYTES",
    "(offline) known-empty chunk returns empty template");
  check(!d2.messages.some((m) => m && (m.type === "chunk-miss" || m.type === "chunk-offline" || m.type === "chunk-missing-real")),
    "(offline) known-empty chunk does NOT show error/offline banner (BUG-09)");
}

async function testMissingManifestRetriesOnRecovery() {
  let manifestUp = false;
  const d = loadWorker({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("chunks-precache.json")) {
        if (!manifestUp) throw new Error("transient failure");
        return new Response(JSON.stringify(REAL_LIST), { status: 200 });
      }
      return new Response("", { status: 404 });
    },
  });
  check((await d.GL.isEmptyChunkName(EMPTY_NAME)) === false,
    "(manifest) unavailable manifest conservatively assumes real");
  manifestUp = true;
  check((await d.GL.isEmptyChunkName(EMPTY_NAME)) === true,
    "(manifest) retries and succeeds once manifest becomes available (BUG-10)");
}

async function testVersionedGetAndHeadAndForeign() {
  const calls = [];
  const d = loadWorker({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init && init.method) || (typeof input === "object" && input.method) || "GET";
      calls.push({ url, method });
      if (url.endsWith("chunks-precache.json")) return new Response(JSON.stringify(REAL_LIST), { status: 200 });
      return new Response(method === "HEAD" ? null : "DATA", { status: 200 });
    },
  });

  const versioned = "/images/debian-chunks/3a3a2a8af275cc11/chunk-0-131072.zst";
  await d.dispatchFetch(new Request(PROD_ORIGIN + versioned, { method: "HEAD" }));
  const headCall = calls.find((c) => c.url.includes("debian-chunks"));
  check(!!headCall && headCall.url.startsWith("https://assets.golinux.app") && headCall.method === "HEAD",
    "(versioned) HEAD forwards to asset origin with method HEAD (BUG-11)");

  calls.length = 0;
  const resp = await d.dispatchFetch(new Request(PROD_ORIGIN + versioned, { method: "GET" }));
  check((await resp.text()) === "DATA", "(versioned) GET serves build-id chunk");
  const getCall = calls.find((c) => c.url.includes("debian-chunks"));
  check(!!getCall && getCall.url.startsWith("https://assets.golinux.app/images/debian-chunks/3a3a2a8af275cc11/"),
    "(versioned) GET preserves build-id path on asset origin");

  const foreign = "https://stale.example.net/images/debian-chunks/3a3a2a8af275cc11/chunk-131072-262144.zst";
  calls.length = 0;
  await d.dispatchFetch(new Request(foreign, { method: "GET" }));
  const fCall = calls.find((c) => c.url.includes("chunk-131072-262144"));
  check(!!fCall && fCall.url.startsWith("https://assets.golinux.app"),
    "(versioned) foreign-origin chunk redirected to asset origin");
}

async function testOverrideLocalhostOnlyAndRestart() {
  // Production host MUST ignore set-asset-base (BUG-06)
  const prodFetched = [];
  const dProd = loadWorker({
    origin: PROD_ORIGIN,
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      prodFetched.push(url);
      return new Response("DATA", { status: 200 });
    },
  });
  await dProd.sendMessage({ type: "set-asset-base", base: "https://evil.example" });
  await dProd.dispatchFetch(chunkRequest(REAL_NAME, PROD_ORIGIN));
  const prodHit = prodFetched.find((u) => u.includes("debian-chunks"));
  check(!!prodHit && prodHit.startsWith("https://assets.golinux.app"),
    "(security) production SW ignores ?assets= override (BUG-06)");

  // Localhost MUST persist override across SW restart
  const d1 = loadWorker({
    origin: LOCAL_ORIGIN,
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  await d1.sendMessage({ type: "set-asset-base", base: "http://127.0.0.1:8091" });
  const fetched = [];
  const d2 = loadWorker({
    origin: LOCAL_ORIGIN,
    caches: d1.caches,
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      fetched.push(url);
      return new Response("DATA", { status: 200 });
    },
  });
  await d2.ready;
  await d2.dispatchFetch(chunkRequest(REAL_NAME, LOCAL_ORIGIN));
  const hit = fetched.find((u) => u.includes("debian-chunks"));
  check(!!hit && hit.startsWith("http://127.0.0.1:8091"),
    "(override) localhost override persists across SW restart");
}

async function testPackListAndPackQueryBypass() {
  const d = loadWorker({ fetchImpl: async () => new Response("[]", { status: 200 }) });
  const rPackList = await d.dispatchFetch(
    new Request("https://assets.golinux.app/packs/3a3a2a8af275cc11/tools.json", { method: "GET" })
  );
  check(rPackList === null, "(bypass) /packs/*.json bypasses SW shell cache (BUG-07)");

  const rPackChunk = await d.dispatchFetch(
    new Request("https://assets.golinux.app/images/debian-chunks/3a3a2a8af275cc11/chunk-0-131072.zst?gl_pack=1", { method: "GET" })
  );
  check(rPackChunk === null, "(bypass) ?gl_pack=1 bypasses SW GL_DATA_CACHE double-caching (BUG-21)");
}

async function testDiskActivityAndThroughput() {
  const d = loadWorker({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("chunks-precache.json")) return new Response(JSON.stringify(REAL_LIST), { status: 200 });
      await new Promise((r) => setTimeout(r, 5));
      return new Response("DATA", { status: 200, headers: { "Content-Length": "4096" } });
    },
  });
  check((await d.askThroughput()).bps === null, "(prefetch) throughput null before 3 samples");
  for (const name of REAL_LIST) {
    await (await d.dispatchFetch(chunkRequest(name))).text();
  }
  await new Promise((r) => setTimeout(r, 350));
  const after = await d.askThroughput();
  check(after && after.bps > 0, "(prefetch) throughput measured from network fetches");
  check(d.messages.some((m) => m.type === "disk-activity" && m.idle === true && m.pending === 0),
    "(indicator) idle:true burst-end message sent");

  // Cache hit silence
  d.messages.length = 0;
  await (await d.dispatchFetch(chunkRequest(REAL_NAME))).text();
  await new Promise((r) => setTimeout(r, 30));
  check(!d.messages.some((m) => m.type === "disk-activity" && m.pending > 0),
    "(indicator) cache hit reports no disk activity");
}

async function testHybridBundleFetchDedupeAndOffline() {
  const bundlePayload = Buffer.concat([Buffer.from("CHUNK_ZERO_BYTES"), Buffer.from("CHUNK_ONE_BYTES!")]);
  const bundleManifest = {
    v: 1,
    buildId: "test",
    chunkSize: 131072,
    files: ["b-core-000.pack"],
    entries: [
      [0, 0, 0, 16],
      [1, 0, 16, 16],
    ],
  };

  let bundleFetches = 0;
  let headFetches = 0;
  const d = loadWorker({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("chunks-precache.json")) {
        return new Response(JSON.stringify(REAL_LIST), { status: 200 });
      }
      if (url.endsWith("bundles.json")) {
        return new Response(JSON.stringify(bundleManifest), { status: 200 });
      }
      if (init && init.method === "HEAD") {
        headFetches++;
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("b-core-000.pack")) {
        bundleFetches++;
        await new Promise((r) => setTimeout(r, 15));
        return new Response(bundlePayload, {
          status: 200,
          headers: { "Content-Length": String(bundlePayload.length) },
        });
      }
      return new Response("", { status: 404 });
    },
  });
  await seedEmptyTemplate(d);

  // HEAD on bundled chunk must answer from bundles.json with 0 network fetches!
  const headRes = await d.dispatchFetch(new Request(PROD_ORIGIN + "/images/debian-chunks/" + REAL_LIST[0], { method: "HEAD" }));
  check(headRes.status === 200 && headRes.headers.get("Content-Length") === "16" && headFetches === 0,
    "(bundle) HEAD answers exact Content-Length from bundles.json with 0 network fetches");

  // Two concurrent GETs for sibling chunks in the SAME bundle -> ONLY 1 bundle fetch!
  const [r0, r1] = await Promise.all([
    d.dispatchFetch(chunkRequest(REAL_LIST[0])),
    d.dispatchFetch(chunkRequest(REAL_LIST[1])),
  ]);
  check((await r0.text()) === "CHUNK_ZERO_BYTES" && (await r1.text()) === "CHUNK_ONE_BYTES!",
    "(bundle) concurrent requests unpack exact sibling chunk slices");
  check(bundleFetches === 1,
    `(bundle) in-flight deduplication made 1 bundle fetch for 2 concurrent chunks (got ${bundleFetches})`);

  // Subsequent read of sibling chunk hits GL_DATA_CACHE with 0 network fetches!
  const r1Again = await d.dispatchFetch(chunkRequest(REAL_LIST[1]));
  check((await r1Again.text()) === "CHUNK_ONE_BYTES!" && bundleFetches === 1,
    "(bundle) unpacked sibling chunk served from GL_DATA_CACHE with 0 network fetches");

  // Offline bundle fetch -> 408 + chunk-offline (never zeros, never out-of-date)
  const dOff = loadWorker({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("chunks-precache.json")) return new Response(JSON.stringify(REAL_LIST), { status: 200 });
      if (url.endsWith("bundles.json")) return new Response(JSON.stringify(bundleManifest), { status: 200 });
      throw new Error("offline");
    },
  });
  await seedEmptyTemplate(dOff);
  const rOff = await dOff.dispatchFetch(chunkRequest(REAL_LIST[0]));
  check(rOff.status === 408 && dOff.messages.some((m) => m.type === "chunk-offline") &&
        !dOff.messages.some((m) => m.type === "chunk-missing-real"),
    "(bundle) offline bundle fetch returns 408 + chunk-offline (never zeros)");
}

function testPageMessageContract() {
  const mainJs = fs.readFileSync(path.join(ROOT, "js/main.js"), "utf8");
  check(/data\.type === "chunk-missing-real"/.test(mainJs), "(page) js/main.js handles chunk-missing-real");
  check(/data\.type === "chunk-offline"/.test(mainJs), "(page) js/main.js handles chunk-offline -> offlineBanner");
  check(/This version is out of date/i.test(mainJs), "(page) chunk-missing-real shows out-of-date fatal");
}

(async () => {
  const tests = [
    testShellPrecacheIncludesManifestAndEmpty,
    testEmptyFallback,
    testRealChunk404,
    test500NeverZeros,
    testOfflineRealAndEmptyPolicy,
    testMissingManifestRetriesOnRecovery,
    testVersionedGetAndHeadAndForeign,
    testOverrideLocalhostOnlyAndRestart,
    testPackListAndPackQueryBypass,
    testDiskActivityAndThroughput,
    testHybridBundleFetchDedupeAndOffline,
    testPageMessageContract,
  ];
  for (const t of tests) {
    try { await t(); }
    catch (e) { failed++; console.error("FAIL: " + t.name + " threw: " + e.stack); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.error("SW chunk fallback tests FAILED"); process.exit(1); }
  console.log("All SW chunk fallback tests passed.");
})();
