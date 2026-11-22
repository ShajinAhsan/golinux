# Third-party components

GoLinux itself is MIT licensed (see [LICENSE](./LICENSE)). It bundles and runs
the components below, each under its own license. Nothing here is modified
except where noted.

The authoritative license text for any file is the one shipped with that
project; the summaries below are for orientation.

---

## v86 — x86 emulator, compiled to WebAssembly

- **License:** BSD 2-Clause ("Simplified BSD")
- **Copyright:** © 2012, The v86 contributors
- **Used as:** `assets/v86/libv86.js`, `v86.wasm`, `v86-fallback.wasm`, and the
  BIOS images under `assets/bios/` (taken from the same repository)
- **Source:** <https://github.com/copy/v86>
- **License text:** <https://github.com/copy/v86/blob/master/LICENSE>
- **Note:** v86 itself bundles further third-party code under its own terms —
  Berkeley SoftFloat, zstd (BSD/GPL dual), and parts of QEMU's floppy
  controller under the MIT license. See the "License" section of v86's readme.

## xterm.js — terminal component

- **License:** MIT
- **Copyright:** © 2017-2019, The xterm.js authors; © 2014-2016, SourceLair
  Private Company; © 2012-2013, Christopher Jeffrey
- **Used as:** `assets/xterm/xterm.js`, `assets/xterm/xterm.css`
- **Source:** <https://github.com/xtermjs/xterm.js>
- **License text:** <https://github.com/xtermjs/xterm.js/blob/master/LICENSE>

## @xterm/addon-fit — terminal sizing addon

- **License:** MIT
- **Copyright:** © 2019, The xterm.js authors
- **Used as:** `assets/xterm/addon-fit.js`
- **Source:** <https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit>
- **License text:** <https://github.com/xtermjs/xterm.js/blob/master/addons/addon-fit/LICENSE>
- **Package:** <https://www.npmjs.com/package/@xterm/addon-fit>

## SeaBIOS — x86 BIOS

- **License:** GNU LGPL v3
- **Used as:** `assets/bios/seabios.bin`, `assets/bios/vgabios.bin`
  (prebuilt binaries from the v86 repository)
- **Source:** <https://www.seabios.org/> /
  <https://github.com/copy/v86/tree/master/bios>
- **License text:** <https://github.com/copy/v86/blob/master/bios/COPYING.LESSER>

---

## Guest operating system: Debian GNU/Linux 12 (bookworm), i386

The disk image is built from official Debian packages. Debian is free software;
the overwhelming majority of it is under the GNU GPL, LGPL, and other free
licenses, but **each package carries its own terms**.

- **Debian licensing overview:** <https://www.debian.org/legal/licenses/>
- **Social contract:** <https://www.debian.org/social_contract>
- **Machine-readable copyright (DEP-5):** <https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/>

**Exact license for any package, in the running machine:**

```sh
cat /usr/share/doc/<package>/copyright
# e.g.
cat /usr/share/doc/gcc-12-base/copyright
```

**Source packages.** Debian's licenses (notably the GPL) require that source be
available. For every binary in the image the corresponding source is on
Debian's servers:

- Source packages: <https://deb.debian.org/debian/pool/main/>
- Per-package source browser: <https://sources.debian.org/>

To list what is installed and resolve sources in one step:

```sh
dpkg-query -W -f='${Package} ${Version}\n'
apt-get source --download-only <package>   # requires deb-src entries
```

### Packages installed in the image

| Package | Typical license | Upstream |
|---|---|---|
| bash | GNU GPL v3+ | <https://www.gnu.org/software/bash/> |
| coreutils | GNU GPL v3+ | <https://www.gnu.org/software/coreutils/> |
| util-linux | GNU GPL v2+ / LGPL | <https://www.kernel.org/pub/linux/utils/util-linux/> |
| procps | GNU GPL / LGPL | <https://gitlab.com/procps-ng/procps> |
| make | GNU GPL v3+ | <https://www.gnu.org/software/make/> |
| git | GNU GPL v2 | <https://git-scm.com/> |
| gcc / g++ (12) | GNU GPL v3+ with GCC Runtime Library Exception | <https://gcc.gnu.org/> |
| man-db | GNU GPL v2+ | <https://man-db.gitlab.io/man-db/> |
| manpages / manpages-dev | Various permissive (GPL, BSD, MIT per page) | <https://www.kernel.org/doc/man-pages/> |
| nano | GNU GPL v3+ | <https://www.nano-editor.org/> |
| curl | curl license (MIT-like) | <https://curl.se/docs/copyright.html> |
| Linux kernel 6.1 | GNU GPL v2 | <https://www.kernel.org/> |
| e2fsprogs | GNU GPL v2 / LGPL | <https://e2fsprogs.sourceforge.net/> |
| systemd / udev (partial) | GNU LGPL v2.1+ | <https://systemd.io/> |
| sysvinit-core, initscripts | GNU GPL v2+ | <https://salsa.debian.org/debian/sysvinit> |
| locales (glibc) | GNU LGPL v2.1+ | <https://www.gnu.org/software/libc/> |

`/usr/share/doc` inside the machine is authoritative for the exact terms and
copyright holders of each package.

---

## Infrastructure (not distributed, but part of how this runs)

- **Cloudflare Pages / R2** — hosting and object storage, governed by
  Cloudflare's terms and acceptable-use policies.
- **Debian archive** — <https://deb.debian.org/> for package sources.

---

## What this project does *not* claim

- Debian, v86, xterm.js and SeaBIOS are trademarks/works of their respective
  owners; this project is not affiliated with or endorsed by them.
- The MIT license on this repository covers the original GoLinux code only, not
  the bundled third-party components listed above.
