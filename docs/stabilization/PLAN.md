# GoLinux Stabilization Plan

**Priority order:** Phase 0 (Freeze & Baseline) → Phase 1 (**Data-Loss** elimination) → Phase 2 (**Hangs** & core correctness) → Phase 3 (**Test Harness** & cross-browser matrix) → Phase 4 (**Modularize** `index.html`) → Phase 5 (**Re-enable** flagged features one by one, plus cosmetics).

No code is changed until you approve a specific step. Every step is small, independently testable, and reversible.

---

## Phase 0: Freeze Features, Record Baseline & Fix Safety Net

### Step 0.1 — Feature freeze & capture baseline git tags / live state
- **Goal:** Stop all feature work; record the exact currently-deployed Cloudflare Worker version ID and create git baseline tags so you can always inspect or roll back to pre-stabilization state. Decide disposition of the 3 uncommitted files (`index.html`, `tools/image/install.sh`, `tools/test/smoke-deploy.test.js`): stash or branch them (`git checkout -b wip/pre-stabilization-term-resize`), then return cleanly to `main` (`4e13103`) and tag `baseline-pre-stabilization`.
- **Files touched:** None in `main` (git branch/tag + note of live Worker deployment version ID from `npx wrangler deployments list` run by owner).
- **Risk:** None.
- **Tests added:** None.
- **R2 re-upload / new build id?** No / No.
- **Rollback:** `git checkout wip/pre-stabilization-term-resize` restores the exact pre-audit working tree.

### Step 0.2 — Fix broken CLI rollback & header concatenation (`BUG-07`, `BUG-27`)
- **Goal:** Make rollback work *before* deploying any stabilization changes:
  1. Add `--build-id <id>` support to `tools/deploy/build-pages.sh` (fails loudly if chunks/manifest for `<id>` don't match, never silently overwrites with `images/build-id.json`). Deprecate/remove `stamp-build-id.sh` mutating the working tree.
  2. Fix `public/_headers`: add `! Cache-Control` before every narrow block overriding `/*`'s `Cache-Control` (so Cloudflare does not concatenate conflicting directives).
  3. Fix `tools/deploy/deploy-site.sh`: replace macOS-broken `date +%s%N` with `date +%s` + `$$`, and add live checks for `GL_BUILD_ID`, `index.html` sha256, and non-duplicate `Cache-Control` on `/sw.js`.
- **Files touched:** `tools/deploy/build-pages.sh`, `tools/deploy/deploy-site.sh`, `public/_headers`, `tools/deploy/stamp-build-id.sh` (remove or redirect to `build-pages.sh --build-id`).
- **Risk:** Low (build/deploy tooling + headers only; verify with `--dry-run`).
- **Tests added:** Static `_headers` linter in `verify-manifests.js` (fails if any block overrides `Cache-Control` without `! Cache-Control`); shell test verifying `build-pages.sh --build-id <id>` stamps `<id>` and fails on unknown `<id>`. *Mutation check:* remove one `! Cache-Control` → `verify-manifests.js` exits non-zero → restore.
- **R2 re-upload / new build id?** No / No.
- **Rollback:** `git revert` commit; Cloudflare Worker dashboard rollback to previous deployment.

---

## Phase 1: Eliminate Data-Loss Bugs (Priority 1)

### Step 1.1 — Introduce `GL_FEATURES` flags & hide unstable features (`SCOPE.md`)
- **Goal:** Add `GL_FEATURES` in `packs-config.js` with `packs`, `diskIndicator`, `toolProgress`, `prefetch`, `upload`, `download`, `restartButton` all set to `false` for launch stabilization. Hide their toolbar/menu items and skip registering their listeners/network fetches when `false`. Remove unused `addon-fit.js` script tag & precache entry, dead `GL_PACK_KEY`, and dead `"golinux-packs-ui"` channel.
- **Files touched:** `packs-config.js`, `index.html`, `sw.js`, `tools/deploy/build-pages.sh`.
- **Risk:** Low (reduces active attack/bug surface dramatically).
- **Tests added:** Unit/DOM check verifying flagged-off controls are hidden and zero `/packs/*.json` requests fire on boot. *Mutation check:* flip `packs: true` → test asserts controls appear / fails flagged-off check → restore.
- **R2 re-upload / new build id?** No / No (bump `GL_VERSION` on deploy).
- **Rollback:** `git revert` or flip flags back; Worker rollback.

### Step 1.2 — Enforce INV-1: remove ALL `serial0_send` injections & fix `TERM` in the image (`BUG-01`, `BUG-02`, `BUG-03`, `BUG-04`, `BUG-30`)
- **Goal:**
  1. Delete boot/cold-boot `serial0_send("export TERM=...; clear; cat /etc/motd\n")` (`index.html:1261,1285`), resize `stty`/`Ctrl-L` injection + `watchShellPrompt()` (`index.html:1643-1797`), upload `serial0_send("echo ...")` (`index.html:1466`), and download `serial0_send("tar/rm")` (`index.html:1510,1570`).
  2. Display MOTD on fresh boot via local `term.write(...)` (pure display, zero bytes sent to guest stdin!) and update MOTD text to match core launch scope (no mention of flagged-off Upload/Download).
  3. Fix `tools/image/install.sh`: remove the contradictory `export TERM=vt102` lines in `/root/.bash_profile` (line 82) and `/root/.bashrc` (line 89), keeping `xterm-256color` from `inittab` + `/etc/profile.d/term.sh`.
  4. Rebuild image (`build.sh`) + snapshot (`build-snapshot.sh`) so the shipped snapshot boots natively with `TERM=xterm-256color` (required once for `nano` alternate screen without `serial0_send`).
- **Files touched:** `index.html`, `tools/image/install.sh`, `tools/image/save-state.js` (update MOTD text), `tools/image/verify-manifests.js` (forbid `TERM=vt102` in `install.sh`).
- **Risk:** Medium — rebuilding the disk image mints a **new `buildId`**, which invalidates existing users' OPFS saved states on live `golinux.app` (see §Upgrade Story below; do this ONCE during stabilization so we don't invalidate users repeatedly!). *Alternative if you want to avoid minting a new `buildId` right now:* patch `/root/.bashrc` and `/root/.bash_profile` inside `save-state.js` before `syncfs` + `save_state()` (keeping the exact same `debian.img` chunks and `buildId`, updating only the snapshot + bumping `GL_VERSION`!). **Recommended:** patch in `install.sh` for future rebuilds AND apply in `save-state.js` now if you want to preserve `buildId` `3a3a2a8af275cc11` and avoid an R2 re-upload!
- **Tests added:** Static grep guard (zero `serial0_send` outside keybar/image tools) + runtime `serial0_send` / `bus.send("serial0-input")` spy in `smoke-deploy.test.js` asserting 0 non-user bytes across boot, resize, save, reload + `TERM=xterm-256color` & `nano` clean scrollback check. *Mutation check:* add `serial0_send("\n")` in `emulator-loaded` → spy test exits non-zero → restore.
- **R2 re-upload / new build id?**
  - **Option A (snapshot-only update via `save-state.js` + `install.sh` fix for next image):** **No R2 re-upload / No new `buildId`** (only bump `GL_VERSION` so SW refreshes cached snapshot!).
  - **Option B (full `build.sh` rebuild):** **Yes R2 re-upload (`upload-r2.sh`) / Yes new `buildId`**.
- **Rollback:** Worker rollback (and if Option B, old `<prev-build-id>` remains intact in R2 for ≥24 h).

### Step 1.3 — Fix all OPFS persistence & 9p data-loss bugs (`BUG-05`, `BUG-13`, `BUG-14`, `BUG-15`, `BUG-16`, `BUG-17`)
- **Goal:**
  1. **Single source of truth for `buildId` (`BUG-05`):** Pass `GL_BUILD_ID` (from `packs-config.js`) into `persist.js` instead of relying solely on network `images/build-id.json`. Refuse restore whenever `expectedBuildId` is non-empty and `meta.buildId !== expectedBuildId` (including `meta.buildId == null` or offline!). Never overwrite `meta.buildId` with `null`.
  2. **Dirty sequence counter (`BUG-14`):** Replace boolean `dirty` with `dirtySeq` counter; snapshot `const seq = dirtySeq` *before* `save_state()`, and only mark clean if `dirtySeq === seq` after write finishes.
  3. **Safe `visibilitychange` save (`BUG-13`):** Do not drop `visibilitychange("hidden")` saves solely because `!atPrompt` (or clearly warn + allow saving at safe quiescence, and provide an explicit "Save now" button/status feedback when saving is blocked). Also save via a dedicated OPFS Worker using `createSyncAccessHandle()` when `FileSystemFileHandle.move()` / `createWritable()` are unavailable (fixes Safari/Firefox OPFS portability, `BUG-16`).
  4. **Atomic state + metadata (`BUG-16`):** Write a single atomic file (or write `meta.json.tmp` → atomic rename, or single binary envelope `[magic][metaLen][metaJSON][gzipBytes]`) so `meta.json` and `state.gz` can never tear or disagree.
  5. **Gzip Worker error recovery (`BUG-16`):** Handle `gzipWorker.onerror` and `onmessageerror` to reject pending promises, recreate the worker, and release `saveInFlight`.
  6. **Reset lock & unload disarm (`BUG-15`):** Add `resetting = true` latch in `persist.js` before acquiring `golinux-state` lock and removing OPFS dir; `saveNow()` returns immediately if `resetting === true`, preventing `pagehide` from re-saving wiped state.
  7. **Fix `persist-9p.js` (`BUG-17`):** Only set `validated = true` *after* `assertV86StateShape(fs)` succeeds; on failure set `shapeBroken = true` so every subsequent save falls back cleanly instead of crashing on save #2.
- **Files touched:** `persist.js`, `persist-9p.js`, `index.html` (`resetBtn` handler).
- **Risk:** Medium (touches user storage; test upgrade from existing `state.gz` + `meta.json` format so returning users on same `buildId` keep their sessions!).
- **Tests added:** New `tools/test/persist.test.js` covering: offline `buildId` mismatch refusal, `dirtySeq` mid-save edit preservation, Reset during in-flight save + `pagehide`, Worker crash recovery, `persist-9p.js` double-call after broken shape, legacy `state.gz` + `meta.json` read compatibility. *Mutation check:* revert `dirtySeq` to boolean cleared after await → test fails → restore.
- **R2 re-upload / new build id?** No / No (bump `GL_VERSION`).
- **Rollback:** `git revert` + Worker rollback (keep reading legacy `state.gz` + `meta.json` format for backward compatibility).

---

## Phase 2: Eliminate Hangs & Core Correctness Bugs (Priority 2)

### Step 2.1 — Fix Service Worker offline policy, precache, HEAD proxy, `?assets=` security, and stale shell updates (`BUG-06`, `BUG-07`, `BUG-09`, `BUG-10`, `BUG-11`, `BUG-12`)
- **Goal:**
  1. Add `chunks-precache.json` to `SHELL_FILES` and make BOTH `chunks-precache.json` and `assets/empty-chunk.zst` install-critical (`BUG-10`, `BUG-12`).
  2. Read `chunks-precache.json` from `GL_SHELL_CACHE` first in `loadRealChunks()`; clear `realChunkPromise = null` on failure so transient errors are never cached forever (`BUG-10`).
  3. Separate offline real-chunk failure (`type: "chunk-offline"`, return status `408` or `404` — never `503` so v86 doesn't infinite-retry after stop) from 404 real-chunk (`type: "chunk-missing-real"` → fatal "This version is out of date" + Reload button). On known-empty chunk offline, return `empty-chunk.zst` silently without posting `chunk-miss` (`BUG-09`).
  4. Fix chunk `HEAD` proxy to pass `{ method: "HEAD" }` (and answer from cache if present) (`BUG-11`).
  5. Stop `sw.js` from caching `/packs/*.json` in `GL_SHELL_CACHE` (network-first/pass-through for `/packs/*`) and use **network-first with cache fallback** for HTML navigations so code deploys take effect immediately (`BUG-07`).
  6. Gate `?assets=` and `golinux-config` persistence on `isLocal` (`localhost`/`127.0.0.1`/`[::1]`) in **both** `packs-config.js` and `sw.js`; eliminate `assetBaseReady` race with `set-asset-base` (`BUG-06`).
- **Files touched:** `sw.js`, `packs-config.js`, `index.html` (`chunk-offline` handler).
- **Risk:** Medium (SW controls all traffic — verify thoroughly in Layer 2 SW harness + Layer 3 fresh-vs-upgrade test before deploy).
- **Tests added:** Expand `tools/test/sw-chunk-fallback.test.js` for all 6 items above (each with a mutation check).
- **R2 re-upload / new build id?** No / No (bump `GL_VERSION`).
- **Rollback:** `git revert` + bump `GL_VERSION` + deploy (or Worker rollback).

### Step 2.2 — Fix VM lifecycle controls & mobile core UX (`BUG-22`, `BUG-23`, `BUG-24`, `BUG-25`, `BUG-26`)
- **Goal:**
  1. Add a working **Reload** button inside `#fatal` (`BUG-23`).
  2. Replace broken `emulator.restart()` (`BUG-22`) with safe restart (either keep hidden behind `GL_FEATURES.restartButton = false` or replace with clean `emulator.destroy()` + re-boot from snapshot without touching OPFS).
  3. Hook `latchedCtrl` / `latchedAlt` into xterm's input path (`term.onData` / `keydown` / `beforeinput` before sending to `serial0-input`) so tapping `Ctrl` on `#keybar` then typing `o`/`d`/`c`/`w` on a native mobile keyboard sends the real control byte and disarms the latch (`BUG-24`).
  4. Fix iOS Safari focus & zoom (`BUG-25`): call `term.focus()` synchronously inside `pointerdown`/`click` (no `setTimeout(..., 0)`), and set `.xterm-helper-textarea { font-size: 16px; }` to prevent iOS auto-zoom.
  5. Fix `#persistStatus` layout (`BUG-26`): truncate or place in a dedicated non-overflowing flex slot so long persistence messages never overflow `#bar` on 320 px screens.
- **Files touched:** `index.html`.
- **Risk:** Low–Medium (UI + input path; verify on real iPhone in addition to automated tests).
- **Tests added:** Keybar native-keyboard `Ctrl`+`o`/`d` test; `#bar` overflow test with 120-char `#persistStatus`; `#fatal` Reload button test; Restart test (if enabled). *Mutation check:* disable `latchedCtrl` check in native input handler → test fails → restore.
- **R2 re-upload / new build id?** No / No (bump `GL_VERSION`).
- **Rollback:** `git revert` + Worker rollback.

---

## Phase 3: Test Harness, Build-Script Hardening & Cross-Browser Matrix

### Step 3.1 — Harden image/deploy scripts & dev server (`BUG-28`, `BUG-29`)
- **Goal:**
  1. Fix `tools/dev/serve-two-origins.py` (`APP_PREFIXES`: remove `""` and explicitly disallow `images/debian-chunks/` and `packs/`).
  2. Fix `tools/image/build-packs.js` and `tools/image/build-tool-sets.js`: always remove/recreate `/tmp/golinux-*` clones per run (or use `mkdtempSync` + cleanup in `finally`).
  3. Fix `tools/image/build-pack-index.js` and `tools/image/build-tool-sets.js`: fail loudly on missing chunk instead of `catch { return sum; }`.
  4. Fix `tools/deploy/upload-r2.sh`: stage from `images/debian-chunks/$BUILD_ID/` (not flat mirror) and run `verify-manifests.js` before uploading.
  5. Extend `tools/image/verify-manifests.js`: verify `chunks-precache.json` equals `manifest.json["real"]`, verify `MEMORY_SIZE` matches across files, warn when any staged file exceeds 90% of Cloudflare's 25 MiB cap (`debian-initrd` is 24.18 MiB!), and fail if any `tools/test/*.js` hardcodes `golinux-*-v\d+` or a 16-hex build ID.
- **Files touched:** `tools/dev/serve-two-origins.py`, `tools/image/build-packs.js`, `tools/image/build-tool-sets.js`, `tools/image/build-pack-index.js`, `tools/deploy/upload-r2.sh`, `tools/image/verify-manifests.js`.
- **Risk:** Low (offline tooling only).
- **Tests added:** Negative test script `tools/test/build-guards.test.js` verifying `serve-two-origins.py` returns 404 for chunks on port 8090 and `verify-manifests.js` fails on mismatches.
- **R2 re-upload / new build id?** No / No.
- **Rollback:** `git revert`.

### Step 3.2 — Upgrade `smoke-deploy.test.js` & add Playwright Chromium/Firefox/WebKit matrix (`TEST-PLAN.md`)
- **Goal:**
  1. Remove all hardcoded `"golinux-pack-v13"` and `"3a3a2a8af275cc11"` from `smoke-deploy.test.js` and `packs.test.js` (read dynamically from staged `packs-config.js` & `images/build-id.json`).
  2. Add the **`serial0_send` spy test**, **Fresh-vs-Upgrade test** (v1 → v2 code upgrade keeping `/root` files; old `buildId` rejected both online and offline), **Reset click test**, and **Offline real-chunk banner test**.
  3. Add a dev-only `tools/test/package.json` with Playwright (`chromium`, `firefox`, `webkit`) and `tools/test/cross-browser.test.js` verifying boot, typing, keybar, OPFS persistence (or graceful private-mode warning), and Reset across all 3 engines.
- **Files touched:** `tools/test/smoke-deploy.test.js`, `tools/test/packs.test.js`, `tools/test/ui-layout.test.js`, `tools/test/package.json` (new, dev-only), `tools/test/cross-browser.test.js` (new).
- **Risk:** Low (tests only; may uncover real Firefox/WebKit OPFS bugs — which is the point!).
- **Tests added:** The full Layer 3 + Layer 4 suite, each verified by a mutation check.
- **R2 re-upload / new build id?** No / No.
- **Rollback:** `git revert`.

> **CHECKPOINT — FIRST STABLE LAUNCH POSSIBLE HERE!**  
> After Phase 3 passes all automated tests + the 5-minute Manual Real-Phone Checklist (`TEST-PLAN.md §4`), GoLinux Core is safe to deploy to `golinux.app` with zero known data-loss or hang bugs.

---

## Phase 4: Modularize `index.html` (Zero Framework, Zero Build Step)

### Step 4.1 — Extract CSS and ES modules per `STRUCTURE.md`
- **Goal:** Extract `styles.css` and `js/{main,status,boot,terminal,keybar,persist-ui,packs-ui,transfer,tool-progress}.js` mechanically with zero behavior changes; drive both `sw.js` (`SHELL_FILES`) and `build-pages.sh` from one shared `GL_SHELL_FILES` list in `packs-config.js`.
- **Files touched:** `index.html`, `styles.css` (new), `js/*.js` (new), `packs-config.js`, `sw.js`, `tools/deploy/build-pages.sh`, `tools/image/verify-manifests.js`.
- **Risk:** Low (protected by the full Phase 3 test suite + `serial0_send` spy + cross-browser matrix).
- **Tests added:** Pure unit tests importing `js/keybar.js`, `js/terminal.js`, `js/tool-progress.js` directly in Node; static check that `serial0_send` exists in zero files under `js/`.
- **R2 re-upload / new build id?** No / No (bump `GL_VERSION`).
- **Rollback:** `git revert` + Worker rollback.

---

## Phase 5: Re-Enable Flagged Features One by One (Each Behind Tests)

Each sub-phase ships independently only after meeting its graduation criteria in `SCOPE.md`:

### Step 5.1 — Re-enable Upload (`GL_FEATURES.upload = true`)
- **Goal:** Sanitize uploaded filenames (basename only, strip control chars), write via `emu.create_file("/" + safeName, data)` with a single-job lock, notify ONLY in `#persistStatus` (zero `serial0_send`).
- **Files touched:** `js/transfer.js`, `packs-config.js`.
- **Risk:** Low.
- **Tests added:** Upload with malicious filename (`a"; rm -rf /root; ".txt`) while `nano` is open → `serial0_send` spy = 0 bytes, file readable at `/mnt/host/...`, stripped on save, gone after reload.
- **R2 re-upload / new build id?** No / No (bump `GL_VERSION`).
- **Rollback:** Flip `GL_FEATURES.upload = false`.

### Step 5.2 — Real terminal resize via `virtio-console` (replaces fixed 80×24 cleanly)
- **Goal:** Switch guest console from `ttyS0` (`serial_console`) to `/dev/hvc0` (`virtio_console` in v86, verified in `libv86.js:159684,204262`), sending `emulator.bus.send("virtio-console0-resize", [cols, rows])` on container resize — **zero bytes injected into guest stdin**.
- **Files touched:** `tools/image/install.sh` (getty on `hvc0` + `console=hvc0`), `tools/image/save-state.js`, `js/boot.js`, `js/terminal.js`.
- **Risk:** Medium–High (requires disk image + snapshot rebuild → new `buildId` + R2 upload; coordinate with Upgrade Story below).
- **Tests added:** Resize while `nano` is open and while mid-typing → `stty size` matches grid, 0 stdin bytes injected, `nano` redraws cleanly.
- **R2 re-upload / new build id?** **Yes / Yes** (`upload-r2.sh` + new `buildId`).
- **Rollback:** Worker rollback to previous `buildId` (old chunks still in R2).

### Step 5.3 — Fix & re-enable Offline Packs (`GL_FEATURES.packs = true`, `BUG-19`, `BUG-20`, `BUG-21`)
- **Goal:**
  1. Fix infinite 2-tab `BroadcastChannel` loop (`emit({ broadcast: false })` inside `channel.onmessage`).
  2. Make `cancel()` await the active job promise so `removePack()` / `useMinimal()` cleanly wait for lock release before starting.
  3. Stop double-caching: add a header/query or bypass flag so `packs.js` fetches chunks straight to `GL_PACK_CACHE` without `sw.js` also duplicating them into `GL_DATA_CACHE` or firing `disk-activity`.
  4. Abort immediately on `QuotaExceededError` with a clear message; fix `"Removed null pack"` label; disable Save button while already saved or downloading; clarify `common ⊂ full` UI (e.g., show "Included in Full" when Full is saved).
- **Files touched:** `packs.js`, `sw.js`, `js/packs-ui.js`, `packs-config.js`.
- **Risk:** Medium.
- **Tests added:** 2-tab `BroadcastChannel` bounded-message test; un-awaited `removePack()` during active download; `QuotaExceededError` immediate abort; verify `GL_DATA_CACHE` gets 0 entries from pack install; offline `gcc` smoke test after installing `common`.
- **R2 re-upload / new build id?** No / No (bump `GL_VERSION`).
- **Rollback:** Flip `GL_FEATURES.packs = false`.

### Step 5.4 — Redesign & re-enable Download `/root` (`GL_FEATURES.download = true`, `BUG-04`)
- **Goal:** Replace `serial0_send("tar czf ...")` with a zero-stdin mechanism: run a tiny root-owned helper listening on a dedicated second serial port (`ttyS1`) or watching a trigger file in `/mnt/host` (created via `emu.create_file("/.export-req", ...)`!), which checks `du -sb /root` *before* tarring, writes to `.tmp`, atomically renames to `.ready` (eliminating the 500 ms truncation race), and removes it on ack. Enforce single-job lock and label accurately as `.tar.gz`.
- **Files touched:** `tools/image/install.sh` (or `save-state.js`), `js/transfer.js`, `packs-config.js`.
- **Risk:** Medium (if baked into image, combine with Step 5.2 to avoid a second `buildId` bump!).
- **Tests added:** Download `/root` while `nano` is open on a throttled link → `serial0_send` spy = 0 bytes, downloaded `.tar.gz` passes `tar -tzf`, empty `/root` succeeds, oversized `/root` rejected before `read_file`.
- **R2 re-upload / new build id?** Yes if bundled with Step 5.2; avoid doing a separate `buildId` bump just for this.
- **Rollback:** Flip `GL_FEATURES.download = false`.

### Step 5.5 — Fix & re-enable Per-Tool Indicator & Prefetch (`GL_FEATURES.diskIndicator`, `toolProgress`, `prefetch`, `BUG-30`)
- **Goal:** Content-hash pack/tool JSON names (`TODO.md`), replace 708 serial `caches.open`+`match` calls with one `cache.keys()` scan, load `tools.json` after SW control with retry, and test with `GL_PREFETCH = true` in a throttled smoke test.
- **Files touched:** `js/tool-progress.js`, `tools/image/build-pack-index.js`, `tools/deploy/upload-r2.sh`, `packs-config.js`.
- **Risk:** Low.
- **Tests added:** Unit test for `matchTool()`; throttled smoke test with `GL_PREFETCH = true` proving speedup and cap enforcement.
- **R2 re-upload / new build id?** R2 pack upload (`packs/<buildId>/`) only; **No new `buildId`**.
- **Rollback:** Flip `GL_FEATURES.prefetch = false` / `toolProgress = false`.

---

## Upgrade Story: What Happens to Users' Saved Files When You Ship a New Build?

There are **three distinct deploy types**, and users must know which ones preserve their files:

| Deploy Type | Changes `buildId`? | What Happens to User's Saved `/root` Files | Required Deploy Action |
|---|---|---|---|
| **1. Code / UI / SW / CSS deploy** (Phases 0, 1.1, 1.3, 2, 3, 4, 5.1, 5.3, 5.5) | **NO** | **100% PRESERVED.** `meta.buildId === GL_BUILD_ID`, so `state.gz` restores seamlessly onto the new app shell. | Bump `GL_VERSION` in `packs-config.js`; run `deploy-site.sh`. No R2 upload. |
| **2. Snapshot-only update** (e.g., Step 1.2 Option A: MOTD or `save-state.js` tweak without rebuilding `debian.img`) | **NO** | **100% PRESERVED** for returning users (they keep restoring their `state.gz`); new/Reset users get the updated snapshot. | Bump `GL_VERSION` (so `GL_DATA_CACHE` drops old cached snapshot); run `deploy-site.sh`. No R2 upload. |
| **3. Disk-image rebuild** (e.g., Step 5.2 `virtio-console` or apt package updates) | **YES** (new `buildId`) | **INCOMPATIBLE WITH OLD `state.gz`.** Because `state.gz` contains guest RAM + IDE write-back blocks keyed to old ext4 block offsets, restoring it onto the new disk would corrupt files (**INV-3**). | Upload new chunks to R2 (`upload-r2.sh`); **keep previous 3 builds in R2 for ≥7 days**; bump `GL_VERSION`; run `deploy-site.sh`. |

### Short-Term Policy (Now through Phase 4)
1. **Avoid changing `buildId` unless genuinely required** (use Option A in Step 1.2 so the stabilization launch preserves existing users' files!).
2. **Never silently corrupt or silently delete old `state.gz`:** When `meta.buildId !== GL_BUILD_ID`, `persist.js` refuses restore, keeps the old bytes untouched in OPFS (under `golinux/archive-<oldBuildId>.gz`), and displays a clear, honest message explaining that the OS image was updated and a fresh machine started.

### Medium-Term Permanent Fix (Phase 5.2 + 5.4 Combined)
Once the non-stdin `/root` export mechanism (Step 5.4) exists, **decouple user files from the VM snapshot**:
- Option 1 (simplest): When an old `state.gz` from `oldBuildId` is detected and `oldBuildId` chunks are still in R2 (within the retention window), offer a **"Recover files from previous version"** button that boots `oldBuildId` briefly in the background/recovery mode, exports `/root.tar.gz`, then imports it into `/mnt/host` of the new build.
- Option 2 (cleanest long-term): Store user files in a **small secondary ext4/9p virtual disk (`hdb` or OPFS-backed 9p `/root`)** mounted at `/root` separately from the read-only OS disk `hda`. Then OS image upgrades (`hda` `buildId` changes) **never** invalidate user files in `/root`! (Worth evaluating after Phase 5 stabilizes core.)
