#!/usr/bin/env node
// Build optimal hybrid chunk bundles for GoLinux so browsers fetch small,
// fast-loading .pack bundles (~500 KB - 1.1 MB max) instead of thousands of
// individual 128 KiB .zst files.
//
// Strategy:
//   1. Hot frequently-used tools (ls, nano, vim, tree, htop, jq, fastfetch,
//      cowsay, figlet, sl, neofetch, file, bc, make, zip) go into small
//      ~700 KB bundles (b-core-*.pack) so everyday commands warm in 1-2 tiny
//      requests.
//   2. Medium/large developer tools (git, tmux, python3, man, curl, gcc, g++)
//      each get dedicated bundles capped at ~1.0 MB in FIRST-TOUCH order, so
//      cold tool loads stream smoothly without ever stalling on a giant blob.
//   3. All remaining real chunks (the cold tail) are packed sequentially by
//      disk offset into ~768 KB (max 24 chunks) super-chunks (b-tail-*.pack).
//
// Each .pack file is simply raw concatenated .zst chunks (zero re-compression,
// zero CPU overhead in the Service Worker — sliced with ArrayBuffer.slice()).
//
// Outputs:
//   images/debian-bundles/<buildId>/b-*.pack   (uploaded to R2 under bundles/<buildId>/)
//   images/debian-bundles/b-*.pack             (flat mirror for local dev)
//   bundles.json                               (compact index precached in GL_SHELL_FILES)
//
// Usage:
//   node tools/image/build-bundles.js
'use strict';

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const CHUNKS_ROOT = path.join(ROOT, "images", "debian-chunks");
const BUNDLES_ROOT = path.join(ROOT, "images", "debian-bundles");
const TOOLS_PATH = path.join(ROOT, "packs", "tools.json");
const BUILD_ID_PATH = path.join(ROOT, "images", "build-id.json");
const OUT_INDEX = path.join(ROOT, "bundles.json");

const CHUNK_SIZE = 128 * 1024;
const CHUNK_RE = /^chunk-(\d+)-(\d+)\.zst$/;

// Ordered tiers: earlier tiers claim shared chunks first (so libc/shared libs
// land in the tiny hot b-core bundle instead of being buried in b-gcc!).
const TIERS = [
  {
    prefix: "core",
    maxBytes: 750 * 1024,
    maxChunks: 32,
    tools: [
      "ls", "nano", "vim", "tree", "htop", "jq", "file", "bc",
      "fastfetch", "cowsay", "figlet", "sl", "neofetch", "make", "zip",
    ],
  },
  { prefix: "git", maxBytes: 1024 * 1024, maxChunks: 32, tools: ["git"] },
  { prefix: "tmux", maxBytes: 1024 * 1024, maxChunks: 32, tools: ["tmux"] },
  { prefix: "py", maxBytes: 1024 * 1024, maxChunks: 32, tools: ["python3"] },
  { prefix: "man", maxBytes: 1024 * 1024, maxChunks: 32, tools: ["man"] },
  { prefix: "curl", maxBytes: 1024 * 1024, maxChunks: 32, tools: ["curl"] },
  { prefix: "gcc", maxBytes: 1024 * 1024, maxChunks: 32, tools: ["gcc"] },
  { prefix: "gpp", maxBytes: 1024 * 1024, maxChunks: 32, tools: ["g++"] },
];

const TAIL_MAX_BYTES = 768 * 1024;
const TAIL_MAX_CHUNKS = 24;

function chunkIndex(name) {
  const m = CHUNK_RE.exec(name);
  if (!m) throw new Error("unexpected chunk filename: " + name);
  const start = Number(m[1]);
  if (start % CHUNK_SIZE !== 0) throw new Error("unaligned chunk start: " + name);
  return start / CHUNK_SIZE;
}

function main() {
  if (!fs.existsSync(BUILD_ID_PATH)) {
    throw new Error("images/build-id.json missing; run build-id.js first");
  }
  const buildId = JSON.parse(fs.readFileSync(BUILD_ID_PATH, "utf8")).buildId;
  if (!buildId) throw new Error("buildId is empty");

  const srcDir = fs.existsSync(path.join(CHUNKS_ROOT, buildId))
    ? path.join(CHUNKS_ROOT, buildId)
    : CHUNKS_ROOT;

  const manifestPath = fs.existsSync(path.join(srcDir, "manifest.json"))
    ? path.join(srcDir, "manifest.json")
    : path.join(CHUNKS_ROOT, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const realList = manifest.real || [];
  const realSet = new Set(realList);

  const tools = fs.existsSync(TOOLS_PATH)
    ? JSON.parse(fs.readFileSync(TOOLS_PATH, "utf8"))
    : {};

  // Pre-stat every real chunk once.
  const sizeOf = new Map();
  for (const name of realList) {
    const p = path.join(srcDir, name);
    sizeOf.set(name, fs.statSync(p).size);
  }

  const assigned = new Set();
  const bundleSpecs = []; // { file, chunks: string[] }

  function packIntoSlices(prefix, chunkNames, maxBytes, maxChunks) {
    let cur = [];
    let curBytes = 0;
    let sliceIdx = 0;
    const flush = () => {
      if (!cur.length) return;
      bundleSpecs.push({
        file: `b-${prefix}-${String(sliceIdx++).padStart(3, "0")}.pack`,
        chunks: cur,
      });
      cur = [];
      curBytes = 0;
    };
    for (const name of chunkNames) {
      const sz = sizeOf.get(name);
      if (cur.length > 0 && (curBytes + sz > maxBytes || cur.length >= maxChunks)) {
        flush();
      }
      cur.push(name);
      curBytes += sz;
    }
    flush();
  }

  // 1. Hot tool tiers (preserving first-touch order within each tier).
  for (const tier of TIERS) {
    const tierChunks = [];
    for (const t of tier.tools) {
      const entry = tools[t];
      if (!entry || !Array.isArray(entry.chunks)) continue;
      for (const name of entry.chunks) {
        if (realSet.has(name) && !assigned.has(name)) {
          assigned.add(name);
          tierChunks.push(name);
        }
      }
    }
    packIntoSlices(tier.prefix, tierChunks, tier.maxBytes, tier.maxChunks);
  }

  // 2. Remaining real chunks sorted by numeric disk offset.
  const tailChunks = realList
    .filter((n) => !assigned.has(n))
    .sort((a, b) => chunkIndex(a) - chunkIndex(b));
  for (const n of tailChunks) assigned.add(n);
  packIntoSlices("tail", tailChunks, TAIL_MAX_BYTES, TAIL_MAX_CHUNKS);

  // Sanity: every single real chunk must appear in exactly one bundle.
  if (assigned.size !== realSet.size) {
    throw new Error(`bundle coverage mismatch: ${assigned.size} vs ${realSet.size}`);
  }

  // Write .pack files into per-build dir + flat local-dev mirror.
  const outBuildDir = path.join(BUNDLES_ROOT, buildId);
  fs.rmSync(outBuildDir, { recursive: true, force: true });
  fs.mkdirSync(outBuildDir, { recursive: true });
  // Clear old flat .pack files in BUNDLES_ROOT
  for (const f of fs.readdirSync(BUNDLES_ROOT)) {
    if (f.endsWith(".pack")) fs.unlinkSync(path.join(BUNDLES_ROOT, f));
  }

  const files = [];
  const entries = []; // [chunkIdx, fileIdx, byteOffset, byteLen]
  let totalBytes = 0;
  let maxBundleBytes = 0;

  for (let fileIdx = 0; fileIdx < bundleSpecs.length; fileIdx++) {
    const spec = bundleSpecs[fileIdx];
    files.push(spec.file);
    const bufs = [];
    let offset = 0;
    for (const name of spec.chunks) {
      const data = fs.readFileSync(path.join(srcDir, name));
      entries.push([chunkIndex(name), fileIdx, offset, data.length]);
      bufs.push(data);
      offset += data.length;
    }
    const packed = Buffer.concat(bufs, offset);
    fs.writeFileSync(path.join(outBuildDir, spec.file), packed);
    fs.copyFileSync(path.join(outBuildDir, spec.file), path.join(BUNDLES_ROOT, spec.file));
    totalBytes += offset;
    if (offset > maxBundleBytes) maxBundleBytes = offset;
  }

  // Sort entries by chunkIdx for deterministic output.
  entries.sort((a, b) => a[0] - b[0]);

  const indexObj = {
    v: 1,
    buildId,
    chunkSize: CHUNK_SIZE,
    files,
    entries,
  };
  const indexJson = JSON.stringify(indexObj);
  fs.writeFileSync(OUT_INDEX, indexJson);

  const hotCount = bundleSpecs.filter((s) => !s.file.startsWith("b-tail-")).length;
  const tailCount = bundleSpecs.length - hotCount;
  console.log(
    `bundles built: ${bundleSpecs.length} files (${hotCount} hot tool, ${tailCount} tail) ` +
    `covering ${entries.length} real chunks, total ${(totalBytes / 1048576).toFixed(1)} MB, ` +
    `max bundle ${(maxBundleBytes / 1024).toFixed(0)} KB, ` +
    `bundles.json ${(indexJson.length / 1024).toFixed(1)} KB`
  );
  for (const spec of bundleSpecs.filter((s) => !s.file.startsWith("b-tail-"))) {
    const sz = fs.statSync(path.join(outBuildDir, spec.file)).size;
    console.log(`  ${spec.file.padEnd(20)} ${String(spec.chunks.length).padStart(3)} chunks  ${(sz / 1024).toFixed(0).padStart(5)} KB`);
  }
}

main();
