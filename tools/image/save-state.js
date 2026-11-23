#!/usr/bin/env node
// Boot the Debian disk image headlessly in Node, prepare the guest for a small
// state image with virtio-console (/dev/hvc0, TERM=xterm-256color) and /mnt/host
// (9p), verify everything took, and save the machine state.
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
const FILL_MB = Number(process.env.FILL_MB || 230);
const CMDLINE_EXTRA = "init_on_free=1 init_on_alloc=1";
const STOP_SERVICES = "rsyslog cron ssh atd";

// Load 9p modules and mount /mnt/host.
const SETUP_9P = [
  "modprobe 9p 2>/dev/null || true",
  "modprobe 9pnet 2>/dev/null || true",
  "modprobe 9pnet_virtio 2>/dev/null || true",
  "mkdir -p /mnt/host",
  "grep -q ' /mnt/host ' /etc/fstab || echo 'host9p /mnt/host 9p trans=virtio,version=9p2000.L,rw,noauto 0 0' >> /etc/fstab",
  "mountpoint -q /mnt/host || mount -t 9p -o trans=virtio,version=9p2000.L host9p /mnt/host || true",
].join("; ");

// Enable virtio_console (/dev/hvc0) with TERM=xterm-256color and vibrant
// LS_COLORS / colored ls & grep / colored PS1 (zero runtime overhead).
const BASH_PROFILE_CMD =
  "printf '%s\\n' " +
  "'export HOME=/root' " +
  "'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games' " +
  "'export LANG=C.UTF-8' " +
  "'[ -f /root/.bashrc ] && . /root/.bashrc' " +
  "'cd /root 2>/dev/null || cd /' " +
  "> /root/.bash_profile";

const BASHRC_CMD =
  "printf '%s\\n' " +
  "'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games' " +
  "'export CLICOLOR=1' " +
  "'export LS_COLORS=\"di=1;34:ln=1;36:ex=1;32:so=1;35:pi=33:bd=1;33:cd=1;33:*.tar=1;31:*.tgz=1;31:*.gz=1;31:*.zip=1;31:*.zst=1;31:*.c=38;5;114:*.h=38;5;110:*.cpp=38;5;114:*.py=38;5;221:*.sh=1;32:*.md=38;5;183:*.json=38;5;215\"' " +
  "'shopt -s checkwinsize' " +
  "'alias ls=\"ls --color=auto\"' " +
  "'alias ll=\"ls -alF --color=auto\"' " +
  "'alias la=\"ls -A --color=auto\"' " +
  "'alias grep=\"grep --color=auto\"' " +
  "'__gl_prompt_sp() { local c=${COLUMNS:-80}; (( c > 1 )) && printf \"\\e[2;7m%%\\e[0m%*s\\r\\e[K\" $((c - 1)) \"\"; }' " +
  "'PROMPT_COMMAND=__gl_prompt_sp' " +
  "'PS1=\"\\[\\e[1;32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\\\$ \"' " +
  "> /root/.bashrc";

// Pure-bash zero-fork fastfetch (reads /proc/* via built-ins only -> <40ms on mobile!)
const FASTFETCH_LINES = [
  "#!/bin/bash",
  "R=$'\\e[0m'; G=$'\\e[1;32m'; C=$'\\e[1;36m'; BL=$'\\e[1;34m'; D=$'\\e[2m'",
  "read -r HOST < /etc/hostname 2>/dev/null || HOST=golinux",
  "read -r _ _ KERN _ < /proc/version 2>/dev/null || KERN=6.1",
  "read -r UP_RAW _ < /proc/uptime 2>/dev/null || UP_RAW=0",
  "UP_SEC=${UP_RAW%%.*}",
  "UP_H=$((UP_SEC / 3600)); UP_M=$(((UP_SEC % 3600) / 60)); UP_S=$((UP_SEC % 60))",
  "if (( UP_H > 0 )); then UP=\"${UP_H}h ${UP_M}m\"; else UP=\"${UP_M}m ${UP_S}s\"; fi",
  "MEM_TOT=256; MEM_AVAIL=180",
  "while read -r k v _; do",
  "  case \"$k\" in",
  "    MemTotal:) MEM_TOT=$((v / 1024)) ;;",
  "    MemAvailable:) MEM_AVAIL=$((v / 1024)); break ;;",
  "  esac",
  "done < /proc/meminfo 2>/dev/null",
  "MEM_USED=$((MEM_TOT - MEM_AVAIL))",
  "SHELL_VER=\"bash ${BASH_VERSION%%(*}\"",
  "TERM_NAME=\"${TERM:-xterm-256color}\"",
  "printf '\\n'",
  "printf '   %s   _____        __    _                 %s   %s%s%s@%s%s%s\\n' \"$G\" \"$R\" \"$G\" \"${USER:-root}\" \"$R\" \"$G\" \"$HOST\" \"$R\"",
  "printf '   %s  / ____|      / /   (_)                %s   %s--------------------------%s\\n' \"$G\" \"$R\" \"$D\" \"$R\"",
  "printf '   %s | |  __  ___ / /     _ _ __  _   ___  _%s   %sOS%s: Debian GNU/Linux 12 (bookworm) i686\\n' \"$G\" \"$R\" \"$BL\" \"$R\"",
  "printf '   %s | | |_ |/ _ \\\\ \\\\    | | '\\''_ \\\\| | | \\\\ \\\\/ /%s   %sHost%s: v86 WebAssembly VM (Browser)\\n' \"$G\" \"$R\" \"$BL\" \"$R\"",
  "printf '   %s | |__| | (_) | |___| | | | | |_| |>  < %s   %sKernel%s: Linux %s\\n' \"$G\" \"$R\" \"$BL\" \"$R\" \"$KERN\"",
  "printf '   %s  \\\\_____|\\\\___/|_____|_|_| |_|\\\\__,_/_/\\\\_\\\\%s   %sUptime%s: %s\\n' \"$G\" \"$R\" \"$BL\" \"$R\" \"$UP\"",
  "printf '   %s   100%% Local · Zero Server · Offline   %s   %sShell%s: %s\\n' \"$C\" \"$R\" \"$BL\" \"$R\" \"$SHELL_VER\"",
  "printf '   %s         terminal.golinux.app           %s   %sTerminal%s: %s\\n' \"$D\" \"$R\" \"$BL\" \"$R\" \"$TERM_NAME\"",
  "printf '                                              %sMemory%s: %s MiB / %s MiB\\n' \"$BL\" \"$R\" \"$MEM_USED\" \"$MEM_TOT\"",
  "printf '                                              \\e[40m   \\e[41m   \\e[42m   \\e[43m   \\e[44m   \\e[45m   \\e[46m   \\e[47m   %s\\n\\n' \"$R\"",
];
const FASTFETCH_CMD = "printf '%s\\n' " +
  FASTFETCH_LINES.map((l) => "'" + l.replace(/'/g, "'\\''") + "'").join(" ") +
  " > /usr/local/bin/fastfetch && chmod +x /usr/local/bin/fastfetch";

const SETUP_HVC0 = [
  "modprobe virtio_console",
  BASH_PROFILE_CMD,
  BASHRC_CMD,
  FASTFETCH_CMD,
  "printf '%s\\n' '# Ensure alternate-screen capable TERM' 'if [ -z \"$TERM\" ] || [ \"$TERM\" = \"vt102\" ] || [ \"$TERM\" = \"vt100\" ] || [ \"$TERM\" = \"dumb\" ]; then export TERM=xterm-256color; fi' > /etc/profile.d/term.sh",
  "chmod 644 /etc/profile.d/term.sh",
  "sed -i 's/vt102/xterm-256color/g' /etc/inittab",
  "grep -q '^H0:' /etc/inittab || echo 'H0:23:respawn:/sbin/getty -L hvc0 115200 xterm-256color --autologin root' >> /etc/inittab",
  "telinit q",
  // Respawn hvc0 login shell so it sources the freshly written /root/.bashrc (PROMPT_COMMAND + LS_COLORS).
  "HVC_OLD=$(ps -t hvc0 -o pid=,comm= | awk '$2==\"bash\"{print $1}'); [ -n \"$HVC_OLD\" ] && kill -9 $HVC_OLD 2>/dev/null || true",
].join("; ");

const MOTD_LINES = [
  "",
  "  GoLinux - Debian 12 (bookworm) i386, running in your browser.",
  "",
  "  Installed: bash, coreutils, util-linux, git, gcc/g++, make,",
  "             man-db + manpages, nano (the editor), curl, procps.",
  "",
  "  Networking is OFF. There is no internet access in this machine.",
  "",
  "  Your files in /root are saved in this browser and survive reloads.",
  "  Use Reset in the toolbar to start over with a clean machine.",
  "",
  "  First use of a program loads its disk blocks on demand; later uses are fast.",
  "",
];
const MOTD = "printf '%s\\n' " +
  MOTD_LINES.map((l) => "'" + l.replace(/'/g, "'\\''") + "'").join(" ") +
  " > /etc/motd";

const PREP = [
  `for s in ${STOP_SERVICES}; do service $s stop 2>/dev/null || true; done`,
  "mkdir -p /mnt/zf",
  `mount -t tmpfs -o size=${FILL_MB}M tmpfs /mnt/zf`,
  "dd if=/dev/zero of=/mnt/zf/fill bs=1M 2>/dev/null || true",
  "sync",
  "rm -f /mnt/zf/fill",
  "sync",
  "umount /mnt/zf",
  "syncfs / 2>/dev/null || sync",
  "sync",
  "sleep 1",
  "echo 3 > /proc/sys/vm/drop_caches",
].join("; ");

const serial = { text: "" };
const hvc = { text: "" };
let phase = 0; // 0=booting ttyS0 -> 1=waiting hvc0 prompt -> 2=running prep+verify -> 3=saving

const emulator = new V86({
  wasm_path: path.join(ROOT, "assets/v86/v86.wasm"),
  bios: { url: path.join(ROOT, "assets/bios/seabios.bin") },
  vga_bios: { url: path.join(ROOT, "assets/bios/vgabios.bin") },
  bzimage: { url: path.join(ROOT, "images/debian-bzImage") },
  initrd: { url: path.join(ROOT, "images/debian-initrd") },
  hda: {
    url: path.join(ROOT, "images/debian.img"),
    async: true,
    size: 5 * 1024 * 1024 * 1024,
  },
  filesystem: {},
  virtio_console: true,
  cmdline: `root=/dev/sda rw console=ttyS0 ${CMDLINE_EXTRA}`,
  memory_size: MEM_MB * 1024 * 1024,
  autostart: true,
});

const started = Date.now();

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");

function maybeEnterPhase2() {
  if (phase === 1 && /root@golinux:~#\s*$/.test(stripAnsi(hvc.text))) {
    if (!hvc.text.includes("\x1b[1;32mroot@golinux")) {
      console.error("[snapshot] ERROR: hvc0 prompt is missing ANSI colors: " + JSON.stringify(hvc.text.slice(-120)));
      emulator.stop(); process.exit(1);
    }
    phase = 2;
    console.error("\n[snapshot] hvc0 login shell ready (colored prompt ok); running RAM prep + verification");
    const verify = [
      "grep -q 'GoLinux' /etc/motd || echo 'MOTD_WRITE_FAILED'",
      "mountpoint -q /mnt/host || echo 'MOUNT_FAILED'",
      "HVC_PID=$(ps -t hvc0 -o pid=,comm= | awk '$2==\"bash\"{print $1; exit}')",
      "[ -n \"$HVC_PID\" ] && tr '\\0' '\\n' < /proc/$HVC_PID/environ | grep -qx 'TERM=xterm-256color' || echo 'HVC_TERM_FAILED'",
      "grep -q 'LS_COLORS=' /root/.bashrc && grep -q 'ls --color=auto' /root/.bashrc && grep -q '__gl_prompt_sp' /root/.bashrc || echo 'HVC_COLORS_FAILED'",
      "grep -q 'read -r UP_RAW' /usr/local/bin/fastfetch || echo 'FASTFETCH_FAILED'",
      "echo PREP_VERIFIED",
    ].join("; ");
    emulator.serial0_send(`${PREP}; ${verify}\n`);
  }
}

emulator.add_listener("virtio-console0-output-bytes", (bytes) => {
  const s = Buffer.from(bytes).toString("utf8");
  hvc.text += s;
  maybeEnterPhase2();
});

emulator.add_listener("serial0-output-byte", (byte) => {
  const c = String.fromCharCode(byte);
  serial.text += c;
  process.stdout.write(c);

  if (phase === 0 && /root@golinux:~#/.test(stripAnsi(serial.text))) {
    phase = 1;
    hvc.text = "";
    const bootSecs = (Date.now() - started) / 1000;
    console.error(`\n\n[snapshot] ttyS0 prompt after ${bootSecs.toFixed(1)}s at ${MEM_MB} MB; setting up 9p + hvc0`);
    emulator.serial0_send(`dmesg -n 1; ${SETUP_9P}; ${MOTD}; ${SETUP_HVC0}\n`);
    return;
  }

  const appeared = (m) => serial.text.split(m).length - 1 >= 2;
  if (phase === 2 && appeared("MOTD_WRITE_FAILED")) {
    console.error("[snapshot] ERROR: /etc/motd was not written");
    emulator.stop(); process.exit(1);
  }
  if (phase === 2 && appeared("MOUNT_FAILED")) {
    console.error("[snapshot] ERROR: /mnt/host was not mounted");
    emulator.stop(); process.exit(1);
  }
  if (phase === 2 && appeared("HVC_TERM_FAILED")) {
    console.error("[snapshot] ERROR: hvc0 bash does not have TERM=xterm-256color");
    emulator.stop(); process.exit(1);
  }
  if (phase === 2 && appeared("HVC_COLORS_FAILED")) {
    console.error("[snapshot] ERROR: hvc0 bash does not have LS_COLORS / __gl_prompt_sp");
    emulator.stop(); process.exit(1);
  }
  if (phase === 2 && appeared("FASTFETCH_FAILED")) {
    console.error("[snapshot] ERROR: zero-fork fastfetch was not written");
    emulator.stop(); process.exit(1);
  }

  if (phase === 2 && appeared("PREP_VERIFIED")) {
    phase = 3;
    setTimeout(async () => {
      const state = await emulator.save_state();
      fs.writeFileSync(OUT, new Uint8Array(state));
      console.error(`[snapshot] wrote ${OUT} (${(state.byteLength / 1048576).toFixed(1)} MiB raw)`);
      emulator.stop();
      process.exit(0);
    }, 3000);
  }
});

setTimeout(() => {
  console.error(`\n[snapshot] TIMEOUT after ${BOOT_TIMEOUT_MS}ms — phase ${phase}`);
  console.error("[snapshot] last serial: " + JSON.stringify(serial.text.slice(-300)));
  console.error("[snapshot] last hvc0:   " + JSON.stringify(hvc.text.slice(-300)));
  process.exit(1);
}, BOOT_TIMEOUT_MS);
