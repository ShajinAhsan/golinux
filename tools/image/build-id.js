#!/usr/bin/env node
// Generate images/build-id.json: a CONTENT hash of everything a browser loads.
//
// Why content rather than mtimes: with mtimes, rebuilding an unchanged tree
// produced a new id, which would mint a new chunk URL prefix and make every
// client re-download 222 MB for no reason. A content hash gives the same id
// for the same bytes, so a no-op rebuild is a true no-op.
//
// What is hashed:
//   - every REAL chunk: its name and the sha256 of its compressed bytes
//     (empty/zero chunks are excluded: they are not uploaded, and the service
//      worker synthesises them from the zero template)
//   - the zero template
//   - the kernel, initrd and the v86 wasm
//
// The SNAPSHOT is deliberately NOT hashed. It is derived from the disk, and
// the disk is described by the chunks, so including it creates a cycle:
// chunking needs the id, and the id would need the snapshot, which is built
// after chunking. Hashing only its inputs makes the id stable and computable
// exactly once, right after chunking.
//
// The disk image is not hashed either: its bytes are not reproducible (ext4
// UUID and timestamps differ per mkfs), so every rebuild would mint a new id
// even for identical contents. The chunks are what the browser actually
// fetches, so they define the build.
//
// Usage:
//   node tools/image/build-id.js          # write build-id.json
//   node tools/image/build-id.js --check  # verify the recorded id is current
'use strict';

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..", "..");
// --dir: hash the chunks in a staging directory (build.sh does this before the
// content hash - and therefore the final directory name - is known).
const dirArg = process.argv.indexOf("--dir");
const CHUNKS = dirArg > 0
  ? path.resolve(process.argv[dirArg + 1])
  : path.join(ROOT, "images", "debian-chunks");
const OUT = path.join(ROOT, "images", "build-id.json");

/** sha256 of a file, streamed so a large file never sits in memory. */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("error", reject);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

async function computeBuildId() {
  const lines = [];

  // Single served files. A missing one is recorded too, so its appearance or
  // disappearance changes the id.
  for (const rel of ["images/debian-bzImage", "images/debian-initrd",
                     "assets/v86/v86.wasm"]) {
    const p = path.join(ROOT, rel);
    lines.push(`${rel}:${fs.existsSync(p) ? await sha256File(p) : "missing"}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(CHUNKS, "manifest.json"), "utf8"));
  } catch (e) {
    throw new Error("images/debian-chunks/manifest.json is missing — run build.sh first");
  }

  // Sorted by name so filesystem order cannot influence the hash.
  const real = manifest.real.slice().sort();
  for (const name of real) {
    const p = path.join(CHUNKS, name);
    lines.push(`chunk:${name}:${fs.existsSync(p) ? await sha256File(p) : "missing"}`);
  }

  const tplPath = path.join(CHUNKS, manifest.template || "empty-chunk.zst");
  lines.push(`template:${fs.existsSync(tplPath) ? await sha256File(tplPath) : "missing"}`);

  const digest = crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
  return {
    // Short form: used as a URL path segment, so keep it readable.
    buildId: digest.slice(0, 16),
    fullDigest: digest,
    chunkCount: real.length,
    generatedAt: new Date().toISOString(),
  };
}

(async () => {
  const info = await computeBuildId();

  if (process.argv.includes("--check")) {
    let current = null;
    try { current = JSON.parse(fs.readFileSync(OUT, "utf8")).buildId; } catch (e) { /* missing */ }
    if (current !== info.buildId) {
      console.error(`build id mismatch: file has ${current}, contents hash to ${info.buildId}`);
      process.exit(1);
    }
    console.log(`build id current (${info.buildId}, ${info.chunkCount} chunks)`);
    process.exit(0);
  }

  fs.writeFileSync(OUT, JSON.stringify(info, null, 2) + "\n");
  console.log(`build id ${info.buildId} (content hash of ${info.chunkCount} chunks + served files)`);
})().catch((e) => {
  console.error("build-id failed:", e.message);
  process.exit(1);
});
