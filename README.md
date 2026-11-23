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

### Per-tool chunk sets and the loading indicator

`packs/tools.json` records, per tool, the chunks a **first use** reads. Each tool
is recorded in its own boot **restored from the production snapshot**
(`images/debian-state.bin.zst`), because one shared boot gave incomplete sets:
v86 caches every chunk it has read, so anything touched earlier was never
re-read and never recorded. A cold `gcc main.c` needed ~98 chunks that were in no
set.

| tool | chunks | size |
|---|---|---|
| ls | 18 | 0.3 MB |
| nano | 9 | 0.4 MB |
| git | 30 | 1.6 MB |
| make | 11 | 0.4 MB |
| gcc | 280 | 12.7 MB |
| g++ | 354 | 14.9 MB |
| man | 105 | 3.5 MB |
| curl | 140 | 6.4 MB |

The page shows two things while the disk is busy, both driven by the service
worker and neither of which types into the guest:

- **`Loading from disk… N files, X MB`** — appears only after 500 ms of
  continuous activity and hides after 300 ms of quiet, so short reads never
  flicker. The worker sends an explicit `idle` message to end a burst, because
  the last data message still carries new files.
- **`Loading gcc… 137/280 (7.1 MB)`** — approximate. It counts chunks present of
  that tool's set, not bytes. Sets overlap, so when several tools match the page
  picks the **smallest set** that explains the observed chunks (the most specific
  hypothesis), which correctly prefers `gcc` over `g++`.

### Prefetch

On a slow link the page can pull a tool's remaining chunks in the background
(concurrency 4, 16 MB cap, one set at a time, cached chunks skipped, cancelled on
page hide). It is gated on **measured** throughput from the worker — the first
~10 chunk fetches are timed, because `navigator.connection.effectiveType` is
Chromium-only — and never runs when `navigator.connection.saveData` is true.
Measured on a cold profile at 4 Mbps/150 ms: first `gcc main.c` went from
**38.0 s to 17.2 s** (c=4). On a fast link it is a net loss (3.4 s → 4.6 s), so
it stays off there. Disable it entirely with `GL_PREFETCH = false` in
`packs-config.js`.

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
| `packs/tools.json` | `node tools/image/build-tool-sets.js` |

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
node tools/test/sw-chunk-fallback.test.js # service-worker 404/offline policy,
                                         # disk-activity + throughput probes
node tools/image/build-tool-sets.js    # re-record the per-tool chunk sets
node tools/test/smoke-deploy.test.js   # REQUIRED before a deploy (see below)
```

`smoke-deploy.test.js` is the production-like check and is run automatically at
the end of `tools/deploy/build-pages.sh`. It serves the staged `.deploy-pages`
on one origin and a local mirror of exactly what `upload-r2.sh` uploads on a
second (real `images/debian-chunks/<buildId>/` paths, 404 for zeroed chunks),
rewrites the asset origin **only in a temp copy**, and drives a fresh headless
Chrome through a real session: load, `ls`, `gcc --version`, compile+run C, write
a file in `/root`, save, reload, and confirm the file survived. It asserts every
chunk request goes to the asset origin with the build id in the path and returns
200, that none reach the app origin, and that no "out of date" overlay appears.
It uses no `?assets=` override and no credentials, and exits non-zero on any
failure. Requires Chrome/Chromium (override with `$CHROME`). For a local build
only, `SKIP_SMOKE=1 ./tools/deploy/build-pages.sh` skips it — that output must
not be deployed.

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
