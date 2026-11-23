# GoLinux System Invariants

Every invariant below is a non-negotiable property of the system. Any code change, build step, or deploy that violates an invariant must fail loudly in tests or build scripts.

| # | Invariant | Current Status (**VERIFIED**) | Existing Enforcement |
|---|---|---|---|
| **INV-1** | Nothing reaches the guest stdin except user input and key-bar taps | **VIOLATED** (6 call sites in `index.html`) | **NOT ENFORCED** (worse: `smoke-deploy.test.js:483-620` tests the `stty` injection) |
| **INV-2** | A 404/5xx/offline error for a real data chunk NEVER becomes zeros | **PARTIAL** (code holds; offline breaks via `BUG-09` & `BUG-10`) | Partial: `sw-chunk-fallback.test.js` tests 404/500/offline with mocked manifest; does NOT test missing `chunks-precache.json` or offline real-chunk UX |
| **INV-3** | Saved user state is NEVER restored against a different build id | **BROKEN OFFLINE** (`BUG-05`: `buildId === null` skips check) | **NOT ENFORCED** (no test for mismatch or offline restore) |
| **INV-4** | Every system fact has exactly ONE source of truth | **VIOLATED** (11 duplicated facts — see `ARCHITECTURE.md §4`) | Partial: `verify-manifests.js:190-199` checks `index.html`/`sw.js` for hardcoded cache names only |
| **INV-5** | At most ONE long-running job at a time per tab group | **BROKEN** (`BUG-15` Reset vs save; `BUG-20` pack cancel/remove race; `BUG-04` concurrent downloads) | Partial: `packs.test.js` tests 2 installs only; nothing for persist/Reset or transfer |
| **INV-6** | Build and deploy checks fail loudly — never fall back silently | **PARTIAL** (`BUG-27` rollback override; `BUG-28` stale `/tmp` & swallowed `statSync`; `sw.js:85` non-critical `empty-chunk.zst`) | Partial: `build-pages.sh` & `verify-manifests.js --deploy` fail on empty `GL_BUILD_ID` / missing `chunks-precache.json`; several silent fallbacks remain |
| **INV-7** | Offline uncached real-chunk miss degrades gracefully (never kills VM as "out of date" or loops forever) | **VIOLATED** (`BUG-09`, `BUG-10`) | **NOT ENFORCED** (`sw-chunk-fallback.test.js:278-281` actually asserts the broken `503` + `chunk-missing-real` behavior!) |
| **INV-8** | App deploys deliver a coherent shell + SW without serving stale cached JS or pack lists | **VIOLATED** (`BUG-07`: cache-first shell without mandatory version bump; `/packs/*` cached in shell cache; broken `_headers`) | **NOT ENFORCED** (no upgrade test; `deploy-site.sh` checks `/sw.js` only) |
| **INV-9** | Production asset origin cannot be redirected by URL query or persisted config | **VIOLATED** (`BUG-06`: `?assets=` unguarded on production + persisted in `golinux-config`) | **NOT ENFORCED** (`sw-chunk-fallback.test.js:396-432` tests override persistence on non-local host `app.test`!) |
| **INV-10** | User controls never brick the VM (Restart, Reset, Fatal recovery all leave a working state) | **VIOLATED** (`BUG-22` Restart hangs SeaBIOS; `BUG-15` Reset race; `BUG-23` Fatal has no button) | **NOT ENFORCED** |

---

## Detailed Specification & Required Enforcement

### INV-1: Nothing reaches the guest except user input and key-bar taps
- **Rule:** Zero automatic calls to `emulator.serial0_send()`, `emulator.serial_send_bytes()`, `emulator.keyboard_send_text()`, or `bus.send("serial0-input", ...)` / `bus.send("virtio-console0-input-bytes", ...)` are permitted on boot, restore, resize, upload, download, save, or background events. Every byte entering the guest console must originate directly from a physical/soft keyboard event or a `#keybar` button tap.
- **Current violations (VERIFIED):**
  - `index.html:1261-1262` (`export TERM=...; clear; cat /etc/motd\n` on snapshot/user restore)
  - `index.html:1285-1286` (`export TERM=...; clear; cat /etc/motd\n` on cold boot)
  - `index.html:1466-1468` (`echo "Uploaded ..."` on Upload)
  - `index.html:1510-1512` (`tar czf ...` on Download `/root`)
  - `index.html:1570` (`rm -f ...` after Download)
  - `index.html:1785,1791-1793` (`stty -echo`, `stty rows R cols C`, `stty echo`, `\x0c` on resize)
- **Required code fix:** Fix `TERM=xterm-256color` inside the image (`install.sh` + rebuilt snapshot), render MOTD once natively in snapshot/profile or xterm local display (never stdin), flag off Download/Upload until non-stdin paths exist, remove `stty` resize completely (use `virtio-console0-resize` out-of-band in Phase 5).
- **Required automated enforcement:**
  1. Static guard test: assert zero occurrences of `serial0_send` outside `js/keybar.js` (and `tools/image/`).
  2. Runtime spy test in `smoke-deploy.test.js`: wrap `emulator.serial0_send` and `emulator.bus.send` before `emulator-loaded`; run boot, idle wait, 3 viewport resizes, save, reload/restore, and upload; assert **0 non-user bytes** were sent to `serial0-input` / `virtio-console0-input-bytes`.
  3. **Mutation check:** Temporarily add `emulator.serial0_send("\n")` in `emulator-loaded` → spy test exits non-zero → revert byte-identical.

### INV-2: A chunk 404 / 5xx / offline error for a real data chunk NEVER becomes zeros
- **Rule:** `assets/empty-chunk.zst` may ONLY be returned when **all** of the following hold:
  1. `chunks-precache.json` has been loaded from the precached shell for the current build, AND
  2. the requested chunk name is NOT in `realChunkSet` (i.e., proven zeroed), AND
  3. the upstream status was specifically HTTP `404` or offline network error (never `500`/`502`/`503`/`504`/`403`).
- **Current gaps (VERIFIED):**
  - `chunks-precache.json` is not in `SHELL_FILES`, and `loadRealChunks()` caches a `null` failure forever (`sw.js:136-150`).
  - `assets/empty-chunk.zst` is exempted from install failure (`sw.js:85`).
- **Required enforcement:** Precache both `chunks-precache.json` and `assets/empty-chunk.zst` as install-critical in `SHELL_FILES`; read `chunks-precache.json` from `GL_SHELL_CACHE` first (with retryable fallback); expand `sw-chunk-fallback.test.js` with mutation checks.

### INV-3: Saved user state is NEVER restored against a different build id
- **Rule:** `loadUserState()` MUST compare `meta.buildId` against the stamped `GL_BUILD_ID` (from `packs-config.js`, the single source of truth) — never allowing `null` or `""` to bypass the comparison in production. If `meta.buildId !== expectedBuildId` (including missing `meta.buildId`), return `null`, preserve the bytes read-only (or offer export when implemented), and tell the user clearly.
- **Current gap (VERIFIED):** `persist.js:291` (`if (buildId && meta.buildId && meta.buildId !== buildId)`) silently restores mismatched state whenever `buildId` is `null` (offline) or `meta.buildId` is missing.
- **Required enforcement:** Unit test `persist` compatibility predicate for all `(expectedBuildId, meta.buildId)` combinations (`null`, `""`, mismatch, match) + Playwright/CDP upgrade test (seed old `meta.json`/`state.gz` → load new build both online and offline → assert old state is NOT restored).

### INV-4: Every fact has exactly ONE source of truth
- **Rule:**
  - **Build ID:** `GL_BUILD_ID` in `packs-config.js` (stamped from `images/build-id.json` at build time; `persist.js` reads `GL_BUILD_ID` directly instead of fetching `images/build-id.json` at runtime, except optional update-available check).
  - **Cache version:** `GL_VERSION` in `packs-config.js` (tests read it dynamically from `packs-config.js`, zero hardcoded `"v13"`).
  - **Asset origin:** `GL_ASSET_ORIGIN` in `packs-config.js`; `?assets=` override allowed **only** when `location.hostname` is `localhost`/`127.0.0.1`/`[::1]`, enforced in **both** page and SW.
  - **Installed packs:** `GL_PACK_CACHE` keys (delete `GL_PACK_KEY` dead constant; packs must NOT also write into `GL_DATA_CACHE`).
  - **Saved user state:** OPFS `golinux/state.gz` + atomically-replaced `golinux/meta.json` (or single versioned binary envelope combining header + gzip payload so state & metadata can never disagree!).
  - **Real chunk list:** `chunks-precache.json` derived from `images/debian-chunks/manifest.json` and verified equal by `verify-manifests.js`.
  - **Guest `TERM`:** `/etc/inittab` (`xterm-256color`) + `/etc/profile.d/term.sh`; delete conflicting `TERM=vt102` in `/root/.bash_profile` and `/root/.bashrc`.
- **Required enforcement:** Extend `verify-manifests.js` to assert: no hardcoded `golinux-*-v\d+` or hex build IDs in `tools/test/`, `chunks-precache.json` equals `manifest.json["real"]`, `MEMORY_SIZE` agrees across `index.html`/`js/boot.js`, `build-snapshot.sh`, and `build-tool-sets.js`, and `install.sh` contains no `TERM=vt102`.

### INV-5: One long-running job at a time per tab group
- **Rule:**
  - **Persistence:** Only the `golinux-owner` lock holder saves; every write AND `clearUserState()` acquires `golinux-state` lock; Reset sets a `resetting` latch that permanently disables `saveNow()` before clearing OPFS and reloading.
  - **Packs:** Single `golinux-pack-job` Web Lock; cancelling a job returns a Promise that resolves only *after* `runJob`'s `finally` releases the lock, so cancel-then-remove awaits cleanly before starting removal.
  - **Transfer (when re-enabled):** Single in-flight lock for Upload/Download.
- **Required enforcement:** Unit tests in `packs.test.js` (calling `removePack()` without manually awaiting `install()` first; two-tab `BroadcastChannel` test asserting bounded message count) and `persist.test.js` (Reset while save in flight + `pagehide` fires).

### INV-6: Deploy and build checks fail loudly — never fall back silently
- **Rule:**
  - `build-pages.sh` supports explicit `--build-id <id>` for rollback and fails if the target build's artifacts don't exist; `stamp-build-id.sh` is removed or deprecated so rollback cannot be silently undone.
  - `upload-r2.sh` stages chunks from `images/debian-chunks/$BUILD_ID/` (not flat mirror) and runs `verify-manifests.js` first.
  - `deploy-site.sh` verifies live `sw.js` sha256, `index.html` sha256, `packs-config.js` `GL_ASSET_ORIGIN` **and** `GL_BUILD_ID`, `chunks-precache.json` 200, non-conflicting `Cache-Control` headers, and R2 chunk + CORS.
  - `build-packs.js` / `build-tool-sets.js` always recreate fresh APFS clones (never reuse `/tmp/golinux-*`); `build-pack-index.js` and `build-tool-sets.js` fail hard on any missing chunk instead of catching and returning 0.
  - `build-pages.sh` warns loudly when any asset exceeds 90% of the 25 MiB Cloudflare limit (currently `debian-initrd` is at 96.7%!).
- **Required enforcement:** Negative unit/script tests (missing chunk, empty build id, mismatched build id, bad `_headers` duplicate `Cache-Control`) that must exit non-zero.

### INV-7: Offline real-chunk misses degrade gracefully
- **Rule:** Distinguish **404 on a real chunk** (`chunk-missing-real` → version mismatch / missing object on R2 → fatal "This version is out of date" + Reload button) from **network failure / offline** (`chunk-offline` → show `#offlineBanner`, do NOT claim "out of date", do NOT kill the VM, and return HTTP `408`/`404` or controlled error that avoids v86's silent infinite 503 retry storm after stop). For a known-empty chunk offline, return `empty-chunk.zst` silently without showing `#offlineBanner`.
- **Required enforcement:** Update `sw-chunk-fallback.test.js` to assert separate event types (`chunk-missing-real` on 404 vs `chunk-offline` on network error, and silence on known-empty offline).

### INV-8: App deploys deliver coherent shell + SW without stale caches
- **Rule:**
  - `public/_headers` uses `! Cache-Control` before every override block so headers are never concatenated.
  - `sw.js` uses **network-first (with cache fallback)** for HTML navigations and `/packs/*.json` (or never caches `/packs/*.json` in `GL_SHELL_CACHE`), and `GL_VERSION` (or a stamped deploy hash in `sw.js`) changes on every deploy so browsers always detect a new SW and refresh `GL_SHELL_CACHE`.
- **Required enforcement:** Fresh-vs-upgrade test (serve v1, load & cache, swap server to v2, reload → assert v2 JS/HTML is active and old shell cache is evicted).

### INV-9: Production asset origin cannot be redirected by query string or stored override
- **Rule:** `?assets=` and `golinux-config` persistence are strictly gated on `localhost` / `127.0.0.1` / `[::1]` in **both** `packs-config.js` and `sw.js`. On any other host, `GL_ASSET_BASE` is immutably `GL_ASSET_ORIGIN`.
- **Required enforcement:** SW unit test on non-local origin (`https://golinux.app`) verifying `set-asset-base` is ignored and cannot persist to `golinux-config`.

### INV-10: User controls never brick the VM
- **Rule:** Every visible button in the toolbar and overlays must either work reliably or not be shown:
  - **Restart** must reload cleanly from the shipped snapshot (or user state, clearly labelled — e.g. destroy + re-instantiate `V86` or page reload without wiping OPFS) rather than calling `emulator.restart()` into an unbootable SeaBIOS.
  - **Fatal overlay** must always include a working **Reload** button.
  - **Reset** must reliably yield a fresh machine on reload.
- **Required enforcement:** Smoke test clicks Restart (verifies prompt returns and accepts commands) and clicks Reset (verifies `/root/marker.txt` is gone after reload).
