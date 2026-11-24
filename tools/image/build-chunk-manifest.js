#!/usr/bin/env node
// Generate chunks-precache.json — the list of disk chunks that contain real
// data. The service worker reads it to decide whether to do a full offline
// precache. Chunks that are byte-identical to empty-chunk.zst are excluded;
// the worker substitutes empty-chunk.zst for those, so they never need
// downloading.
'use strict';

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
// --dir lets build.sh point this at the per-build chunk directory, before the
// content build id (and therefore the final directory name) is known.
const dirArg = process.argv.indexOf("--dir");
const DIR = dirArg > 0
  ? path.resolve(process.argv[dirArg + 1])
  : path.join(ROOT, "images", "debian-chunks");
const TEMPLATE = path.join(DIR, "empty-chunk.zst");
const OUT = path.join(DIR, "manifest.json");
const OUT_ROOT = path.join(ROOT, "chunks-precache.json");

// Upper bound used only when searching for the canonical all-zero empty-chunk
// template (a 128 KiB block of zeros compresses to ~25 bytes in zstd).
// Real-chunk classification NEVER uses a size threshold — it requires exact
// byte equality against empty-chunk.zst so small real files (like 24-byte
// /etc/resolv.conf in a 49-byte zstd chunk) are NEVER misclassified as empty.
const MAX_EMPTY_TEMPLATE_BYTES = 64;

const files = fs.readdirSync(DIR).filter(f => /^chunk-\d+-\d+\.zst$/.test(f));

// The empty-chunk template is regenerated here rather than required to exist:
// build.sh recreates the whole chunk directory, which deletes it. Without this
// the manifest step crashed (ENOENT) after a successful image rebuild.
// Use the smallest chunk as the canonical zero template so builds are deterministic.
let template;
if (fs.existsSync(TEMPLATE)) {
  template = fs.readFileSync(TEMPLATE);
} else {
  const smallest = files
    .map((f) => [f, fs.statSync(path.join(DIR, f)).size])
    .filter(([, size]) => size <= MAX_EMPTY_TEMPLATE_BYTES)
    .sort((a, b) => a[1] - b[1])[0];
  if (!smallest) {
    throw new Error("no empty chunk found to use as the zero template in " + DIR);
  }
  template = fs.readFileSync(path.join(DIR, smallest[0]));
  fs.writeFileSync(TEMPLATE, template);
  console.log(`regenerated ${path.basename(TEMPLATE)} from ${smallest[0]}`);
}

const real = [];
let realBytes = 0;
let emptyCount = 0;

for (const f of files) {
  const full = path.join(DIR, f);
  const size = fs.statSync(full).size;
  // Exact byte match against empty-chunk.zst only (fast-path: different size => real data).
  if (size === template.length && fs.readFileSync(full).equals(template)) {
    emptyCount++;
    continue;
  }
  real.push(f);
  realBytes += size;
}

real.sort();

const manifest = { template: "empty-chunk.zst", real };
fs.writeFileSync(OUT, JSON.stringify(manifest));
fs.writeFileSync(OUT_ROOT, JSON.stringify(real));

console.log(`chunks total:      ${files.length}`);
console.log(`with real data:    ${real.length} (${(realBytes / 1048576).toFixed(1)} MB)`);
console.log(`empty (zeroed):    ${emptyCount}`);
console.log(`wrote ${path.relative(ROOT, OUT_ROOT)} for the service worker`);
