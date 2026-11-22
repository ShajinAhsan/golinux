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

// Size above which a chunk is considered to hold real data. Zeroed blocks
// compress to ~25 bytes, so 200 is a safe threshold.
const MIN_REAL_BYTES = 200;

const files = fs.readdirSync(DIR).filter(f => /^chunk-\d+-\d+\.zst$/.test(f));

// The empty-chunk template is regenerated here rather than required to exist:
// build.sh recreates the whole chunk directory, which deletes it. Without this
// the manifest step crashed (ENOENT) after a successful image rebuild.
// Any chunk <= MIN_REAL_BYTES is a zeroed block; use the smallest as the
// canonical template so builds do not depend on build order.
let template;
if (fs.existsSync(TEMPLATE)) {
  template = fs.readFileSync(TEMPLATE);
} else {
  const smallest = files
    .map((f) => [f, fs.statSync(path.join(DIR, f)).size])
    .filter(([, size]) => size <= MIN_REAL_BYTES)
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
  if (size <= MIN_REAL_BYTES) {
    emptyCount++;
    continue;
  }
  // Guard against a non-zero chunk that still equals the zero template.
  const buf = fs.readFileSync(full);
  if (buf.equals(template)) {
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
