# GoLinux Bug Inventory (Grouped by Root Cause)

**Total distinct root causes: 9**  
**Total catalogued defects: 30** (Data loss: 10 · Hang: 6 · Wrong behaviour: 12 · Cosmetic: 2)

> **Live vs. Local legend:**
> - `live+local`: present in both `5761126` (older live baseline, **INFERRED**) and current working tree (**VERIFIED**).
> - `live-only`: present in `5761126`, fixed in local `4e13103` (**VERIFIED** in git; live status **INFERRED**).
> - `local-committed`: introduced in `4e13103` (`HEAD`), not yet deployed (**VERIFIED**).
> - `local-uncommitted`: in uncommitted working tree diff only (**VERIFIED**).

## Summary by Root Cause

| Root Cause | Defect Count | Highest Severity | Live or Local |
|---|---:|---|---|
| **RC-1:** Synthetic stdin injection (`serial0_send`) & 9p shell coupling | 4 | **Data loss** | live+local & local-uncommitted |
| **RC-2:** Multiple / uncoordinated sources of truth & split-brain caching | 4 | **Data loss** | live+local |
| **RC-3:** Service worker offline/404/error policy & precache gaps | 4 | **Hang / Data loss** | live+local & live-only |
| **RC-4:** Persistence lifecycle, concurrency, and OPFS portability flaws | 6 | **Data loss** | live+local |
| **RC-5:** Offline-packs job races, cross-tab broadcast loop, double-caching | 3 | **Hang / Wrong behaviour** | local-committed (and old bugs live) |
| **RC-6:** Broken VM lifecycle controls (Restart & fatal recovery) | 2 | **Hang** | live+local |
| **RC-7:** Mobile input latch, iOS focus/zoom, and toolbar overflow | 3 | **Wrong behaviour** | local-committed |
| **RC-8:** Build/deploy/rollback/test-harness gaps & silent fallbacks | 3 | **Wrong behaviour** | live+local & local-committed |
| **RC-9:** Half-finished uncommitted `TERM` / tool-set / prefetch races | 1 | **Wrong behaviour** | local-uncommitted & local-committed |

---

## RC-1: Synthetic stdin injection into guest serial console (`serial0_send`)

Writing commands into the interactive serial tty (`ttyS0`) violates isolation between browser chrome and guest stdin. Any program reading stdin (`nano`, `vim`, `less`, `passwd`, `python3`, or a half-typed bash line) consumes injected bytes as user input.

### `BUG-01` — Boot/restore injects `export TERM=...; clear; cat /etc/motd`
- **Severity:** Data loss / wrong behaviour
- **Status:** `live+local` (`export TERM=...` added in `local-uncommitted`) | **VERIFIED**
- **File & Line:** `index.html:1260-1267`, `index.html:1277-1291`; underlying `TERM` bug in `tools/image/install.sh:82,89`
- **Root Cause:** `install.sh` hardcodes `export TERM=vt102` in `/root/.bash_profile` and `/root/.bashrc`, overriding `getty` and `/etc/profile.d/term.sh`. `index.html` hacks around this and replays `/etc/motd` by injecting shell commands via `serial0_send` on every restore (including restored user sessions!).
- **How to Reproduce:** Run `cat > /root/note.txt` (or open `nano`), let a false-positive `atPrompt` save occur, or reload a restored session — boot types `export TERM=xterm-256color; clear; cat /etc/motd` directly into the restored session and clears the user's restored scrollback/screen.

### `BUG-02` — Terminal resize injects `stty -echo` / `stty rows cols` / `stty echo` / `Ctrl-L`
- **Severity:** Data loss / hang / wrong behaviour
- **Status:** `local-committed` (prompt guard added in `local-uncommitted`) | **VERIFIED**
- **File & Line:** `index.html:1643-1665`, `index.html:1762-1797`
- **Root Cause:** Because v86's `serial_console` has no resize sideband, `applyGrid()` types `stty -echo\n`, waits 90 ms, then types `stty rows R cols C 2>/dev/null\n`, `stty echo\n`, and `\x0c` (Ctrl-L) over `serial0_send`. The `watchShellPrompt()` guard checks `/[#$]\s*$/` on the last 600 serial bytes, which false-positives inside `nano`/`vim`/`less`/man pages (any `#` comment or `$` sign at end of drawn text), ignores mobile key-bar taps (only listens to `keydown`), and runs regex on every output byte.
- **How to Reproduce:** Open `nano` on a shell script containing `#`, then resize the browser window or rotate a phone. `stty -echo` + `stty rows ...` + `Ctrl-L` are typed directly into the open file buffer (corrupting the file). Typing during the 90 ms gap between `stty -echo` and `stty echo` or hitting an error can leave tty echo permanently disabled.

### `BUG-03` — Upload injects unsanitized `echo` into guest shell (command injection)
- **Severity:** Data loss / wrong behaviour (security/integrity)
- **Status:** `live+local` | **VERIFIED**
- **File & Line:** `index.html:1466-1468`
- **Root Cause:** After `emu.create_file("/" + file.name, data)`, `uploadFiles()` sends `` `echo "Uploaded ${file.name} -> ${UPLOAD_DIR}/${file.name}"; ...\n` `` via `serial0_send` with zero shell escaping and regardless of guest state.
- **How to Reproduce:** Upload a file named `test"; rm -rf /root; #.txt` (or drop any file while `nano` is open or a command is half-typed). In bash, the filename executes arbitrary commands; in `nano`, the `echo` line is pasted into the document.

### `BUG-04` — Download `/root` injects `tar`/`rm`, truncates archives, risks mobile OOM, has no lock
- **Severity:** Data loss / hang / wrong behaviour
- **Status:** `live+local` | **VERIFIED**
- **File & Line:** `index.html:1482-1574`, `index.html:235`
- **Root Cause:** (a) Sends `tar czf ...` (`:1510`) and `rm -f ...` (`:1570`) via `serial0_send`, corrupting editors or half-typed commands. (b) Detects completion by checking `d.byteLength === lastSize` across two 500 ms polls (`:1525-1535`): when `tar` pauses >500 ms waiting on disk chunk fetches or CPU, the page downloads a **truncated corrupt `.tar.gz`** and deletes it. (c) `d.byteLength <= 120` (`:1530`) rejects valid tiny archives (empty `/root`) and times out after 3 minutes. (d) `DOWNLOAD_LIMIT` (`:1548`) is checked *after* `tar` and `emu.read_file()` already allocated the entire archive in guest RAM + 9p RAM + JS heap (mobile OOM before the check) and returns early without deleting `/mnt/host/__dl-*.tar.gz`. (e) No in-flight lock prevents double-clicking Download. (f) Tooltip (`:235`) and function name say "zip", output is `.tar.gz`.
- **How to Reproduce:** Click `Download /root` while `nano` is open (types `tar czf...` into file); or click while `/root` has ~10 MB on a throttled link (500 ms pause triggers premature truncated download); or double-click Download rapidly.

---

## RC-2: Duplicated / uncoordinated sources of truth & split-brain caching

### `BUG-05` — Offline visit bypasses build-id check and restores mismatched saved state
- **Severity:** Data loss (silent filesystem corruption)
- **Status:** `live+local` | **VERIFIED**
- **File & Line:** `persist.js:100-109`, `persist.js:285-303`; `sw.js:458-461`; `packs-config.js:101`
- **Root Cause:** `persist.js` ignores `GL_BUILD_ID` (stamped into `packs-config.js`) and instead fetches `images/build-id.json`. When offline, `sw.js:460` answers with `{}` → `loadBuildId()` returns `null`. `loadUserState()` checks `if (buildId && meta.buildId && meta.buildId !== buildId)` (`persist.js:291`), which evaluates to **false** whenever `buildId` or `meta.buildId` is `null`. A saved state from an older disk build is restored onto a new disk image (corrupt ext4/ELF reads), AND the next offline save overwrites `meta.buildId = null`, permanently disabling future mismatch checks too!
- **How to Reproduce:** Save state on Build A. Update app to Build B (new `GL_BUILD_ID`). Go offline and reload. `images/build-id.json` returns `{}` → `buildId === null` → Build A's `state.gz` is restored onto Build B's disk chunks.

### `BUG-06` — `?assets=` override works in production, persists forever in SW, and races startup
- **Severity:** Wrong behaviour (persistent origin hijack / split-brain)
- **Status:** `local-committed` (`GL_CONFIG_CACHE` added in `4e13103`; `?assets=` unguarded in `live+local`) | **VERIFIED**
- **File & Line:** `packs-config.js:32-53`; `sw.js:54-66`, `sw.js:109-124`
- **Root Cause:** `packs-config.js:34-42` applies `?assets=<url>` and saves it to `localStorage` **without** checking `isLocal`. The page then calls `pushAssetBase()` (`index.html:1318-1325`), which tells `sw.js` to persist it into `golinux-config` CacheStorage (`sw.js:114-117`). Neither `sw.js:57-66` nor `sw.js:110` checks localhost! On later visits to `https://golinux.app/` (no query string), the page uses `GL_ASSET_ORIGIN` (`https://assets.golinux.app`) while the SW restores the poisoned override from `golinux-config` forever. Separately, `assetBaseReady` (`sw.js:57`) resolves asynchronously and can overwrite a newer `set-asset-base` message that arrived during SW startup.
- **How to Reproduce:** Open `https://golinux.app/?assets=http://127.0.0.1:9999`, wait for SW control, then navigate to `https://golinux.app/`. Every chunk fetch fails because SW keeps forwarding to `127.0.0.1:9999` while `index.html` shows no error about the override.

### `BUG-07` — Stale app shell, cached `/packs/*.json`, and broken concatenated `_headers`
- **Severity:** Wrong behaviour (stale code / stale pack lists in production)
- **Status:** `live+local` | **VERIFIED**
- **File & Line:** `sw.js:321`, `sw.js:480-488`; `public/_headers:3-18,33-65`; `DEPLOYMENT.md:232`
- **Root Cause:** Three compounding caching errors:
  1. `sw.js:480-488` serves `GL_SHELL_CACHE` **cache-first** for all non-chunk requests. `DEPLOYMENT.md:232` does not require bumping `GL_VERSION` on code deploys; if `sw.js` itself is unchanged byte-for-byte, browsers never re-run SW `install`, leaving returning users on stale `index.html`/JS forever.
  2. `sw.js:321` lets cross-origin `/packs/` requests enter the fetch handler, where none of the specialized branches match, so they fall through to `sw.js:480` and get cached **cache-first forever in `GL_SHELL_CACHE`** — defeating `{ cache: "no-store" }` in `packs.js:56,68` and `index.html:896`!
  3. `public/_headers:3-6` documents that Cloudflare joins duplicate headers unless detached with `!`, yet `public/_headers:14` sets `Cache-Control` on `/*` and every narrower block (`/sw.js`, `/images/build-id.json`, `/assets/v86/v86.wasm`, etc.) sets `Cache-Control` **without** `! Cache-Control`, producing conflicting joined headers (e.g. `public, max-age=0, must-revalidate, public, max-age=31536000, immutable` and `public, max-age=0, must-revalidate, no-cache, no-store, must-revalidate`) (**INFERRED** per Cloudflare `_headers` spec cited in file's own header).
- **How to Reproduce:** Deploy a change to `index.html` without editing `sw.js` or bumping `GL_VERSION`: returning browser loads old `index.html` from `GL_SHELL_CACHE`. Re-upload `packs/<id>/tools.json`: SW returns the old copy from `GL_SHELL_CACHE` even though `index.html` passed `{ cache: "no-store" }`.

### `BUG-08` — Dead/drifted config, unused precached script, and misleading snapshot build-id comment
- **Severity:** Cosmetic / maintenance hazard
- **Status:** `live+local` | **VERIFIED**
- **File & Line:** `packs-config.js:134` (`GL_PACK_KEY`); `index.html:397` & `sw.js:31` (`addon-fit.js`); `index.html:1602,1667` (duplicate `currentTerminal()`); `public/_headers:43` (`PL_VERSION`); `persist-9p.js:145` (`__pl9pWrapped`); `tools/image/build-snapshot.sh:52`
- **Root Cause:** Rapid iteration left unused code and contradictory comments: `addon-fit.js` is precached and loaded on every visit despite never being referenced; `build-snapshot.sh:52` runs `build-id.js` claiming "invalidates saved user states" even though `build-id.js:16-20` explicitly excludes the snapshot from the hash (so snapshot-only changes do *not* change `buildId` and `sw.js` keeps serving the old cached snapshot from `GL_DATA_CACHE`!).
- **How to Reproduce:** Run `tools/image/build-snapshot.sh` after changing `/etc/motd` in `save-state.js`: `images/build-id.json` keeps the exact same `buildId`, and returning clients keep booting the cached old snapshot from `GL_DATA_CACHE`.

---

## RC-3: Service worker offline/404/error policy & precache gaps

### `BUG-09` — Offline real-chunk miss kills VM as "out of date" AND loops forever on 503; empty-chunk offline miss shows false error banner
- **Severity:** Hang / data loss / wrong behaviour
- **Status:** `live+local` | **VERIFIED** (v86 retry loop verified in `assets/v86/libv86.js:2950-4200`)
- **File & Line:** `sw.js:423-451`; `index.html:1094-1110`; `assets/v86/libv86.js:2950-4200`
- **Root Cause:** In `sw.js`'s `catch (e)` (network failure / offline):
  1. When `knownEmpty === false` (real chunk uncached offline), `sw.js:438` posts `chunk-missing-real` (the same event used for a 404 stale build!). `index.html:1100-1109` displays a fatal **"This version is out of date — Reload"** overlay and calls **`emulator.stop()`**, terminating the user's offline session instead of showing `#offlineBanner`!
  2. `sw.js:450` returns HTTP **503**. In `libv86.js:4050`, `500 <= e.status && 600 > e.status` triggers `d()`, an **unbounded Fibonacci retry loop** (1s..34s forever) that continues firing even after `emulator.stop()`.
  3. Conversely, when `knownEmpty === true` (zeroed region offline), `sw.js:438` posts `chunk-miss` (showing `#offlineBanner` claiming "programs may fail") even though line `448` immediately returns the valid `empty-chunk.zst`!
- **How to Reproduce:** Load GoLinux online, disconnect network, run `gcc --version` (uncached real chunk). Screen locks up with fatal "This version is out of date" and stops the emulator while v86 keeps retrying 503s in the background.

### `BUG-10` — `chunks-precache.json` not precached & `loadRealChunks()` caches failures forever
- **Severity:** Hang / wrong behaviour
- **Status:** `live+local` | **VERIFIED**
- **File & Line:** `sw.js:18-40`, `sw.js:133-161`
- **Root Cause:** `chunks-precache.json` is omitted from `SHELL_FILES`, so it is unavailable offline. Worse, `loadRealChunks()` stores the promise in `realChunkPromise` and never clears it when `fetch()` fails or returns non-200 (`sw.js:137-149`). After a single failure (offline start or transient hiccup), `isEmptyChunkName()` returns `false` **forever** until the SW restarts — turning every zeroed-chunk 404 into a fatal `chunk-missing-real` crash!
- **How to Reproduce:** Open GoLinux offline (or block `chunks-precache.json` once, then unblock), trigger any zeroed-chunk read → `isEmptyChunkName()` returns `false` forever → fatal "This version is out of date" stop.

### `BUG-11` — Chunk `HEAD` proxy issues a full `GET` and bypasses cache
- **Severity:** Wrong behaviour (wasted bandwidth)
- **Status:** `local-committed` | **VERIFIED**
- **File & Line:** `sw.js:328-343`, `sw.js:164-178`
- **Root Cause:** `sw.js:333-337` constructs `upstream = GL_ASSET_BASE + url.pathname` (a string) and calls `fetch(upstream)` without `{ method: "HEAD" }`, which defaults to HTTP `GET` and downloads the entire chunk body. Also `headFromCache()` returns no `Content-Length` if the cached response lacked that header.
- **How to Reproduce:** Issue `fetch("/images/debian-chunks/<id>/chunk-0-131072.zst", { method: "HEAD" })` from DevTools; inspect asset-origin log — method is `GET`, full body downloaded.

### `BUG-12` — Production `CHUNK_RE` mismatch, unstaged `chunks-precache.json`, and non-critical `empty-chunk.zst` precache
- **Severity:** Hang (total boot/disk failure in production)
- **Status:** `live-only` for `CHUNK_RE` & staging (`5761126` → fixed in `4e13103`); `live+local` for `sw.js:85` | **VERIFIED** in git
- **File & Line:** `5761126:sw.js:43`; `5761126:tools/deploy/build-pages.sh`; current `sw.js:85,411-414`
- **Root Cause:** In `5761126`, `CHUNK_RE` only matched flat `/debian-chunks/chunk-*.zst` (failing on `/<buildId>/`) and `build-pages.sh` did not copy `chunks-precache.json`. In current `sw.js:85`, `empty-chunk.zst` is explicitly exempted from install failure — if precaching `empty-chunk.zst` fails, every subsequent empty-chunk 404 misses `shell.match(GL_EMPTY_CHUNK_PATH)` (`sw.js:412`) and falls through to fatal `chunk-missing-real`!
- **How to Reproduce:** Fail the `assets/empty-chunk.zst` request during SW install (SW install still succeeds); then read any zeroed chunk → fatal "out of date".

---

## RC-4: Persistence lifecycle, concurrency, and cross-browser OPFS fragility

### `BUG-13` — Tab hide/close drops saves whenever `!atPrompt` or async gzip/OPFS doesn't finish
- **Severity:** Data loss
- **Status:** `live+local` | **VERIFIED**
- **File & Line:** `persist.js:190-196`, `persist.js:402-406`, `persist.js:432-436`
- **Root Cause:** `saveNow(emulator, "hide")` and `saveNow(emulator, "unload")` refuse to save if `!atPrompt` (setting `pendingSave = true` as the tab is closing!). Any user editing in `nano`/`vim`, running a REPL (`>>>`), using a custom PS1, or closing the tab within 500 ms of output loses all unsaved changes since the last 30 s autosave. Even when `atPrompt === true`, `save_state()` (~160 ms) + Worker gzip (~600 ms) + async OPFS write (~100 ms) cannot reliably complete in `pagehide` (**INFERRED** from browser page lifecycle).
- **How to Reproduce:** Open `nano /root/foo.txt`, save (`Ctrl-O`, `Enter`), leave `nano` open (or run `python3`), and close the tab → `atPrompt` is `false` → `visibilitychange`/`pagehide` refuses to save → `/root/foo.txt` is lost on reopen.

### `BUG-14` — `dirty = false` cleared *after* async save, dropping edits made during save
- **Severity:** Data loss
- **Status:** `live+local` | **VERIFIED**
- **File & Line:** `persist.js:202-242`
- **Root Cause:** `save_state()` snapshots state at `t = 0`, then gzip + OPFS write run asynchronously (~700–1500 ms). Any user keypress or guest output during that window sets `dirty = true`, and then line `242` unconditionally executes `dirty = false` — so subsequent 30 s autosaves skip the new edits until the user types again!
- **How to Reproduce:** Trigger autosave, immediately type a command during the ~700 ms gzip window, wait 60 s without typing further, force-close browser → changes made during gzip were never saved because `dirty` was reset to `false`.

### `BUG-15` — Reset races with in-flight autosave and `pagehide` save
- **Severity:** Data loss / wrong behaviour (Reset fails to reset)
- **Status:** `live+local` | **VERIFIED**
- **File & Line:** `index.html:1134-1144`; `persist.js:321-329`, `persist.js:432-436`
- **Root Cause:** `clearUserState()` does not acquire the `golinux-state` Web Lock and does not set a "resetting" flag to disable `saveNow()`. When `location.reload()` runs immediately after `clearUserState()`, the `pagehide` listener (`persist.js:436`) invokes `saveNow(emulator, "unload")`, and any in-flight autosave can finish writing `state.gz` right after `removeEntry()`!
- **How to Reproduce:** Click `Reset` while at an idle prompt (or while an autosave is mid-gzip). If `saveNow("unload")` or the in-flight write lands before reload tears down OPFS handles, the old session reappears after reload.

### `BUG-16` — Non-atomic `meta.json`, unhandled gzip Worker crash, and Safari/Firefox OPFS incompatibility
- **Severity:** Data loss / hang
- **Status:** `live+local` | **VERIFIED** (`meta.json` & worker); **INFERRED** (Safari/Firefox OPFS APIs)
- **File & Line:** `persist.js:81-87` (`writeMeta`), `persist.js:117-149` (`gzipWorker`), `persist.js:225-229` (`createWritable` / `tmp.move`)
- **Root Cause:**
  1. `writeMeta()` writes `meta.json` directly via `createWritable()` (not temp+move); a crash mid-write leaves a 0-byte `meta.json`, causing `readMeta()` to return `null` and silently discarding `state.gz`.
  2. `gzipWorker` attaches no `onerror` handler; if the worker OOMs or throws, `gzipPending` never settles and `saveInFlight` stays `true` forever, silently stopping all future saves.
  3. `FileSystemFileHandle.prototype.move()` (`persist.js:229`) and main-thread `createWritable()` on OPFS have patchy support in WebKit/Safari and Firefox (Safari historically requires `createSyncAccessHandle()` inside a Worker and lacked `.move()`) (**INFERRED** — untested in Firefox/WebKit).
- **How to Reproduce:** Kill/error the gzip Blob Worker (or test in Safari/Firefox where `tmp.move` throws `TypeError: tmp.move is not a function`) → every save fails or hangs permanently.

### `BUG-17` — `persist-9p.js` crashes every save after #1 if v86 shape validation fails
- **Severity:** Data loss (breaks all saves after v86 upgrade)
- **Status:** `live+local` | **VERIFIED**
- **File & Line:** `persist-9p.js:154-168`
- **Root Cause:** Line `155` sets `validated = true` *before* calling `assertV86StateShape(fs)`. If validation throws on save #1, it logs an error and safely falls back to `original()`. On save #2, `validated` is already `true`, so validation is skipped and `withEmptyShare(fs, ...)` runs against the incompatible `fs` object and throws, breaking every save thereafter.
- **How to Reproduce:** Mutate `emulator.fs9p.inodes[0].direntries = null` and call `save_state()` twice: call #1 falls back cleanly, call #2 throws or fails to strip safely.

### `BUG-18` — Disk-image upgrade orphans user files in OPFS with no export path
- **Severity:** Data loss (user-visible on every image update)
- **Status:** `live+local` | **VERIFIED**
- **File & Line:** `persist.js:291-302`
- **Root Cause:** User files live exclusively inside v86's IDE write-back block cache serialized in `state.gz`. Because `state.gz` is tied to exact disk block offsets (`buildId`), shipping a rebuilt disk image forces `loadUserState()` to reject `state.gz`. Users have no way to extract files from the rejected `state.gz` once the new build is live.
- **How to Reproduce:** Create `/root/work.c`, save, deploy a new disk image (`buildId` changes), reload → warning banner appears, fresh machine starts, `/root/work.c` is unreachable.

---

## RC-5: Offline-packs job races, cross-tab broadcast loop, and double-caching

### `BUG-19` — Infinite two-tab `BroadcastChannel` ping-pong loop (100% CPU/cache thrash)
- **Severity:** Hang / severe performance degradation
- **Status:** `local-committed` | **VERIFIED**
- **File & Line:** `packs.js:105-111`, `packs.js:342-344`; dead channel in `index.html:636-642`
- **Root Cause:** `emit()` posts `{ type: "state" }` on `BroadcastChannel("golinux-packs")`. The receiver `channel.onmessage = () => { if (!job) emit(); }` calls `emit()` right back, which posts `{ type: "state" }` back to the first tab! With 2 tabs open, both tabs ping-pong forever, calling `cache.keys()` over up to 5,600 entries nonstop. Meanwhile `index.html:637` listens on `"golinux-packs-ui"`, which nothing ever posts to.
- **How to Reproduce:** Open two tabs of the local build (`4e13103`), open the Packs dialog in Tab 1 (or trigger any pack action). Watch DevTools Performance / console: `packStates()` + `postMessage` loop infinitely in both tabs.

### `BUG-20` — Cancel-then-Remove and Use Minimal during download ALWAYS fail ("refused")
- **Severity:** Wrong behaviour
- **Status:** `local-committed` | **VERIFIED**
- **File & Line:** `packs.js:115-136`, `packs.js:306-330`; `index.html:674-678`
- **Root Cause:** `removePack()` and `useMinimal()` call `cancel()` synchronously (which only aborts fetches; `runJob`'s `finally { job = null; }` hasn't run yet and the Web Lock is still held), then immediately call `withJob(...)` which sees `if (job)` truthy and returns `{ refused: true, reason: "Another pack job is already running." }`. `packs.test.js:259-263` hid this by manually calling `packs.cancel(); await p;` before `removePack()`.
- **How to Reproduce:** Start downloading `full` pack in the UI, then click `Cancel`/`Remove` on `full` (or `Use` on `minimal`) while downloading → status displays `"Another pack job is already running."` and removal never happens.

### `BUG-21` — Pack downloads double-cache chunks, swallow quota errors, mislabel removal, and mishandle partial `full`
- **Severity:** Wrong behaviour (plus storage exhaustion)
- **Status:** `local-committed` (old `packs.js` in `5761126` had `localStorage` drift, no lock, and shared-cache deletion) | **VERIFIED**
- **File & Line:** `packs.js:202-218`, `packs.js:252-272`; `sw.js:321,361,394`; `index.html:568-571,689-693`
- **Root Cause:**
  1. **Double caching:** `packs.js:202` fetches `glChunkUrl(name)`. `sw.js:321` intercepts cross-origin `/debian-chunks/` requests, fetches from R2, caches the chunk in `GL_DATA_CACHE` (`sw.js:394`) AND fires `disk-activity`/`maybePrefetch`; then `packs.js:207` stores a second copy in `GL_PACK_CACHE` (468 MB stored for a 234 MB `full` pack!).
  2. **Quota swallow:** `packs.js:211-214` catches `QuotaExceededError` (and HTTP 500/404) per chunk and keeps looping through all 5,600 chunks, burning mobile data while failing every `cache.put`.
  3. **Partial-pack deletion & no-op UX:** `protectedNames()` (`packs.js:264`) only protects *complete* packs, so removing `common` deletes 701 chunks from a partially downloaded `full` pack; when `full` IS complete, removing `common` deletes 0 chunks and `common` remains "saved".
  4. **Broken status text & buttons:** `index.html:690` checks `removeId === "minimal"` when `useMinimal()` was triggered via `installId === "minimal"` (`removeId` is `null`), printing `"Removed null pack (701 chunks; shared chunks kept)."`. Also `saveBtn` stays enabled on a currently downloading or already saved pack (`index.html:568`).
- **How to Reproduce:** Install `common`, then click `Use` on `Minimal` → prints `"Removed null pack (...)"` and leaves all 701 chunks still sitting in `GL_DATA_CACHE`!

---

## RC-6: Broken VM lifecycle controls (Restart & fatal recovery)

### `BUG-22` — Clicking "Restart" permanently hangs the VM at SeaBIOS
- **Severity:** Hang
- **Status:** `live+local` | **VERIFIED** (confirmed in `assets/v86/libv86.js:165060,176090` and `tools/image/build.sh:49-63`)
- **File & Line:** `index.html:1220-1227`, `index.html:1298`; `tools/image/build.sh:49-63`
- **Root Cause:** `#restart` calls `window.emulator.restart()` → `cpu.reboot_internal()`, performing a SeaBIOS reboot. Because snapshot boots omit `options.bzimage` and `options.initrd` (`index.html:1220-1227`) and `debian.img` is an unpartitioned ext4 image with no bootloader, SeaBIOS has nothing to boot.
- **How to Reproduce:** Load GoLinux normally (from snapshot), click **Restart** in the top bar → terminal freezes permanently (no prompt ever returns).

### `BUG-23` — Fatal overlay asks user to reload but renders no Reload button
- **Severity:** Cosmetic / UX dead-end
- **Status:** `live+local` | **VERIFIED**
- **File & Line:** `index.html:119`, `index.html:380-389`, `index.html:1100-1105`
- **Root Cause:** CSS styles `#fatal .fatal-hint button` and text says `"Reload the page"`, but the markup in `#fatal` has no `<button>`. In PWA standalone mode (`manifest.json:7`), there is no browser reload button.
- **How to Reproduce:** Trigger any `showFatal(...)` state in standalone PWA mode — user has no button to reload.

---

## RC-7: Mobile input latch, iOS focus/zoom, and toolbar overflow

### `BUG-24` — One-shot `Ctrl` / `Alt` latch ignores native keyboard typing
- **Severity:** Wrong behaviour (mobile editors unusable)
- **Status:** `local-committed` | **VERIFIED**
- **File & Line:** `index.html:1867-1987`
- **Root Cause:** `applyModifiers()` is only called inside `handleKeyButton()` for `data-sym` buttons (`index.html:1982-1985`). Neither `term.onData` nor `keydown`/`beforeinput` checks `latchedCtrl` or `latchedAlt`. Tapping `Ctrl` then typing `o`, `w`, `d`, `r`, `a`, `e` on the phone's keyboard sends plain letters and leaves `Ctrl` latched.
- **How to Reproduce:** On a phone (or Chrome mobile emulation), tap `Ctrl` in `#keybar`, then type `d` or `o` on the keyboard. Plain `d`/`o` reaches the guest; `Ctrl` stays highlighted.

### `BUG-25` — iOS Safari soft-keyboard focus block and `<16px` auto-zoom
- **Severity:** Wrong behaviour (mobile Safari unusable)
- **Status:** `local-committed` | **INFERRED** (from iOS WebKit focus/zoom rules; untested on real iPhone)
- **File & Line:** `index.html:20`, `index.html:65-69`, `index.html:2003-2011`
- **Root Cause:** `setupTerminalFocus()` calls `term.focus()` inside `setTimeout(..., 0)` from `pointerdown`, losing iOS Safari's synchronous user-gesture context required to raise the soft keyboard. Additionally, `.xterm-helper-textarea` inherits `13px` font size (`index.html:20`); iOS Safari zooms the viewport on focusing `<textarea>` with computed font-size `< 16px`.
- **How to Reproduce:** Open on real iOS Safari and tap the terminal area.

### `BUG-26` — Long `#persistStatus` messages overflow `#bar` on narrow screens
- **Severity:** Cosmetic / layout break
- **Status:** `local-committed` | **VERIFIED**
- **File & Line:** `index.html:34-50`, `index.html:216-219`, `index.html:250`
- **Root Cause:** `#persistStatus` is a flex child of `#bar` with no `flex-shrink`, `min-width: 0`, `overflow: hidden`, or narrow-screen relocation. Long messages from `persist.js:210-215` or `index.html:1470` push `#bar` past viewport width. `ui-layout.test.js` only measures `#bar` when `#persistStatus` is empty.
- **How to Reproduce:** Resize to `390×844` and set `#persistStatus.textContent` to any persistence warning → `#bar` overflows horizontally.

---

## RC-8: Build, deploy, rollback, and test-harness gaps & silent fallbacks

### `BUG-27` — Documented CLI rollback (`stamp-build-id.sh` + `deploy-site.sh`) silently deploys the wrong build
- **Severity:** Wrong behaviour (failed emergency rollback)
- **Status:** `local-committed` | **VERIFIED**
- **File & Line:** `DEPLOYMENT.md:249-250`; `tools/deploy/stamp-build-id.sh`; `tools/deploy/build-pages.sh:41,85-94`
- **Root Cause:** `DEPLOYMENT.md` instructs rolling back via `./tools/deploy/stamp-build-id.sh <prev-id>` followed by `./tools/deploy/deploy-site.sh`. However, `deploy-site.sh` runs `build-pages.sh`, which ignores root `packs-config.js`'s `GL_BUILD_ID` and unconditionally overwrites `.deploy-pages/packs-config.js` with `images/build-id.json` (the *current* build ID), while leaving root `packs-config.js` dirtied!
- **How to Reproduce:** Run `./tools/deploy/stamp-build-id.sh 0000000000000000` then `./tools/deploy/build-pages.sh`: `.deploy-pages/packs-config.js` still gets `3a3a2a8af275cc11` from `images/build-id.json`.

### `BUG-28` — Stale `/tmp` image caches, silent error catches, wrong R2 source dir, macOS `date +%s%N`, and 24.2/25 MiB initrd ceiling
- **Severity:** Wrong behaviour (corrupt manifests/packs on rebuild; brittle deploy checks)
- **Status:** `live+local` & `local-committed` | **VERIFIED**
- **File & Line:** `tools/image/build-packs.js:81-91`; `tools/image/build-tool-sets.js:73-77,101-109,258`; `tools/image/build-pack-index.js:29`; `tools/deploy/upload-r2.sh:75-86`; `tools/deploy/deploy-site.sh:136,142-151`; `images/debian-initrd` (25,351,093 B)
- **Root Cause:**
  1. `build-packs.js` and `build-tool-sets.js` reuse `/tmp/golinux-*-recording.img` and `/tmp/golinux-tools-state.bin` if they exist, silently recording against stale prior builds!
  2. `build-pack-index.js:29` and `build-tool-sets.js:258` wrap `statSync` in `catch { return sum; }`, silently counting missing chunks as 0 bytes.
  3. `upload-r2.sh:80` copies from flat `images/debian-chunks/` instead of `images/debian-chunks/$BUILD_ID/`, and does not run `verify-manifests.js`.
  4. `deploy-site.sh:136` uses GNU `date +%s%N` (on macOS BSD `date`, `%N` outputs literal `N`), and live checks don't verify `GL_BUILD_ID` in live `packs-config.js` or `index.html` hash.
  5. `images/debian-initrd` is `24.18 MiB`, only ~860 KiB below Cloudflare Workers' hard 25 MiB per-file limit (`build-pages.sh:27`).
- **How to Reproduce:** Rebuild `images/debian.img` and run `node tools/image/build-packs.js common` on the same day without rebooting macOS → reuses stale `/tmp/golinux-pack-recording.img`.

### `BUG-29` — Broken two-origin dev server & hardcoded/blind test suites
- **Severity:** Wrong behaviour (tests give false confidence)
- **Status:** `live+local` & `local-committed` | **VERIFIED**
- **File & Line:** `tools/dev/serve-two-origins.py:23,68`; `tools/test/smoke-deploy.test.js:647,662,664,670,768,866,874,876`; `tools/test/ui-layout.test.js:154,166`; `tools/test/packs.test.js:80-88,259-263`
- **Root Cause:**
  1. `serve-two-origins.py:23` includes `""` in `APP_PREFIXES`; `path.startswith("")` is always true, so the app origin serves chunks and packs too!
  2. `smoke-deploy.test.js` hardcodes `"golinux-pack-v13"` and `"3a3a2a8af275cc11"`, disables `GL_PREFETCH`, and enforces the buggy `stty` resize injection.
  3. `ui-layout.test.js` hardcodes macOS Chrome path, tests stale `.deploy-pages` without chunks, and never tests native keyboard input with `Ctrl` latched or populated `#persistStatus`.
  4. `packs.test.js` only instantiates one tab (hiding `BUG-19`) and manually awaits `install()` before `removePack()` (hiding `BUG-20`).
  5. Zero automated coverage for Firefox, WebKit, private browsing, or old-SW/old-state upgrades.
- **How to Reproduce:** Request `http://127.0.0.1:8090/images/debian-chunks/chunk-0-131072.zst` against `serve-two-origins.py` → returns `200` instead of `404`.

---

## RC-9: Half-finished uncommitted `TERM` fix & tool-set / prefetch inefficiencies

### `BUG-30` — Contradictory `install.sh` `TERM`, unretried early `loadToolSets()`, and 708-call main-thread cache-probe storm
- **Severity:** Wrong behaviour / UI hitch
- **Status:** `local-uncommitted` (`install.sh`) & `local-committed` (`loadToolSets`/`measureToolCached`/`maybePrefetch`) | **VERIFIED**
- **File & Line:** `tools/image/install.sh:60,69,82,89`; `index.html:892-910`, `index.html:958-975`, `index.html:1055-1062`, `index.html:2061`
- **Root Cause:**
  1. `install.sh:82,89` still writes `export TERM=vt102` into `/root/.bash_profile` and `/root/.bashrc`, completely negating the uncommitted edits on lines 60 and 69.
  2. `loadToolSets()` runs at line `2061` *before* `prepareChunkAccess()` finishes and caches a failed promise (`null`) forever (`:893`).
  3. `measureToolCached()` (`:958-975`) calls `caches.open` + `c.match` sequentially inside a loop over `s.list` × 2 caches (up to 708 IPC round-trips for `g++`), and `maybePrefetch()` repeats the same per-chunk `caches.open` + `c.match` pattern instead of one `cache.keys()` scan.
- **How to Reproduce:** Rebuild image with current `install.sh` and boot without `index.html`'s `serial0_send` hack → `echo $TERM` prints `vt102`. Trigger `g++` cold load → 708 sequential CacheStorage IPC lookups fire on the main thread.
