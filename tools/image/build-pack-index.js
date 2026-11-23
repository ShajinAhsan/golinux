#!/usr/bin/env node
// Write packs/index.json (tier sizes for the UI) from the pack lists.
'use strict';

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PACKS_DIR = path.join(ROOT, "packs");
const CHUNKS = path.join(ROOT, "images", "debian-chunks");
const SNAPSHOT = path.join(ROOT, "images", "debian-state.bin.zst");

const snapshotBytes = fs.statSync(SNAPSHOT).size;
const out = {
  minimal: {
    title: "Minimal",
    chunks: 0,
    bytes: 0,
    snapshotBytes,
    totalBytes: snapshotBytes,
  },
};

for (const id of ["common", "full"]) {
  const file = path.join(PACKS_DIR, id + ".json");
  if (!fs.existsSync(file)) continue;
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  const bytes = list.reduce((sum, f) => {
    const p = path.join(CHUNKS, f);
    if (!fs.existsSync(p)) {
      throw new Error(`packs/${id}.json references missing chunk: ${f}`);
    }
    return sum + fs.statSync(p).size;
  }, 0);
  out[id] = {
    title: id === "full" ? "Full" : "Common tools",
    chunks: list.length,
    bytes,
    snapshotBytes,
    totalBytes: snapshotBytes + bytes,
  };
}

fs.writeFileSync(path.join(PACKS_DIR, "index.json"), JSON.stringify(out, null, 2));
for (const [id, v] of Object.entries(out)) {
  console.log(`${id.padEnd(8)} ${String(v.chunks).padStart(5)} chunks  ` +
    `${(v.bytes / 1048576).toFixed(1)} MB  (total with snapshot ${(v.totalBytes / 1048576).toFixed(1)} MB)`);
}
