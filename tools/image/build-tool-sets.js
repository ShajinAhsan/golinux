#!/usr/bin/env node
// Record which disk chunks each TOOL reads on FIRST USE, and write them as a
// per-tool set: packs/tools.json
//
//   node tools/image/build-tool-sets.js            # record all tools
//   node tools/image/build-tool-sets.js gcc make   # record a subset
//
// WHY ONE COLD BOOT PER TOOL
// --------------------------
// Recording every tool in one boot gave incomplete sets: v86 keeps fetched
// chunks in memory, so a chunk already read while booting (or by an earlier
// tool) is never read again and therefore never recorded. A cold gcc compile
// then needed ~98 chunks that were in no set at all, and the progress bar
// stalled at ~72%.
//
// So each tool gets a FRESH emulator restored from images/debian-state.bin.zst
// - the exact snapshot production boots from. Every tool therefore starts from
// the same guest state, sees an equally cold chunk cache, and its set is
// measured under production conditions.
//
// Sets overlap on purpose (libc, ld, shared libs). That is correct: a chunk
// needed by both gcc and git belongs in both sets.
'use strict';

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const { V86 } = require(path.join(ROOT, "assets/v86/libv86.js"));

const CHUNK_SIZE = 128 * 1024;
const OUT = path.join(ROOT, "packs", "tools.json");
const SNAPSHOT_ZST = path.join(ROOT, "images", "debian-state.bin.zst");
const MEMORY_SIZE = 256 * 1024 * 1024;   // must match the snapshot

// First-use commands per tool: what a beginner actually runs the first time.
const TOOLS = {
  "ls": ["ls -la /bin /usr/bin /etc >/dev/null"],
  "nano": ["nano --version >/dev/null"],
  "vim": ["vim --version >/dev/null"],
  "tree": ["tree -L 1 / >/dev/null"],
  "htop": ["htop --version >/dev/null"],
  "jq": ["printf '{\"ok\":true}\\n' | jq .ok >/dev/null"],
  "file": ["file /bin/ls >/dev/null"],
  "bc": ["echo '2+2' | bc >/dev/null"],
  "zip": ["zip -v >/dev/null", "unzip -v >/dev/null"],
  "fastfetch": ["fastfetch >/dev/null"],
  "cowsay": ["cowsay hi >/dev/null"],
  "figlet": ["figlet hi >/dev/null"],
  "sl": ["which sl >/dev/null"],
  "neofetch": ["neofetch --stdout >/dev/null"],
  "tmux": ["tmux -V >/dev/null"],
  "git": ["git --version >/dev/null", "git status >/dev/null 2>&1 || true"],
  "make": [
    "printf 'all:\\n\\t@true\\n' > /tmp/Makefile",
    "make -C /tmp all >/dev/null",
  ],
  "python3": ["python3 -c 'import json, math, os; print(json.dumps([math.pi]))' >/dev/null"],
  "gcc": [
    "printf 'int main(){return 0;}' > /tmp/g.c",
    "gcc -O0 -o /tmp/gc /tmp/g.c",
    "/tmp/gc",
  ],
  "g++": [
    "printf '#include <vector>\\nint main(){std::vector<int> v; return (int)v.size();}' > /tmp/g.cpp",
    "g++ -O0 -o /tmp/gcpp /tmp/g.cpp",
    "/tmp/gcpp",
  ],
  "man": ["man ls >/dev/null", "man git >/dev/null"],
  "curl": ["curl --version >/dev/null"],
};

const wanted = process.argv.slice(2);
const order = (wanted.length ? wanted : Object.keys(TOOLS))
  .filter((t) => Object.prototype.hasOwnProperty.call(TOOLS, t));
if (!order.length) {
  console.error("no known tools selected");
  process.exit(1);
}

/* ---------------- snapshot ---------------- */

const RUN_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "golinux-tools-"));
process.on("exit", () => {
  try { fs.rmSync(RUN_TMP, { recursive: true, force: true }); } catch (e) {}
});

/** Decompress the shipped snapshot fresh for this run (never reuse stale /tmp). */
function snapshotBuffer() {
  const raw = path.join(RUN_TMP, "state.bin");
  execFileSync("zstd", ["-d", "-f", "-q", SNAPSHOT_ZST, "-o", raw]);
  return fs.readFileSync(raw);
}

/* ---------------- recording disk wrapper ---------------- */

const readChunks = new Set();
const recording = { on: false };
const chunkName = (start) => `chunk-${start}-${start + CHUNK_SIZE}.zst`;
const noteRange = (start, len) => {
  const first = Math.floor(start / CHUNK_SIZE) * CHUNK_SIZE;
  const last = Math.floor((start + len - 1) / CHUNK_SIZE) * CHUNK_SIZE;
  for (let off = first; off <= last; off += CHUNK_SIZE) readChunks.add(chunkName(off));
};

/**
 * A private writable clone of the disk, with every read recorded.
 *
 * The guest really compiles, so writes must land somewhere real - dropping them
 * corrupts its filesystem mid-build (seen as EXT4 error 117 and a failed ld).
 * A clone is instant on APFS and leaves images/debian.img untouched.
 * `recording.on` gates reads so only the tool's own window is attributed.
 */
function makeDisk() {
  const src = path.join(ROOT, "images/debian.img");
  const copy = path.join(RUN_TMP, "recording.img");
  if (!fs.existsSync(copy)) {
    try {
      execFileSync("cp", ["-c", src, copy]);
    } catch (e) {
      console.error("[tools] clone failed, falling back to a full copy");
      fs.copyFileSync(src, copy);
    }
  }
  const fd = fs.openSync(copy, "r+");
  const size = fs.fstatSync(fd).size;
  const scratch = Buffer.allocUnsafe(1 << 20);

  // Same write-back block cache shape v86's own disk backend uses (256-byte
  // blocks). restore_state() calls set_state() on the disk, and the guest's
  // writes during a compile live here, so this must exist and be restorable.
  const BLOCK = 256;
  const cache = new Map();
  const cacheWrite = new Set();

  const readInto = (start, len, fn) => {
    if (recording.on) noteRange(start, len);
    const out = new Uint8Array(len);
    let done = 0;
    while (done < len) {
      const take = Math.min(scratch.length, len - done);
      const n = fs.readSync(fd, scratch, 0, take, start + done);
      if (n <= 0) break;
      out.set(scratch.subarray(0, n), done);
      done += n;
    }
    fn(out);
  };

  return {
    byteLength: size,
    load() { this.onload && this.onload(Object.create(null)); },
    get: readInto,
    get_and_cache: readInto,
    get_from_cache(start, len) {
      if (recording.on) noteRange(start, len);
      const out = new Uint8Array(len);
      fs.readSync(fd, out, 0, len, start);
      return out;
    },
    get_buffer(fn) { fn(); },
    set(start, data, fn) {
      const first = start / BLOCK;
      const blocks = data.length / BLOCK;
      for (let i = 0; i < blocks; i++) {
        cache.set(first + i, data.slice(BLOCK * i, BLOCK * (i + 1)));
        cacheWrite.add(first + i);
      }
      fs.writeSync(fd, Buffer.from(data.buffer, data.byteOffset, data.byteLength),
        0, data.byteLength, start);
      fn();
    },
    // Mirrors v86's chunked backend: only WRITTEN blocks are serialised, which
    // is what makes the state small and the restore consistent.
    get_state() {
      const written = [];
      for (const [k, v] of cache) if (cacheWrite.has(k)) written.push([k, v]);
      return [written];
    },
    set_state(state) {
      cache.clear();
      cacheWrite.clear();
      for (const [k, v] of state[0]) {
        cache.set(k, v);
        cacheWrite.add(k);
      }
    },
  };
}

/* ---------------- one cold boot per tool ---------------- */

function recordTool(tool, stateBuffer) {
  return new Promise((resolve) => {
    readChunks.clear();
    recording.on = false;

    let text = "";
    let phase = "settle";    // settle -> run -> done
    let settleTimer = null;
    const count = (needle) => text.split(needle).length - 1;

    const emulator = new V86({
      wasm_path: path.join(ROOT, "assets/v86/v86.wasm"),
      bios: { url: path.join(ROOT, "assets/bios/seabios.bin") },
      vga_bios: { url: path.join(ROOT, "assets/bios/vgabios.bin") },
      hda: makeDisk(),
      filesystem: {},
      virtio_console: true,
      memory_size: MEMORY_SIZE,
      // Restore the exact state production boots from: same guest RAM, same
      // cold page cache, no boot-time chunk reads.
      initial_state: { buffer: stateBuffer.buffer.slice(
        stateBuffer.byteOffset, stateBuffer.byteOffset + stateBuffer.byteLength) },
      autostart: true,
    });

    const finish = () => {
      try { emulator.stop(); } catch (e) {}
      // Preserve FIRST-TOUCH order (critical for optimal streaming bundles!)
      resolve([...readChunks]);
    };

    const timer = setTimeout(() => {
      console.error(`[tools] ${tool}: TIMEOUT in phase ${phase}`);
      finish();
    }, 120000);

    /**
     * A restored snapshot does NOT replay serial output: the prompt was already
     * printed before the state was saved, so there is nothing to wait for.
     * (Verified: a restored emulator emits zero serial bytes.) So settle for a
     * moment while restore finishes, then start the tool.
     */
    emulator.add_listener("emulator-loaded", () => {
      settleTimer = setTimeout(() => {
        if (phase !== "settle") return;
        phase = "run";
        // Record only the tool's own reads, not restore/boot-time reads.
        recording.on = true;
        emulator.serial0_send(TOOLS[tool].join("; ") + "\n");
        emulator.serial0_send(`echo E__${tool}\n`);
      }, 1500);
    });

    emulator.add_listener("serial0-output-byte", (byte) => {
      text += String.fromCharCode(byte);
      if (text.length > 400000) text = text.slice(-200000);
      if (phase === "run" && count(`E__${tool}`) >= 2) {
        phase = "done";
        recording.on = false;
        clearTimeout(timer);
        clearTimeout(settleTimer);
        finish();
      }
    });
  });
}

/* ---------------- main ---------------- */

(async () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "images/debian-chunks/manifest.json"), "utf8"));
  const real = new Set(manifest.real);
  const chunksDir = path.join(ROOT, "images/debian-chunks");

  console.error(`[tools] restoring each tool from ${path.basename(SNAPSHOT_ZST)}`);
  const stateBuffer = snapshotBuffer();

  const out = {};
  for (const tool of order) {
    const recorded = (await recordTool(tool, stateBuffer)).filter((c) => real.has(c));
    const bytes = recorded.reduce((s, c) => {
      const p = path.join(chunksDir, c);
      if (!fs.existsSync(p)) throw new Error(`missing chunk while recording ${tool}: ${c}`);
      return s + fs.statSync(p).size;
    }, 0);
    out[tool] = { title: tool, chunks: recorded, bytes };
    console.error(`[tools] ${tool.padEnd(5)} ${String(recorded.length).padStart(4)} chunks  ` +
      `${(bytes / 1048576).toFixed(1)} MB`);
  }

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(`[tools] wrote ${path.relative(ROOT, OUT)}`);
  process.exit(0);
})();
