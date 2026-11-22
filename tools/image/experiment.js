#!/usr/bin/env node
// Snapshot-size experiment harness.
//
// Boots the image headlessly with a given set of tweaks, optionally runs a
// preparation script in the guest before save_state(), then reports the raw
// state size and the component profile.
//
// Usage: node tools/image/experiment.js <name> [json-options]
//   e.g. node tools/image/experiment.js zero-free-ram '{"prep":"zero"}'
//
// Options (all optional):
//   prep        "none" | "zero" | "drop" | "zero+drop" | "initfree+drop"
//   vga          vga_memory_size in bytes (default 8 MiB)
//   memory       guest RAM in bytes (default 256 MiB)
//   cmdline      extra kernel cmdline tokens
//   waitMs       delay after prep before saving (default 4000)
'use strict';

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const { V86 } = require(path.join(ROOT, "assets/v86/libv86.js"));

const NAME = process.argv[2] || "baseline";
const OPTS = JSON.parse(process.argv[3] || "{}");

const PREP = OPTS.prep || "none";
const MEMORY = OPTS.memory || 256 * 1024 * 1024;
const VGA = OPTS.vga || 8 * 1024 * 1024;
const EXTRA_CMDLINE = OPTS.cmdline || "";
const WAIT_MS = OPTS.waitMs || 4000;

const RAW = path.join(os.tmpdir(), `state-exp-${NAME}.bin`);
const ZST = RAW + ".zst";

// Prep scripts. Each ends with a unique marker so we know it completed.
const PREP_SCRIPTS = {
  none: "",
  // Fill free RAM with zeros, then release it. Linux leaves freed pages with
  // stale contents; v86's pack_memory() keeps every non-zero page, so those
  // stale pages are pure dead weight in the state file.
  // /dev/shm is only ~45 MB here, so mount a tmpfs large enough to cover free
  // RAM and write zeros through it. dd is allowed to hit ENOSPC.
  zero: [
    "mkdir -p /mnt/zf",
    "mount -t tmpfs -o size=220M tmpfs /mnt/zf",
    "dd if=/dev/zero of=/mnt/zf/fill bs=1M 2>/dev/null || true",
    "sync",
    "rm -f /mnt/zf/fill",
    "sync",
    "umount /mnt/zf",
  ].join("; "),
  drop: "sync; echo 3 > /proc/sys/vm/drop_caches",
  // Stop services that are not needed for an interactive shell, then zero.
  "zero+drop+svc": [
    "for s in rsyslog cron ssh atd; do service $s stop 2>/dev/null || true; done",
    "mkdir -p /mnt/zf",
    "mount -t tmpfs -o size=220M tmpfs /mnt/zf",
    "dd if=/dev/zero of=/mnt/zf/fill bs=1M 2>/dev/null || true",
    "sync",
    "rm -f /mnt/zf/fill",
    "sync",
    "umount /mnt/zf",
    "sync; echo 3 > /proc/sys/vm/drop_caches",
  ].join("; "),
  "zero+drop": [
    "mkdir -p /mnt/zf",
    "mount -t tmpfs -o size=220M tmpfs /mnt/zf",
    "dd if=/dev/zero of=/mnt/zf/fill bs=1M 2>/dev/null || true",
    "sync",
    "rm -f /mnt/zf/fill",
    "sync",
    "umount /mnt/zf",
    "sync; echo 3 > /proc/sys/vm/drop_caches",
  ].join("; "),
};

let text = "";
let phase = 0;
const START = Date.now();

const emulator = new V86({
  wasm_path: path.join(ROOT, "assets/v86/v86.wasm"),
  bios: { url: path.join(ROOT, "assets/bios/seabios.bin") },
  vga_bios: { url: path.join(ROOT, "assets/bios/vgabios.bin") },
  bzimage: { url: path.join(ROOT, "images/debian-bzImage") },
  initrd: { url: path.join(ROOT, "images/debian-initrd") },
  hda: { url: path.join(ROOT, "images/debian.img"), async: true, size: 5 * 1024 * 1024 * 1024 },
  cmdline: ("root=/dev/sda rw console=ttyS0 " + EXTRA_CMDLINE).trim(),
  memory_size: MEMORY,
  vga_memory_size: VGA,
  autostart: true,
});

emulator.add_listener("serial0-output-byte", byte => {
  text += String.fromCharCode(byte);

  if (phase === 0 && /root@golinux:~#/.test(text)) {
    phase = 1;
    console.error(`[${NAME}] shell after ${((Date.now() - START) / 1000).toFixed(1)}s`);
    const prep = PREP_SCRIPTS[PREP] || "";
    emulator.serial0_send(`dmesg -n 1; ${prep ? prep + "; " : ""}echo PREP_DONE\n`);
    return;
  }

  // Marker appears once in the echo and once in real output.
  if (phase === 1 && text.split("PREP_DONE").length - 1 >= 2) {
    phase = 2;
    const mem = text.split("\n").filter(l => /MemFree|MemAvailable|^Cached/.test(l)).slice(-3);
    setTimeout(async () => {
      const state = await emulator.save_state();
      fs.writeFileSync(RAW, new Uint8Array(state));
      console.error(`[${NAME}] raw ${(state.byteLength / 1048576).toFixed(1)} MiB`);
      try {
        execFileSync("zstd", ["-19", "-T0", "-f", RAW, "-o", ZST], { stdio: "ignore" });
        const z = fs.statSync(ZST).size;
        console.error(`[${NAME}] ZSTD ${z} bytes (${(z / 1048576).toFixed(2)} MiB)`);
      } catch (e) {
        console.error(`[${NAME}] zstd failed: ${e.message}`);
      }
      console.error(`[${NAME}] RAW_PATH ${RAW}`);
      emulator.stop();
      process.exit(0);
    }, WAIT_MS);
  }
});

setTimeout(() => {
  console.error(`[${NAME}] TIMEOUT phase=${phase}`);
  process.exit(1);
}, 300000);
