# GoLinux

A CLI-only Debian 12 (bookworm) i386 machine that runs **entirely in your
browser**, emulated with [v86](https://github.com/copy/v86) and rendered with
[xterm.js](https://xtermjs.org/). No backend, no server-side compute: the VM is
WebAssembly running on the visitor's device.

**What it is:** a real Debian userland — `bash`, `coreutils`, `git`, `gcc`/`g++`,
`make`, `man`, `nano`, `curl`, `lsblk` — reachable at a terminal prompt in a
browser tab.

**What it is not:** a network-connected machine (networking is off), a
replacement for a real Linux server, or a sandbox for untrusted code. It is a
sandbox in the "your own browser" sense, not a security boundary.

---

## How it works

```
          ┌──────────────────── browser tab ─────────────────────┐
          │                                                     │
app origin│  index.html ── xterm.js ── v86 (WebAssembly)         │
(Pages)   │      │              │                                │
          │      │              ├── snapshot (+ user state, OPFS) │
          │      │              ├── kernel + initrd (cold boot)   │
          │      │              └── disk chunks ─────────────┐    │
          │      │                                            │    │
          │  sw.js (service worker)                            │    │
          │      ├─ precaches the shell + snapshot             │    │
          │      ├─ caches chunks on demand                    │    │
          │      ├─ opts into offline packs                    │    │
          │      └─ proxies chunk requests ──────┐             │    │
          └─────────────────────────────────────┼─────────────┼────┘
                                                │             │
asset origin (R2)                     images/debian-chunks/<buildId>/
                                      packs/<buildId>/
```

Four ideas carry the whole thing:

1. **Snapshot boot.** The machine is shipped as a saved v86 state, so the shell
   appears in well under a second instead of booting Linux from scratch. The
   snapshot is ~12 MB and is the only large first-load download.

2. **Chunked disk.** The 5 GiB disk is split into 40,960 zstd-compressed 128 KiB
   chunks and served lazily: only the blocks the guest actually reads are
   fetched. 35,358 of them are zeroed regions that the service worker
   synthesises locally, so only ~5,600 objects exist in storage.

3. **Build-versioned URLs.** Chunk names are positional, so a rebuild changes
   their *bytes* while keeping their *names*. Every build therefore gets its own
   path (`…/<buildId>/…`, a content hash of the served files), which makes
   `Cache-Control: immutable` truthful and lets old builds keep working while
   clients are still on them.

4. **Persistence without a server.** `save_state()` is written to OPFS,
   gzip-compressed, on a timer and when the tab is hidden. Uploads are
   deliberately **excluded** from that state (they live in a 9p share that is
   stripped before saving), so a 40 MB upload costs 0.1 MB of snapshot instead
   of 40 MB.

### Repository layout

```
index.html            app shell: terminal, toolbar, packs UI, boot orchestration
about.html            credits and licenses page
packs-config.js       THE place for cache names and asset base URLs
packs.js              opt-in offline pack downloader (pause/resume/cancel)
persist.js            OPFS persistence: autosave, restore, reset, size limits
persist-9p.js         strips uploads out of the saved state (no v86 patching)
sw.js                 service worker: precache, chunk cache, offline fallback
manifest.json         PWA manifest
icons/                PWA icons
assets/v86/           libv86.js + v86.wasm (third-party)
assets/xterm/         xterm.js, addon-fit (third-party)
assets/bios/          SeaBIOS images (third-party)
assets/empty-chunk.zst  the zeroed chunk used as the offline/404 fallback

tools/image/          build the disk image, snapshot and packs
tools/deploy/         stamp the build id, assemble Pages output, upload to R2
tools/dev/            two-origin server that mimics the production split
tools/test/           guards (v86 9p state shape)
```

Generated artifacts (`images/`, `packs/`) are **not committed** — see
[Rebuilding generated files](#rebuilding-generated-files).

---

## Running locally

Everything is static; no build step and no npm dependencies.

```sh
python3 -m http.server 8099
# open http://127.0.0.1:8099/
```

`file://` will not work: the service worker and WebAssembly need a real origin.
`localhost` counts as a secure context, which service workers require.

### Two-origin mode (closer to production)

Chunks normally live on a different origin (R2) than the app (Pages). To test
that locally:

```sh
python3 tools/dev/serve-two-origins.py --omit-empty-chunks
# app   : http://127.0.0.1:8090/index.html?assets=http://127.0.0.1:8091
```

`--omit-empty-chunks` makes the fake asset origin 404 the zeroed chunks exactly
as production does, so the fallback path is exercised.

---

## Building the image

Requires **Docker** (with `linux/386` emulation — Docker Desktop provides it;
Colima needs `qemu` installed) plus **Node 18+** and **Python 3**.

```sh
bash tools/image/build.sh        # ~12 min: disk image, chunks, build id
bash tools/image/build-snapshot.sh   # ~1 min: boot headless and save state
node tools/image/build-packs.js common
node tools/image/build-packs.js full
node tools/image/build-pack-index.js
node tools/image/verify-manifests.js  # must pass
```

`build.sh` produces:

| Artifact | Size | Purpose |
|---|---|---|
| `images/debian.img` | 745 MB | raw ext4 disk (not served) |
| `images/debian-chunks/<buildId>/` | 373 MB | 40,960 zstd chunks (5,600 uploaded) |
| `images/debian-bzImage` | 5.5 MB | kernel, for cold boot |
| `images/debian-initrd` | 24 MB | initrd, for cold boot |
| `images/build-id.json` | tiny | content hash of everything served |

`build-snapshot.sh` then produces `images/debian-state.bin.zst` (~12 MB).

### Rebuilding generated files

These are gitignored because they are large and reproducible:

| Path | Regenerate with |
|---|---|
| `images/debian.img` | `bash tools/image/build.sh` |
| `images/debian-chunks/` | `bash tools/image/build.sh` |
| `images/debian-state.bin.zst` | `bash tools/image/build-snapshot.sh` |
| `images/debian-bzImage`, `debian-initrd` | `bash tools/image/build.sh` |
| `images/build-id.json` | `node tools/image/build-id.js` |
| `packs/*.json` | `node tools/image/build-packs.js common` then `full`, then `node tools/image/build-pack-index.js` |
| `chunks-precache.json` | `node tools/image/build-chunk-manifest.js` |

**Important:** rebuilding the image changes every chunk's bytes. Packs recorded
against the previous image silently serve stale data offline (it shows up as
`invalid ELF header` from `git`/`gcc`), so **always re-record packs** after an
image rebuild — `rm -f packs/common.json` first, since the recorder unions with
existing lists.

The snapshot's prep step runs `sync` and verifies `/etc/motd` and the `/mnt/host`
mount before saving, and fails the build if either did not take.

---

## Deploying

Full instructions live in **[DEPLOYMENT.md](./DEPLOYMENT.md)**. In short:

1. Create an R2 bucket and connect a **custom domain** (not `r2.dev`, which is
   rate-limited and not for production).
2. Set the CORS policy from `public/r2-cors.json` — replace the
   `YOUR-PROJECT.pages.dev` placeholder first.
3. `./tools/deploy/upload-r2.sh --dry-run` then without the flag.
4. `./tools/deploy/build-pages.sh` (stamps the build id) and deploy `.deploy-pages`
   to Cloudflare Pages.
5. Keep the last three builds in R2; **never delete a build until a day after
   its successor is live** (see DEPLOYMENT.md §7).

---

## Testing

```sh
node tools/image/verify-manifests.js   # manifests, build id, cache version agree
node tools/test/check-9p-state-shape.js  # guards against a v86 upgrade breaking
                                         # the upload-stripping wrapper
node tools/test/sw-chunk-fallback.test.js # service-worker 404/offline policy
```

`verify-manifests.js --deploy` additionally requires a non-empty `GL_BUILD_ID`
that matches `images/build-id.json`, and is run by `tools/deploy/build-pages.sh`
against the staged output — a production deploy cannot ship flat, unversioned
chunk paths. `sw-chunk-fallback.test.js` runs the real `sw.js` in a shimmed
worker context and asserts: a 404 for a name not in `chunks-precache.json`
returns the empty-chunk template; a 404 for a real chunk is not papered over
with zeros and posts `chunk-missing-real`; and 500s / network failures are never
turned into zeros. It exits non-zero on failure and also runs at the end of
`tools/image/build.sh`.

`check-9p-state-shape.js` boots the real emulator and asserts that v86's 9p
state still has the shape `persist-9p.js` relies on. If a v86 upgrade changes
it, this fails loudly instead of silently putting uploads back into every
snapshot.

---

## Security notes

- **The guest root password is intentionally `root:root`.** The machine is a
  single-user sandbox in the visitor's own browser: there is no network, no
  other user, and nothing to protect behind a password. It exists only so
  `su`/login behave normally.
- **Networking is disabled.** The guest cannot reach the internet.
- **Uploads are not persisted** by design; they live in `/mnt/host` and are
  stripped from the saved state. Copy them to `/root` to keep them.
- **Upload/download limits** exist to protect the tab: 50 MB per upload, and a
  download cap of 300 MB on desktop / 30 MB on phones.
- No analytics, no tracking, and no requests beyond loading the app and its
  disk data.

---

## Credits

Built on other people's excellent work:

- **[v86](https://github.com/copy/v86)** — x86 emulator in WebAssembly (BSD
  2-Clause)
- **[xterm.js](https://xtermjs.org/)** and
  **[@xterm/addon-fit](https://www.npmjs.com/package/@xterm/addon-fit)** —
  terminal (MIT)
- **[SeaBIOS](https://www.seabios.org/)** — BIOS (LGPL v3)
- **[Debian](https://www.debian.org/)** — the guest OS, and its many upstream
  projects

Full license details, including how to obtain the Debian source packages, are
in **[THIRD_PARTY.md](./THIRD_PARTY.md)**.

---

## License

MIT — see [LICENSE](./LICENSE). That covers the GoLinux code only; the bundled
third-party components keep their own licenses.
