#!/usr/bin/env node
// Record which disk chunks are read while running a set of tools, and write
// the resulting chunk list as a pack.
//
//   node tools/image/build-packs.js common
//   node tools/image/build-packs.js full
//
// Chunks are recorded by wrapping the raw image buffer: v86's `get`/`get_and_cache`
// calls tell us exactly which byte ranges the guest reads, which we map to the
// 128 KiB chunk filenames. Nothing is guessed from package dependencies.
'use strict';

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const { V86 } = require(path.join(ROOT, "assets/v86/libv86.js"));

const CHUNK_SIZE = 128 * 1024;
const DISK_BYTES = 5 * 1024 * 1024 * 1024;
const MODE = process.argv[2] || "common";

// The tools whose read footprint makes up the "common" pack.
//
// `--version` alone is not enough: it only loads the driver binary. A real
// compilation pulls in cc1, cc1plus, as, ld and the runtime libraries, which
// live in different chunks. Both are included so the pack actually compiles.
const COMMON_COMMANDS = [
  "ls -la /bin /usr/bin /etc >/dev/null",
  "nano --version >/dev/null",
  "git --version >/dev/null",
  "git status >/dev/null 2>&1 || true",
  "gcc --version >/dev/null",
  "g++ --version >/dev/null",
  "make --version >/dev/null",

  // Real compile: driver, cc1, cc1plus, as, ld, crt objects, libc, libstdc++.
  "printf 'int main(){return 0;}' > /tmp/p.c",
  "printf '#include <vector>\\nint main(){std::vector<int> v; v.push_back(1); return (int)v.size()-1;}' > /tmp/p.cpp",
  "gcc -O0 -o /tmp/pc /tmp/p.c",
  "g++ -O0 -o /tmp/pcpp /tmp/p.cpp",
  "/tmp/pc",
  "/tmp/pcpp",

  // A trivial make run, so make's own rule files are touched.
  "printf 'all:\\n\\t@true\\n' > /tmp/Makefile",
  "make -C /tmp all >/dev/null",

  "man ls >/dev/null",
  "man git >/dev/null",
  "man gcc >/dev/null 2>&1 || true",
  "man make >/dev/null",
  "man g++ >/dev/null 2>&1 || true",
  "which ls gcc g++ git make nano man",
  "du -sh /usr >/dev/null",
  "lsblk >/dev/null",
];

const readChunks = new Set();
const chunkName = start => `chunk-${start}-${start + CHUNK_SIZE}.zst`;
const noteRange = (start, len) => {
  const first = Math.floor(start / CHUNK_SIZE) * CHUNK_SIZE;
  const last = Math.floor((start + len - 1) / CHUNK_SIZE) * CHUNK_SIZE;
  for (let off = first; off <= last; off += CHUNK_SIZE) readChunks.add(chunkName(off));
};

/**
 * Wrap the disk image so every READ is recorded, on a private writable clone.
 *
 * The guest genuinely compiles during recording, so writes must land somewhere.
 * They must not land in images/debian.img, and they must not be discarded —
 * silently dropping the guest's writes corrupts its filesystem mid-compile
 * (observed as "EXT4-fs ... error 117" and "ld returned 1 exit status").
 * We copy the image with an APFS clone (instant, no extra disk) and open that
 * copy read-write, so the real image is never touched.
 *
 * Reads go through fd.read, since fs.readFileSync refuses files over 2 GiB.
 */
function wrapRecording(recording) {
  const src = path.join(ROOT, "images/debian.img");
  const copy = path.join(require("node:os").tmpdir(), "golinux-pack-recording.img");

  if (!fs.existsSync(copy)) {
    // -c uses clonefile on APFS: copy-on-write, effectively instant.
    try {
      require("node:child_process").execFileSync("cp", ["-c", src, copy]);
    } catch (e) {
      console.error("[packs] clone failed, falling back to a full copy");
      fs.copyFileSync(src, copy);
    }
  }

  const fd = fs.openSync(copy, "r+");
  const size = fs.fstatSync(fd).size;
  const scratch = Buffer.allocUnsafe(1 << 20);

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
    onload: undefined,
    onprogress: undefined,
    load() { this.onload && this.onload(Object.create(null)); },
    get: readInto,
    get_and_cache: readInto,
    get_from_cache(start, len) {
      if (recording.on) noteRange(start, len);
      const out = new Uint8Array(len);
      fs.readSync(fd, out, 0, len, start);
      return out;
    },
    set(start, data, fn) {
      // Persist to the clone so the guest filesystem stays consistent. Writes
      // are not recorded: they create new data in /tmp, not pack content.
      fs.writeSync(fd, Buffer.from(data.buffer, data.byteOffset, data.byteLength), 0, data.byteLength, start);
      fn();
    },
  };
}

const recording = { on: false };

let text = "";
let phase = 0;

const emulator = new V86({
  wasm_path: path.join(ROOT, "assets/v86/v86.wasm"),
  bios: { url: path.join(ROOT, "assets/bios/seabios.bin") },
  vga_bios: { url: path.join(ROOT, "assets/bios/vgabios.bin") },
  bzimage: { url: path.join(ROOT, "images/debian-bzImage") },
  initrd: { url: path.join(ROOT, "images/debian-initrd") },
  // Real disk bytes, read through a recording wrapper so we see exactly which
  // chunks the tools touch. Boot-time reads happen before recording is enabled.
  hda: wrapRecording(recording),
  cmdline: "root=/dev/sda rw console=ttyS0",
  memory_size: 256 * 1024 * 1024,
  autostart: true,
});

emulator.add_listener("serial0-output-byte", byte => {
  text += String.fromCharCode(byte);

  if (phase === 0 && /root@golinux:~#/.test(text)) {
    phase = 1;
    console.error(`[packs] shell up, starting recording + ${COMMON_COMMANDS.length} commands`);
    recording.on = true;
    const script = COMMON_COMMANDS.join("; ") + "; echo PACK_DONE\n";
    emulator.serial0_send(script);
    return;
  }

  // The marker appears once in the echoed command line and once in real output,
  // so require the second occurrence or we would finish before bash runs it.
  if (phase === 1 && text.split("PACK_DONE").length - 1 >= 2) {
    phase = 2;
    const errs = text.split("\n").filter(l => /error|not found|No such file|Exec format/.test(l));
    if (errs.length) console.error("[packs] guest reported:\n  " + errs.slice(0, 10).join("\n  "));
    finish();
  }
});

function finish() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "images/debian-chunks/manifest.json"), "utf8"));
  const real = new Set(manifest.real);

  // Only chunks that actually exist with data are downloadable.
  const recorded = [...readChunks].filter(c => real.has(c)).sort();

  console.error(`[packs] touched ${readChunks.size} chunks, ${recorded.length} contain data`);

  const outDir = path.join(ROOT, "packs");
  fs.mkdirSync(outDir, { recursive: true });

  let list;
  let name;
  if (MODE === "full") {
    list = manifest.real.slice().sort();
    name = "full.json";
    const destFull = path.join(outDir, "full.json");
    fs.writeFileSync(destFull, JSON.stringify(list));
    const b = list.reduce((sum, c) =>
      sum + fs.statSync(path.join(ROOT, "images/debian-chunks", c)).size, 0);
    console.error(`[packs] wrote packs/full.json: ${list.length} chunks, ${(b / 1048576).toFixed(1)} MB`);
    process.exit(0);
  } else {
    list = recorded;
    name = "common.json";
  }

  const bytes = list.reduce(
    (sum, c) => sum + fs.statSync(path.join(ROOT, "images/debian-chunks", c)).size, 0);

  // Union with any existing list. Reads vary slightly between runs (filesystem
  // allocation and cache state differ per boot), and a pack must not lose a
  // chunk that an earlier run proved is needed. Rebuild from scratch by
  // deleting the file first.
  const dest = path.join(outDir, name);
  if (MODE !== "full" && fs.existsSync(dest)) {
    try {
      const prev = JSON.parse(fs.readFileSync(dest, "utf8"));
      const merged = new Set([...prev, ...list]);
      list = [...merged].sort();
      console.error(`[packs] unioned with previous list (${prev.length} -> ${list.length})`);
    } catch (e) { /* unreadable previous list: ignore */ }
  }

  fs.writeFileSync(dest, JSON.stringify(list));
  console.error(`[packs] wrote packs/${name}: ${list.length} chunks, ${(bytes / 1048576).toFixed(1)} MB`);
  process.exit(0);
}

setTimeout(() => {
  console.error("[packs] timeout, phase=" + phase);
  process.exit(1);
}, 180000);
