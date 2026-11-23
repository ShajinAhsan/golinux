#!/usr/bin/env node
// Boot the Debian disk image headlessly in Node, prepare the guest for a small
// state image, wait for the shell prompt, and save the machine state.
//
// Why the preparation matters (measured, see tools/image/profile-state.js):
//   v86's save_state() -> CPU.get_state() -> pack_memory() keeps every 4 KiB
//   page that is not entirely zero. Linux leaves freed pages with stale
//   contents, so before preparation ~50% of the 256 MiB guest RAM was
//   non-zero (130 MiB), even though the guest only used ~21 MiB. That was the
//   single largest compressed cost in the snapshot.
//
//   Zeroing free RAM (write zeros through a tmpfs, delete, sync) plus the
//   kernel's init_on_free/init_on_alloc, plus drop_caches, brings non-zero RAM
//   down to ~35 MiB raw / ~9.6 MiB compressed.
//
//   The 74.7 MiB "dev.ide" component is v86's 256-byte write-back block cache
//   (the disk itself is served from read-only chunks). It is mostly zeros and
//   compresses to ~0.04 MiB, so it is left alone.
//
// Usage: node tools/image/save-state.js [memory_mb] [out_file]
'use strict';

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const { V86 } = require(path.join(ROOT, "assets/v86/libv86.js"));

const MEM_MB = Number(process.argv[2] || 256);
const OUT = process.argv[3] || path.join(ROOT, "images/debian-state.bin");
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS || 180000);

// Pseudo-RAM to fill with zeros. Must exceed free RAM, not total RAM.
const FILL_MB = Number(process.env.FILL_MB || 230);

// Kernel-side zeroing of freed and freshly allocated pages. This is the
// cheapest part of the win and needs no tmpfs churn.
const CMDLINE_EXTRA = "init_on_free=1 init_on_alloc=1";

// Services not needed for an interactive shell. Stopping them removes their
// resident memory and their cached pages from the state.
const STOP_SERVICES = "rsyslog cron ssh atd";

// Runs once, before the snapshot is taken, so it is part of the saved machine.
// Loads the 9p modules (they are built as modules in this kernel) and mounts
// the host share that upload/download use.
const SETUP_9P = [
  "modprobe 9p 2>/dev/null || true",
  "modprobe 9pnet 2>/dev/null || true",
  "modprobe 9pnet_virtio 2>/dev/null || true",
  "mkdir -p /mnt/host",
  "grep -q ' /mnt/host ' /etc/fstab || echo 'host9p /mnt/host 9p trans=virtio,version=9p2000.L,rw,noauto 0 0' >> /etc/fstab",
  "mountpoint -q /mnt/host || mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/host || true",
].join("; ");

// motd is written with printf so it works as a single-line command: a heredoc
// inside a one-line script never terminates (the terminator must be on its own
// line, which the serial console cannot provide here).
const MOTD_LINES = [
  "",
  "  GoLinux - Debian 12 (bookworm) i386, running in your browser.",
  "",
  "  Installed: bash, coreutils, util-linux, git, gcc/g++, make,",
  "             man-db + manpages, nano (the editor), curl, procps.",
  "",
  "  Networking is OFF. There is no internet access in this machine.",
  "",
  "  Your files are saved in this browser, not on a server. They survive a",
  "  reload and a closed tab. Use Upload/Download in the toolbar to move",
  "  files in and out, and Reset to start over with an empty machine.",
  "",
  "  Uploaded files appear in /mnt/host. That folder is TEMPORARY: it is not",
  "  saved, so copy anything you want to keep into /root, for example",
  "      cp /mnt/host/file.txt /root/",
  "  Files under /root are included in Download /root as zip.",
  "",
  "  First use of a program takes a while to load; later uses are fast.",
  "",
];
const MOTD = "printf '%s\\n' " +
  MOTD_LINES.map(l => "'" + l.replace(/'/g, "'\\''") + "'").join(" ") +
  " > /etc/motd";

const PREP = [
  `for s in ${STOP_SERVICES}; do service $s stop 2>/dev/null || true; done`,
  // Zero free RAM. /dev/shm is only ~45 MB here, so mount a big enough tmpfs.
  "mkdir -p /mnt/zf",
  `mount -t tmpfs -o size=${FILL_MB}M tmpfs /mnt/zf`,
  "dd if=/dev/zero of=/mnt/zf/fill bs=1M 2>/dev/null || true",
  "sync",
  "rm -f /mnt/zf/fill",
  "sync",
  "umount /mnt/zf",
  // Drop page cache last, so cached file data does not re-dirty the pages.
  // Commit filesystem metadata to the block layer BEFORE dropping caches.
  // The disk is served from read-only chunks, so the guest's writes live in
  // v86's IDE write-back cache. A bare `sync` only flushes kernel dirty pages;
  // the motd/fstab/mount changes were landing in RAM and never reaching the
  // device. syncfs + a short settle makes them part of the snapshot.
  "syncfs / 2>/dev/null || sync",
  "sync",
  "sleep 1",
  "echo 3 > /proc/sys/vm/drop_caches",
].join("; ");

const serial = { text: "" };
let phase = 0;

const emulator = new V86({
  wasm_path: path.join(ROOT, "assets/v86/v86.wasm"),
  bios: { url: path.join(ROOT, "assets/bios/seabios.bin") },
  vga_bios: { url: path.join(ROOT, "assets/bios/vgabios.bin") },

  bzimage: { url: path.join(ROOT, "images/debian-bzImage") },
  initrd: { url: path.join(ROOT, "images/debian-initrd") },

  // Use the raw image, not the zstd chunks: decompressing chunks needs a Web
  // Worker, which Node does not provide. The repo's own build-state-raw-disk.js
  // does the same. The disk image and chunking are unchanged.
  hda: {
    url: path.join(ROOT, "images/debian.img"),
    async: true,
    size: 5 * 1024 * 1024 * 1024,
  },

  // The 9p filesystem backs upload/download. It must be present when the
  // state is captured, because restore_state() restores device state too.
  filesystem: {},

  cmdline: `root=/dev/sda rw console=ttyS0 ${CMDLINE_EXTRA}`,
  // vga_memory_size is a documented v86 option (v86.d.ts). Lowering it shrank
  // the raw state by ~7 MiB but the compressed size got slightly worse, so it
  // is left at the default.
  memory_size: MEM_MB * 1024 * 1024,
  autostart: true,
});

const started = Date.now();

emulator.add_listener("serial0-output-byte", byte => {
  const c = String.fromCharCode(byte);
  serial.text += c;
  process.stdout.write(c);

  if (phase === 0 && /root@golinux:~#/.test(serial.text)) {
    phase = 1;
    const bootSecs = (Date.now() - started) / 1000;
    console.error(`\n\n[snapshot] shell prompt after ${bootSecs.toFixed(1)}s at ${MEM_MB} MB`);
    // Quiet the console first: dmesg output would itself allocate buffers.
    // Verify the writes actually reached the block device; do not save a
    // snapshot whose /etc/motd or 9p mount silently did not take.
    const verify = [
      "grep -q 'GoLinux' /etc/motd || echo 'MOTD_WRITE_FAILED'",
      "mountpoint -q /mnt/host || echo 'MOUNT_FAILED'",
      "echo PREP_VERIFIED",
    ].join("; ");
    emulator.serial0_send(`dmesg -n 1; ${SETUP_9P}; ${MOTD}; ${PREP}; ${verify}\n`);
    return;
  }

  // The marker appears once in the echoed command line and once in real output.
  // Require the marker twice: once is the echoed command line, twice is real
  // output. Matching once fired immediately on every run.
  const appeared = m => serial.text.split(m).length - 1 >= 2;
  if (phase === 1 && appeared("MOTD_WRITE_FAILED")) {
    console.error("[snapshot] ERROR: /etc/motd was not written");
    emulator.stop(); process.exit(1);
  }
  if (phase === 1 && appeared("MOUNT_FAILED")) {
    console.error("[snapshot] ERROR: /mnt/host was not mounted");
    emulator.stop(); process.exit(1);
  }

  if (phase === 1 && serial.text.split("PREP_VERIFIED").length - 1 >= 2) {
    phase = 2;
    setTimeout(async () => {
      const state = await emulator.save_state();
      fs.writeFileSync(OUT, new Uint8Array(state));
      console.error(`[snapshot] wrote ${OUT} (${(state.byteLength / 1048576).toFixed(1)} MiB raw)`);
      emulator.stop();
      process.exit(0);
    }, 4000);
  }
});

setTimeout(() => {
  console.error(`\n[snapshot] TIMEOUT after ${BOOT_TIMEOUT_MS}ms — phase ${phase}`);
  console.error("[snapshot] last output: " + JSON.stringify(serial.text.slice(-400)));
  process.exit(1);
}, BOOT_TIMEOUT_MS);
