#!/usr/bin/env node
// Boot the Alpine 3.21 x86 disk image headlessly in Node at 128 MB RAM,
// verify virtio-console (/dev/hvc0, TERM=xterm-256color, colored prompt,
// __gl_prompt_sp), /mnt/host (9p), tcc, and fastfetch, zero free RAM,
// pre-warm BusyBox + tcc + fastfetch + sl + cowsay into page cache for
// instant mobile execution, and save the compressed machine state.
//
// Usage: node tools/image/save-state.js [memory_mb] [out_file]
'use strict';

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const { V86 } = require(path.join(ROOT, "assets/v86/libv86.js"));

const MEM_MB = Number(process.argv[2] || 128);
const OUT = process.argv[3] || path.join(ROOT, "images/debian-state.bin");
const BOOT_TIMEOUT_MS = Number(process.env.BOOT_TIMEOUT_MS || 120000);
const FILL_MB = Number(process.env.FILL_MB || Math.max(64, MEM_MB - 24));
const DISK_BYTES = fs.statSync(path.join(ROOT, "images/debian.img")).size;
const CMDLINE_EXTRA = "init_on_free=1 init_on_alloc=1";

const MOTD_LINES = [
  "",
  "  GoLinux - Alpine Linux 3.21 (x86), running in your browser.",
  "",
  "  Tools: BusyBox, bash, tcc/cc (instant C), python3, git, make,",
  "         nano, vi, htop, tmux, jq, tree, man, fastfetch, cowsay, figlet, sl.",
  "",
  "  Networking is OFF by default. Toggle 'Net' in the toolbar for safe browser Fetch.",
  "  Run 'nethelp' for examples. Your files in /root auto-save locally in this browser.",
  "",
];
const MOTD = "printf '%s\\n' " +
  MOTD_LINES.map((l) => "'" + l.replace(/'/g, "'\\''") + "'").join(" ") +
  " > /etc/motd";

// Zero free RAM, drop boot junk from page cache, then pre-warm ONLY the tiny
// everyday binaries (~1.5 MB raw -> ~500 KB compressed in snapshot) so ls,
// clear, grep, fastfetch, sl, cowsay, and tcc run with ZERO cold fetches even
// on slow mobile connections!
const PREP = [
  "mkdir -p /mnt/zf",
  `mount -t tmpfs -o size=${FILL_MB}M tmpfs /mnt/zf`,
  "dd if=/dev/zero of=/mnt/zf/fill bs=1M 2>/dev/null || true",
  "sync",
  "rm -f /mnt/zf/fill",
  "sync",
  "umount /mnt/zf",
  "rmdir /mnt/zf 2>/dev/null || true",
  "sync",
  "echo 3 > /proc/sys/vm/drop_caches",
  // Pre-warm instant core binaries in page cache
  "cat /bin/busybox /usr/local/bin/tcc /usr/local/bin/cowsay /usr/local/bin/clear /usr/bin/sl /bin/lsblk >/dev/null 2>&1 || true",
].join("; ");

const serial = { text: "" };
const hvc = { text: "" };
let phase = 0; // 0=booting -> 1=verifying & prepping -> 2=saving

const emulator = new V86({
  wasm_path: path.join(ROOT, "assets/v86/v86.wasm"),
  bios: { url: path.join(ROOT, "assets/bios/seabios.bin") },
  vga_bios: { url: path.join(ROOT, "assets/bios/vgabios.bin") },
  bzimage: { url: path.join(ROOT, "images/debian-bzImage") },
  initrd: { url: path.join(ROOT, "images/debian-initrd") },
  hda: {
    url: path.join(ROOT, "images/debian.img"),
    async: true,
    size: DISK_BYTES,
  },
  filesystem: {},
  virtio_console: true,
  net_device: { type: "virtio" },
  preserve_mac_from_state_image: true,
  cmdline: `root=/dev/sda rootfstype=ext4 modules=sd-mod,ext4 rw console=ttyS0 ${CMDLINE_EXTRA}`,
  memory_size: MEM_MB * 1024 * 1024,
  autostart: true,
});

const started = Date.now();
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");

function maybeStartPrep() {
  if (phase !== 0) return;
  if (!/root@golinux:~#\s*$/.test(stripAnsi(serial.text))) return;
  if (!/root@golinux:~#\s*$/.test(stripAnsi(hvc.text))) return;
  if (!hvc.text.includes("\x1b[1;32mroot@golinux")) {
    console.error("[snapshot] ERROR: hvc0 prompt missing ANSI colors: " + JSON.stringify(hvc.text.slice(-120)));
    emulator.stop(); process.exit(1);
  }
  phase = 1;
  const bootSecs = (Date.now() - started) / 1000;
  console.error(`\n[snapshot] Alpine ttyS0 + hvc0 ready after ${bootSecs.toFixed(1)}s at ${MEM_MB} MB; verifying & prepping RAM`);
  const verify = [
    MOTD,
    "grep -q 'GoLinux' /etc/motd || echo 'MOTD_WRITE_FAILED'",
    "mountpoint -q /mnt/host || echo 'MOUNT_FAILED'",
    "HVC_PID=$(for p in /proc/[0-9]*; do [ -r $p/comm ] && [ \"$(cat $p/comm)\" = bash ] && [ \"$(readlink $p/fd/0 2>/dev/null)\" = /dev/hvc0 ] && basename $p && break; done)",
    "[ -n \"$HVC_PID\" ] && tr '\\0' '\\n' < /proc/$HVC_PID/environ | grep -qx 'TERM=xterm-256color' || echo 'HVC_TERM_FAILED'",
    "grep -q '__gl_prompt_sp' /root/.bashrc && grep -q 'ls --color=auto' /root/.bashrc || echo 'BASHRC_FAILED'",
    "tcc -v >/dev/null 2>&1 || echo 'TCC_FAILED'",
    "fastfetch >/dev/null 2>&1 || echo 'FASTFETCH_FAILED'",
    "ip -4 addr show dev eth0 | grep -q '192.168.86.100/24' || echo 'ETH0_FAILED'",
    "ip -4 addr show dev lo | grep -q '127.0.0.1/8' || echo 'LO_FAILED'",
    PREP,
    "echo PREP_VERIFIED",
  ].join("; ");
  emulator.serial0_send(verify + "\n");
}

emulator.add_listener("virtio-console0-output-bytes", (bytes) => {
  hvc.text += Buffer.from(bytes).toString("utf8");
  maybeStartPrep();
});

emulator.add_listener("serial0-output-byte", (byte) => {
  const c = String.fromCharCode(byte);
  serial.text += c;
  process.stdout.write(c);
  maybeStartPrep();

  const appeared = (m) => serial.text.split(m).length - 1 >= 2;
  for (const [marker, msg] of [
    ["MOTD_WRITE_FAILED", "/etc/motd was not written"],
    ["MOUNT_FAILED", "/mnt/host 9p mount failed"],
    ["HVC_TERM_FAILED", "hvc0 bash does not have TERM=xterm-256color"],
    ["BASHRC_FAILED", "/root/.bashrc missing __gl_prompt_sp / ls --color=auto"],
    ["TCC_FAILED", "tcc failed to run"],
    ["FASTFETCH_FAILED", "fastfetch failed to run"],
    ["ETH0_FAILED", "eth0 virtio-net did not configure 192.168.86.100/24"],
    ["LO_FAILED", "lo loopback interface is not up"],
  ]) {
    if (phase === 1 && appeared(marker)) {
      console.error("[snapshot] ERROR: " + msg);
      emulator.stop(); process.exit(1);
    }
  }

  if (phase === 1 && appeared("PREP_VERIFIED")) {
    phase = 2;
    setTimeout(async () => {
      const state = await emulator.save_state();
      fs.writeFileSync(OUT, new Uint8Array(state));
      console.error(`[snapshot] wrote ${OUT} (${(state.byteLength / 1048576).toFixed(1)} MiB raw)`);
      emulator.stop();
      process.exit(0);
    }, 2000);
  }
});

setTimeout(() => {
  console.error(`\n[snapshot] TIMEOUT after ${BOOT_TIMEOUT_MS}ms — phase ${phase}`);
  console.error("[snapshot] last serial: " + JSON.stringify(serial.text.slice(-300)));
  console.error("[snapshot] last hvc0:   " + JSON.stringify(hvc.text.slice(-300)));
  process.exit(1);
}, BOOT_TIMEOUT_MS);
