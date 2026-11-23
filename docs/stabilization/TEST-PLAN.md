# GoLinux Test Plan

## 1. What Is Tested Today vs. What Is NOT (**VERIFIED**)

### Existing Tests

| File | What it tests | Known Blind Spots (**VERIFIED**) |
|---|---|---|
| `tools/image/verify-manifests.js` | `packs/index.json` snapshot size & chunk counts, `common.json`/`full.json`/`tools.json` chunk existence, `build-id.js --check`, `GL_VERSION` presence, `--deploy` non-empty `GL_BUILD_ID` & `GL_ASSET_ORIGIN`, no hardcoded cache names in `index.html`/`sw.js`. | Does **not** verify `chunks-precache.json` matches `manifest.json`; does **not** check hardcoded `v13` / build IDs in `tools/test/*`; does **not** check `public/_headers` syntax, `MEMORY_SIZE` agreement, or `install.sh` `TERM` consistency. |
| `tools/test/check-9p-state-shape.js` | Boots real v86 in Node, uploads 512 KiB via `create_file()`, verifies `fs9p.inodedata` / `inodes` / `get_state()[2]` shape and that `Go9p.install` strips bytes + direntries and restores `inodedata`. | Does **not** test calling `save_state()` twice after a failed validation (`BUG-17`). |
| `tools/test/sw-chunk-fallback.test.js` | Loads real `sw.js` + `packs-config.js` in Node Function shim; tests 404 empty → zeros, 404 real → 404 + `chunk-missing-real`, 500/offline → not zeros, versioned path GET/HEAD to asset origin, foreign-origin redirect, override persistence across SW restart, `disk-activity`, `idle:true`, cache-hit silence, throughput probe. | Asserts broken `503` + `chunk-missing-real` on offline real chunk (`BUG-09`); never tests missing `chunks-precache.json` (`BUG-10`); never checks `HEAD` upstream method (`BUG-11` — mock ignores method!); tests `?assets=` override on non-local host `app.test` (`BUG-06`); never tests `/packs/*.json` cache-control bypass (`BUG-07`). |
| `tools/test/packs.test.js` | Loads real `packs.js` in Node shim; tests `removePack` protection (`common`/`full`), `cancel` + `removePack`, idempotent Save, 2 jobs / 2 tabs lock refusal, `useMinimal` leaves data cache alone, reload partial state, `verify`, failed download cleanup. | Only 1 tab on `BroadcastChannel` (misses infinite 2-tab loop `BUG-19`); manually `await`s `install()` before `removePack()` (misses `BUG-20`); never tests `QuotaExceededError` abort (`BUG-21`) or SW double-caching into `GL_DATA_CACHE`. |
| `tools/test/ui-layout.test.js` | Headless Chrome CDP across 5 viewports against `.deploy-pages` (same-origin, no chunks): viewport fit, no page scroll, toolbar collapse <=760px, touch target size, keybar arrows/Esc/Tab/Enter/Backspace/Ctrl+sym, ResizeObserver refit. | Hardcodes macOS Chrome path (`:166`); tests `.deploy-pages` instead of current source; never tests `#persistStatus` overflow (`BUG-26`); never tests native keyboard input with `Ctrl`/`Alt` latched (`BUG-24`); no live guest. |
| `tools/test/smoke-deploy.test.js` | Production-like 2-origin test (staged `.deploy-pages` + local R2 mirror, throttled 1 MB/s) in headless Chrome: first load, cold `gcc` compile, disk indicator + `gcc` label, `TERM`/SMCUP, `nano` scrollback, `stty` resize + half-typed command, packs API calls, OPFS save + reload survival, network origin & build-id path assertions. | Hardcodes `"golinux-pack-v13"` and `"3a3a2a8af275cc11"` (`BUG-29`); forces `GL_PREFETCH = false`; asserts the broken `stty` injection; no `serial0_send` spy; no Reset or Restart click test; no offline test; no old-SW / old-OPFS upgrade test; Chrome-only. |
| `tools/test/measure-tool-load.js` | Benchmark harness (fast vs slow prefetch concurrency 0/4/8). | Not a pass/fail test; `downBps` comment says 4 Mbps while code uses `4 * 1024 * 1024` B/s (32 Mbps). |

### Completely Untested Today (**VERIFIED**)
- Zero `serial0_send` invariant enforcement (typing into `nano`/`vim`/half-typed line).
- Real Firefox (normal & private browsing), real WebKit/Safari, real iOS/Android phones.
- Persistence edge cases: offline `buildId=null` mismatch (`BUG-05`), `dirty` cleared mid-save (`BUG-14`), tab-hide while `!atPrompt` (`BUG-13`), Reset racing `pagehide` (`BUG-15`), OPFS `tmp.move` / `createWritable` portability (`BUG-16`), `meta.json` corruption.
- Upgrade flow: old SW (`v12`/`v13`) + old `state.gz` (`oldBuildId`) meeting a newly deployed build (both online and offline).
- Clicking **Restart** (`BUG-22`) and **Reset** in UI; `#fatal` Reload button (`BUG-23`).
- Offline real-chunk miss UX (`BUG-09`) and offline zeroed-chunk UX (`BUG-10`).
- Two-tab concurrent interaction (`BroadcastChannel` loop `BUG-19`, Web Locks ownership handoff).

---

## 2. Layered Test Architecture

Every automated test must obey three rules:
1. **Real assertions** (no console-only inspection).
2. **Non-zero exit code on failure** (suitable for one-command pre-deploy gate).
3. **Mutation check before trusting the test**: deliberately break the production code invariant, run the test, confirm it fails loudly with a clear message, then restore the file byte-identical (`git diff` empty).

### Layer 1: Pure Logic Unit Tests (Node, `< 2 s`, no browser)
Run on every edit (`node tools/test/unit.test.js`):
- `persist` build-id compatibility matrix: `(expectedBuildId, metaBuildId)` across match, mismatch, `null`, `""` — must allow restore **only** on exact non-empty match (or explicit dev mode).
- `persist` dirty-sequence counter: verify edits occurring *during* an async save keep `dirty` true after the save completes (`BUG-14`).
- `persist` Reset latch: verify `saveNow` is a hard no-op once Reset begins (`BUG-15`).
- `persist-9p.js` double-call after failed validation: verify save #2 still falls back safely instead of crashing (`BUG-17`).
- `keybar` modifier state machine (`applyModifiers`): `Ctrl`+`c`/`x`/`o`/`d`/`z`, `Alt`+`b`/`f`, uppercase/lowercase, one-shot disarm, double-tap disarm, `Esc` disarm — including for characters coming from native keyboard input (`BUG-24`).
- `packs` pure protection/diff logic + **2-tab `BroadcastChannel` bounded-message test** (`BUG-19`) + **un-awaited `removePack()` during active download** (`BUG-20`) + **`QuotaExceededError` immediate abort** (`BUG-21`).
- Static invariant checks:
  - No `serial0_send` outside allowed files (and zero in runtime page once `term.input` is used).
  - `public/_headers` parser check: fail if any block overrides `Cache-Control` without detaching `! Cache-Control`.
  - No hardcoded `golinux-*-v\d+` or 16-hex build IDs in `tools/test/`.

### Layer 2: Service Worker Harness Tests (`tools/test/sw-chunk-fallback.test.js`, Node, `< 3 s`)
Expand the existing shimmed-SW suite to assert:
- **INV-2 & INV-7:**
  - Real chunk `404` → HTTP `404` + posts `chunk-missing-real` (NOT zeros).
  - Real chunk network error (offline) → posts `chunk-offline` (NOT `chunk-missing-real`!) and does NOT return `503` (so v86 doesn't infinite-retry).
  - Empty chunk `404` → returns `empty-chunk.zst`, posts nothing.
  - Empty chunk offline → returns `empty-chunk.zst`, posts nothing (NOT `chunk-miss` banner!).
  - Missing/failed `chunks-precache.json` → `isEmptyChunkName()` returns `false` **and** retries on next call instead of caching `null` forever (`BUG-10`).
  - `chunks-precache.json` and `assets/empty-chunk.zst` are both install-critical in `SHELL_FILES`.
- **INV-8 & BUG-11:**
  - Chunk `HEAD` forwards upstream with `{ method: "HEAD" }` (assert `init.method === "HEAD"`).
  - `/packs/*.json` requests bypass `GL_SHELL_CACHE` (network-only/network-first; never cached forever).
- **INV-9:**
  - On non-localhost origin (`https://golinux.app`), `set-asset-base` is rejected and never persisted to `golinux-config`.
  - On `http://127.0.0.1:8090`, `set-asset-base` persists cleanly and does NOT race `assetBaseReady`.

### Layer 3: Production-Like Two-Origin Smoke + Invariant Tests (`tools/test/smoke-deploy.test.js`, ~45–90 s)
Keep the existing two-origin harness (reading `GL_VERSION` and `buildId` dynamically — zero hardcoding) and add three critical scenarios:

1. **`serial0_send` Invariant Spy Test (INV-1)**
   - Before `bootMachine()` (via CDP `Page.addScriptToEvaluateOnNewDocument` or Playwright `addInitScript`), wrap `V86.prototype.serial0_send`, `V86.prototype.serial_send_bytes`, and monitor `emulator.bus.send` for `"serial0-input"` / `"virtio-console0-input-bytes"` tagging every call with a stack trace and whether a trusted user event (`isTrusted` / keybar click) triggered it.
   - Drive: fresh boot → wait 3 s idle → resize viewport 3 times (desktop → phone → landscape) → save state → reload (restore) → wait 3 s idle → (when Upload enabled) upload a file named `a"; touch /root/PWNED; ".txt`.
   - **Assert:** `0` non-user bytes reached guest stdin; `/root/PWNED` does not exist; `nano` opened and resized receives zero injected characters.
   - **Mutation check:** Re-add `emulator.serial0_send("\n")` inside `emulator-loaded` → test exits non-zero → revert.

2. **Fresh Profile vs. Upgrade Test (INV-3 & INV-8)**
   - **Case A (Code-only upgrade, same `buildId`, bumped `GL_VERSION`):** Serve Build v1 (with marker `window.__APP_VER = "v1"`), boot, write `/root/keep.txt`, save. Swap server to Build v2 (same `buildId`, `GL_VERSION` bumped, `window.__APP_VER = "v2"`). Reload page.
     - **Assert:** Active page runs `v2`, old `golinux-shell-v1` cache is deleted, AND `/root/keep.txt` **survived**!
   - **Case B (Disk-image upgrade, new `buildId`, online AND offline):** Seed OPFS with `state.gz` + `meta.json` stamped `buildId: "0000000000000001"`. Load Build B (`buildId: <current>`) first **online**, then **offline** (CDP `Network.emulateNetworkConditions({ offline: true })`).
     - **Assert:** In **both** online and offline modes, old state is **NOT** restored (fresh snapshot boots), clear update message is shown, and no corrupt ELF/ext4 errors occur.
   - **Mutation check:** Restore `if (buildId && meta.buildId && meta.buildId !== buildId)` with `buildId = null` offline → Case B offline fails loudly → revert.

3. **Lifecycle Controls Test (INV-10)**
   - Click **Reset** while idle → reload → assert `/root/marker.txt` is gone (proves `BUG-15` fixed).
   - Click **Restart** (when enabled) → assert prompt returns and executes `echo ALIVE` (proves `BUG-22` fixed).
   - Disconnect network (offline) + run uncached `gcc --version` → assert `#offlineBanner` appears, `#fatal` does **NOT** appear, VM is **NOT** stopped (proves `BUG-09` fixed).

### Layer 4: Cross-Browser Matrix (Playwright: Chromium, Firefox, WebKit)

#### Can Playwright run on this Mac? (**VERIFIED**)
- **Current machine state (VERIFIED):** macOS with `Node v26.13.0`, `npm 11.20.0`, `Python 3.15.2`, `/Applications/Google Chrome.app`, `/Applications/Safari.app`. Neither `Firefox.app` nor `playwright` (`~/Library/Caches/ms-playwright`) is currently installed.
- **Feasibility (INFERRED from Playwright docs):** Yes — once approved in Phase 3, Playwright can be installed into a dev-only `tools/test/package.json` (keeping the production web root zero-dependency!) with `npx playwright install chromium firefox webkit`. All three engines run headlessly on macOS Apple Silicon.
- **Matrix to run before releases (and locally on persistence/SW/UI changes):**
  1. **Chromium** (normal + incognito/private context): full smoke + persistence + SW + keybar.
  2. **Firefox** (normal + private context): verify SW registration, OPFS persistence (or graceful fallback if `tmp.move` / private OPFS unavailable!), private-mode error handling, keyboard & keybar input.
  3. **WebKit (desktop)** (normal + ephemeral context): verify WASM boot, SW chunk proxying, `CompressionStream`/`DecompressionStream`, OPFS behavior (`createWritable` vs `createSyncAccessHandle`), CSS `dvh` layout, `PointerEvent` keybar taps.

#### What Desktop WebKit CAN and CANNOT Prove About Real iOS Safari (**INFERRED** from WebKit/iOS architecture)

| Desktop Playwright WebKit **CAN** prove | Desktop Playwright WebKit **CANNOT** prove (requires real iPhone) |
|---|---|
| WebKit JS engine (JSC) & WASM execution of v86 (`256 MB` RAM) | **iOS Jetsam memory kills** (~1–1.5 GB per-tab cap on iPhones with 4–6 GB RAM while running 256 MB v86 + gzip Worker + snapshot buffers) |
| WebKit Service Worker fetch/CacheStorage semantics & `importScripts` | **iOS Safari 7-day ITP storage eviction** (OPFS / CacheStorage wiped if user doesn't visit for 7 days unless added to Home Screen) |
| WebKit OPFS API availability (`createWritable`, `FileSystemFileHandle.move`, Worker `createSyncAccessHandle`) | **iOS soft keyboard & `visualViewport` behavior** (keyboard sliding up over `#keybar`, `interactive-widget=resizes-content` — currently ignored by iOS Safari!) |
| WebKit `CompressionStream("gzip")` / `Web Locks` / `BroadcastChannel` behavior | **iOS touch-focus user-gesture gate** (blocking `.focus()` inside `setTimeout` from `pointerdown`) and **`<16px` textarea auto-zoom** |
| Basic CSS flex + `dvh` rendering at 390×844 | **iOS Safari collapsing URL bar, safe-area insets (notch/home indicator), touch-callout, rubber-band scroll, lock/unlock/app-switch tab suspension** (killing async `visibilitychange` OPFS saves!) |

---

## 3. Automated vs. Manual Device Split

- **Machine-automated (must be 100% green before deploy):**
  - All Layer 1 unit tests, Layer 2 SW tests, `verify-manifests.js --deploy`, `check-9p-state-shape.js`, Layer 3 two-origin smoke + `serial0_send` spy + fresh-vs-upgrade tests, Layer 4 Playwright Chromium/Firefox/WebKit matrix.
- **Manual real-phone testing (required before every launch / UI / persistence / SW change):**
  - Real iPhone (iOS Safari + Home Screen PWA) and if available an Android phone (Chrome), on **cellular data** (not Wi-Fi) so real latency and carrier conditions apply.

---

## 4. Manual Real-Phone Checklist (5 Minutes Before Release)

Test on a real phone over **mobile data** against the deployed URL (or preview URL):

1. **First load & boot:** Open `https://golinux.app` in a fresh tab. Loading indicator appears, snapshot downloads, `root@golinux:~#` prompt appears cleanly with readable MOTD and **zero** stray commands or `stty` output.
2. **Focus & soft keyboard (iOS critical):** Tap anywhere in the terminal. Soft keyboard opens immediately on the **first tap**, the page does **not** zoom in, and `#keybar` stays visible and reachable above the keyboard.
3. **Typing & `Ctrl` latch:** Type `nano /root/phone.txt`, type `hello`, tap `Ctrl` on `#keybar` (highlights green), tap `o` on the **native phone keyboard** → nano saves (and `Ctrl` un-highlights). Tap `Ctrl` then `x` → nano exits cleanly with **zero** nano lines left in scrollback.
4. **Rotation & layout:** Rotate portrait → landscape → portrait while mid-typing `echo still_here` (do NOT press Enter). Verify the half-typed text is intact, zero `stty` junk appears, toolbar stays single-row (overflow `⋮` menu works), and the page itself never rubber-bands or scrolls.
5. **Persistence across lock/switch/kill:** Run `echo KEEP > /root/p.txt`. Lock the phone for 10 s, unlock, switch to another app and back, then **force-close the tab**, reopen `https://golinux.app`, and run `cat /root/p.txt` → prints `KEEP`.
6. **Reset:** Open `⋮` → **Reset** → confirm. After reload, `ls /root` shows `p.txt` is gone.
7. **Offline graceful degradation:** Turn on Airplane Mode. Run `ls` (cached/light) → works. Run an uncached heavy command (e.g. `g++ --version`) → shows the yellow **offline banner**, does **NOT** show "This version is out of date", and does **NOT** freeze the page chrome. Turn Airplane Mode off.
8. **Private browsing check:** Open `https://golinux.app` in iOS Safari Private Mode (and Firefox Private if available) → either boots cleanly with a clear "cannot save in private mode" notice OR shows `#fatal` with a working **Reload** button (never a silent infinite spinner).
