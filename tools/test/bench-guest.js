#!/usr/bin/env node
/**
 * Guest & Snapshot Benchmark Harness (Node + v86).
 *
 * Restores images/debian-state.bin.zst headlessly, reports compressed & raw
 * snapshot composition, boots to prompt, and times:
 *   1. Syscall loop (1,000 shell stat/test iterations)
 *   2. Cold TinyCC C compile & run
 *   3. Python 3 startup + stdlib import
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const { V86 } = require(path.join(ROOT, "assets/v86/libv86.js"));

const SNAP_ZST = path.join(ROOT, "images/debian-state.bin.zst");
const DISK_IMG = path.join(ROOT, "images/debian.img");

function readConfigNums() {
  const src = fs.readFileSync(path.join(ROOT, "packs-config.js"), "utf8");
  const evalFn = new Function(src + "\nreturn { GL_MEMORY_SIZE, GL_VGA_MEMORY_SIZE };");
  return evalFn();
}

function summarizeSnapshot() {
  const zstBytes = fs.statSync(SNAP_ZST).size;
  const raw = execFileSync("zstd", ["-d", "-c", SNAP_ZST], { maxBuffer: 128 * 1024 * 1024 });
  const h = new Int32Array(raw.buffer, raw.byteOffset, 4);
  const infoLen = h[3];
  const info = JSON.parse(raw.subarray(16, 16 + infoLen).toString("utf8"));
  const memInfo = info.state[77] && info.buffer_infos[info.state[77].buffer_id];
  const ideArr = info.state[85] && info.state[85][0] && info.state[85][0][28] && info.state[85][0][28][0];
  console.log("=== Snapshot Profile ===");
  console.log(`  Compressed : ${(zstBytes / 1048576).toFixed(2)} MiB (${zstBytes} bytes)`);
  console.log(`  Raw        : ${(raw.length / 1048576).toFixed(2)} MiB (info JSON ${(infoLen / 1048576).toFixed(2)} MiB)`);
  console.log(`  Guest RAM  : ${memInfo ? (memInfo.length / 1048576).toFixed(2) : "?"} MiB non-zero pages`);
  console.log(`  IDE cache  : ${Array.isArray(ideArr) ? ideArr.length : 0} written buffers`);
  return raw;
}

async function runGuestBench() {
  const cfg = readConfigNums();
  const stateBuf = summarizeSnapshot();
  const diskBytes = fs.statSync(DISK_IMG).size;

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const emu = new V86({
      wasm_path: path.join(ROOT, "assets/v86/v86.wasm"),
      bios: { url: path.join(ROOT, "assets/bios/seabios.bin") },
      vga_bios: { url: path.join(ROOT, "assets/bios/vgabios.bin") },
      vga_memory_size: cfg.GL_VGA_MEMORY_SIZE || (8 * 1024 * 1024),
      hda: { url: DISK_IMG, async: true, size: diskBytes },
      filesystem: {},
      virtio_console: true,
      net_device: { type: "virtio" },
      preserve_mac_from_state_image: true,
      memory_size: cfg.GL_MEMORY_SIZE || (128 * 1024 * 1024),
      initial_state: {
        buffer: stateBuf.buffer.slice(stateBuf.byteOffset, stateBuf.byteOffset + stateBuf.byteLength),
      },
      autostart: true,
    });

    let out = "";
    let stage = 0;
    let tStage = 0;
    const results = {};

    const count = (needle) => out.split(needle).length - 1;

    emu.add_listener("virtio-console0-output-bytes", (bytes) => {
      out += Buffer.from(bytes).toString("utf8");
      if (out.length > 300000) out = out.slice(-150000);

      if (stage === 1 && count("B_SYS_DONE") >= 2) {
        results.syscallMs = Date.now() - tStage;
        stage = 2;
        tStage = Date.now();
        emu.bus.send("virtio-console0-input-bytes", Buffer.from(
          "printf '#include <stdio.h>\\nint main(){puts(\"ok\");return 0;}\\n' > /tmp/b.c && tcc /tmp/b.c -o /tmp/b && /tmp/b && echo B_TCC_DONE\n"
        ));
      } else if (stage === 2 && count("B_TCC_DONE") >= 2) {
        results.tccMs = Date.now() - tStage;
        stage = 3;
        tStage = Date.now();
        emu.bus.send("virtio-console0-input-bytes", Buffer.from(
          "python3 -c 'import json, math, os; print(json.dumps([math.pi]))' && echo B_PY_DONE\n"
        ));
      } else if (stage === 3 && count("B_PY_DONE") >= 2) {
        results.pythonMs = Date.now() - tStage;
        clearTimeout(timeout);
        try { emu.stop(); } catch (_) {}
        resolve(results);
      }
    });

    emu.add_listener("emulator-loaded", () => {
      results.restoreMs = Date.now() - t0;
      setTimeout(() => {
        stage = 1;
        tStage = Date.now();
        emu.bus.send("virtio-console0-input-bytes", Buffer.from(
          "i=0; while [ $i -lt 500 ]; do [ -e /bin/busybox ]; i=$((i+1)); done; echo B_SYS_DONE\n"
        ));
      }, 400);
    });

    const timeout = setTimeout(() => {
      try { emu.stop(); } catch (_) {}
      reject(new Error(`bench timeout in stage ${stage}`));
    }, 90000);
  });
}

runGuestBench()
  .then((res) => {
    console.log("=== Guest Performance ===");
    console.log(`  Snapshot restore : ${res.restoreMs} ms`);
    console.log(`  500 stat loop    : ${res.syscallMs} ms`);
    console.log(`  Cold tcc compile : ${res.tccMs} ms`);
    console.log(`  Cold python3 run : ${res.pythonMs} ms`);
    process.exit(0);
  })
  .catch((e) => {
    console.error("Benchmark failed:", e.message);
    process.exit(1);
  });
