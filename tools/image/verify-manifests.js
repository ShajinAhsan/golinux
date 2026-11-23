#!/usr/bin/env node
// Fail loudly if the generated manifests no longer match the files on disk.
//
// Called at the end of build.sh and build-snapshot.sh. A stale manifest is the
// kind of bug that only shows up as a mysterious runtime failure: a snapshot
// size hint that is wrong, or a pack listing chunks that were renumbered when
// the disk image was rebuilt.
//
// Single sources of truth checked here:
//   packs/index.json      sizes shown in the UI + snapshotBytes
//   packs/*.json          chunk lists for the opt-in packs
//   packs-config.js       the ONE cache version shared by index.html and sw.js
'use strict';

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const CHUNKS = path.join(ROOT, "images", "debian-chunks");
const SNAPSHOT = path.join(ROOT, "images", "debian-state.bin.zst");
const INDEX = path.join(ROOT, "packs", "index.json");

const problems = [];
const notes = [];

function fail(msg) { problems.push(msg); }

// ---- snapshot size recorded in packs/index.json -------------------------
if (!fs.existsSync(INDEX)) {
  fail("packs/index.json is missing — run: node tools/image/build-pack-index.js");
} else {
  const index = JSON.parse(fs.readFileSync(INDEX, "utf8"));

  if (fs.existsSync(SNAPSHOT)) {
    const actual = fs.statSync(SNAPSHOT).size;
    const recorded = index.minimal && index.minimal.snapshotBytes;
    if (recorded !== actual) {
      fail(`snapshot size is stale in packs/index.json: recorded ${recorded}, ` +
        `actual ${actual}. Run: node tools/image/build-pack-index.js`);
    } else {
      notes.push(`snapshot size matches (${actual} bytes)`);
    }
  } else {
    fail("images/debian-state.bin.zst is missing — run tools/image/build-snapshot.sh");
  }

  // ---- every listed chunk must exist, and sizes must add up -------------
  const expected = JSON.parse(fs.readFileSync(path.join(ROOT, "packs", "common.json"), "utf8"));
  const common = index.common;
  if (common && expected.length !== common.chunks) {
    fail(`common pack count is stale in packs/index.json: recorded ${common.chunks}, ` +
      `list has ${expected.length}. Run: node tools/image/build-pack-index.js`);
  }

  // Every pack file the UI can install must exist, or "Save" silently no-ops.
  for (const id of ["common", "full"]) {
    const pf = path.join(ROOT, "packs", id + ".json");
    if (!fs.existsSync(pf)) {
      fail(`packs/${id}.json is missing — run: node tools/image/build-packs.js ${id}`);
    } else if (index[id] && JSON.parse(fs.readFileSync(pf, "utf8")).length !== index[id].chunks) {
      fail(`packs/${id}.json count differs from packs/index.json — run: node tools/image/build-pack-index.js`);
    }
  }

  let missing = 0;
  for (const name of expected) {
    if (!fs.existsSync(path.join(CHUNKS, name))) {
      if (missing < 3) fail(`common pack references a missing chunk: ${name}`);
      missing++;
    }
  }
  if (missing > 3) fail(`... and ${missing - 3} more missing chunks in packs/common.json`);
  if (!missing) notes.push(`all ${expected.length} common chunks present`);

  // ---- per-tool sets: packs/<buildId>/tools.json -------------------------
  // The page uses these for the per-tool progress bar. A missing or stale file
  // means the bar silently never appears, so check it against the build id.
  const TOOLS = path.join(ROOT, "packs", "tools.json");
  if (!fs.existsSync(TOOLS)) {
    fail("packs/tools.json is missing — run: node tools/image/build-tool-sets.js");
  } else {
    let tools = null;
    try { tools = JSON.parse(fs.readFileSync(TOOLS, "utf8")); } catch (e) {
      fail("packs/tools.json is not valid JSON");
    }
    if (tools) {
      const ids = Object.keys(tools);
      if (!ids.length) fail("packs/tools.json defines no tools");
      let badChunk = null;
      for (const id of ids) {
        const t = tools[id];
        if (!t || !Array.isArray(t.chunks) || !t.chunks.length) {
          fail(`packs/tools.json entry '${id}' has no chunks`);
          continue;
        }
        for (const c of t.chunks) {
          if (!fs.existsSync(path.join(CHUNKS, c))) {
            badChunk = badChunk || `${id}: ${c}`;
            break;
          }
        }
      }
      if (badChunk) {
        fail(`packs/tools.json references a missing chunk (${badChunk}) — ` +
          "re-record with node tools/image/build-tool-sets.js");
      } else {
        notes.push(`tool sets ok (${ids.length} tools: ${ids.join(", ")})`);
      }
    }
  }
}

// ---- build id must match the files it fingerprints ---------------------
// A stale build id means users keep restoring states taken against a different
// disk/snapshot, which is exactly the stale-data bug this guards against.
try {
  const { execFileSync } = require("node:child_process");
  const out = execFileSync(process.execPath,
    [path.join(ROOT, "tools", "image", "build-id.js"), "--check"],
    { encoding: "utf8" });
  notes.push(out.trim());
} catch (e) {
  fail("images/build-id.json is stale — run: node tools/image/build-id.js");
}

// ---- one cache version, in packs-config.js only -------------------------
// --config lets a deploy check the STAGED copy (build-pages.sh stamps the copy
// under .deploy-pages/, not the source tree, so the source still has GL_BUILD_ID
// = "" for local dev).
const configArg = process.argv.indexOf("--config");
const configPath = configArg > 0
  ? path.resolve(process.argv[configArg + 1])
  : path.join(ROOT, "packs-config.js");
if (!fs.existsSync(configPath)) {
  fail("packs-config.js is missing");
} else {
  const config = fs.readFileSync(configPath, "utf8");
  const m = config.match(/const GL_VERSION\s*=\s*"([^"]+)"/);
  if (!m) {
    fail("packs-config.js has no GL_VERSION");
  } else {
    notes.push(`cache version ${m[1]} (single source: packs-config.js)`);
  }

  // ---- --deploy: a production build MUST be build-id versioned ----------
  // Local dev runs with GL_BUILD_ID = "" and flat paths on purpose. A deploy
  // must never do that, or `immutable` chunk URLs silently change bytes.
  if (process.argv.includes("--deploy")) {
    const b = config.match(/^const GL_BUILD_ID\s*=\s*"([^"]*)";/m);
    if (!b) {
      fail("packs-config.js has no GL_BUILD_ID line (deploy requires one)");
    } else if (!b[1]) {
      fail("GL_BUILD_ID is empty — refusing a deploy with flat, unversioned " +
        "chunk paths. Run tools/deploy/build-pages.sh, which stamps it.");
    } else if (/[^0-9a-f]/.test(b[1])) {
      fail(`GL_BUILD_ID is not lowercase hex: '${b[1]}'`);
    } else {
      // It must match the artifacts it names (unless explicit rollback override).
      if (!process.argv.includes("--allow-override-id")) {
        try {
          const recorded = JSON.parse(fs.readFileSync(
            path.join(ROOT, "images", "build-id.json"), "utf8")).buildId;
          if (recorded !== b[1]) {
            fail(`GL_BUILD_ID (${b[1]}) does not match images/build-id.json ` +
              `(${recorded}); chunks would 404. Re-stamp the build id.`);
          } else {
            notes.push(`deploy build id ${b[1]} matches artifacts`);
          }
        } catch (e) {
          fail("images/build-id.json is unreadable; cannot verify GL_BUILD_ID");
        }
      } else {
        notes.push(`deploy build id ${b[1]} (explicit override)`);
      }
    }

    // The asset origin is what every chunk fetch is proxied to. A blank or
    // wrong value ships a deploy whose disk cannot load, so pin it exactly.
    const REQUIRED_ASSET_ORIGIN = "https://assets.golinux.app";
    const a = config.match(/^const GL_ASSET_ORIGIN\s*=\s*"([^"]*)";/m);
    if (!a) {
      fail("packs-config.js has no GL_ASSET_ORIGIN line (deploy requires it)");
    } else if (a[1] !== REQUIRED_ASSET_ORIGIN) {
      fail(`GL_ASSET_ORIGIN is '${a[1]}' in the staged config; a deploy must ` +
        `be exactly '${REQUIRED_ASSET_ORIGIN}'. Local ?assets= overrides must ` +
        `not leak into the build.`);
    } else {
      notes.push(`deploy asset origin ${a[1]}`);
    }
  }
}

// Catch a cache name hardcoded somewhere else, which would silently drift.
for (const f of ["index.html", "terminal.html", "sw.js", "persist.js", "packs.js"]) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, "utf8");
  if (/golinux-(shell|data|pack)-v\d/.test(src)) {
    fail(`${f} hardcodes a cache name; use GL_SHELL_CACHE / GL_DATA_CACHE / ` +
      `GL_PACK_CACHE from packs-config.js`);
  }
}

// chunks-precache.json must match images/debian-chunks/manifest.json["real"].
const PRECACHE = path.join(ROOT, "chunks-precache.json");
const CHUNK_MANIFEST = path.join(CHUNKS, "manifest.json");
if (!fs.existsSync(PRECACHE)) {
  fail("chunks-precache.json is missing — run: node tools/image/build-chunk-manifest.js");
} else if (fs.existsSync(CHUNK_MANIFEST)) {
  const pre = JSON.parse(fs.readFileSync(PRECACHE, "utf8"));
  const man = JSON.parse(fs.readFileSync(CHUNK_MANIFEST, "utf8")).real || [];
  if (pre.length !== man.length || pre.some((v, i) => v !== man[i])) {
    fail("chunks-precache.json does not match images/debian-chunks/manifest.json — " +
      "run: node tools/image/build-chunk-manifest.js");
  } else {
    notes.push(`chunks-precache.json matches manifest (${pre.length} chunks)`);
  }
}

// public/_headers must detach Cache-Control with "! Cache-Control" before any narrow override.
const HEADERS = path.join(ROOT, "public", "_headers");
if (fs.existsSync(HEADERS)) {
  const lines = fs.readFileSync(HEADERS, "utf8").split(/\r?\n/);
  let currentPath = null;
  let detached = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      currentPath = trimmed;
      detached = false;
      continue;
    }
    if (/^!\s*cache-control\b/i.test(trimmed)) detached = true;
    else if (/^cache-control\s*:/i.test(trimmed) && currentPath && currentPath !== "/*" && !detached) {
      fail(`public/_headers:${i + 1} sets Cache-Control under ${currentPath} without '! Cache-Control' detach`);
    }
  }
}

// tools/image/install.sh must not regress TERM=vt102.
const INSTALL_SH = path.join(ROOT, "tools", "image", "install.sh");
if (fs.existsSync(INSTALL_SH)) {
  const src = fs.readFileSync(INSTALL_SH, "utf8");
  if (/export TERM=vt102/.test(src)) {
    fail("tools/image/install.sh still exports TERM=vt102 (overrides xterm-256color)");
  }
}

// No runtime file outside keybar/tools may call serial0_send (INV-1).
const RUNTIME_CHECK = [
  "index.html", "terminal.html", "worker.js", "sw.js", "persist.js", "persist-9p.js", "packs.js",
  "js/landing.js", "js/main.js", "js/status.js", "js/boot.js", "js/terminal.js",
  "js/persist-ui.js", "js/packs-ui.js", "js/transfer.js", "js/tool-progress.js",
];
for (const rel of RUNTIME_CHECK) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, "utf8");
  if (/\bserial0_send\s*\(/.test(src)) {
    fail(`${rel} calls serial0_send() — violates INV-1 (no synthetic guest stdin)`);
  }
}

if (problems.length) {
  console.error("\nMANIFEST CHECK FAILED:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}

console.log("manifest check ok: " + notes.join("; "));
