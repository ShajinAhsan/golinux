# GoLinux Launch Scope Proposal

**Guiding principle:** Launch a small, rock-solid machine where **zero data is lost**, **nothing hangs**, and **nothing types into the guest behind the user's back**. Hide unstable convenience features behind explicit compile-free constants (`GL_FEATURES` in `packs-config.js`) and graduate them back one by one only when their tests and invariants pass.

```js
// Proposed single feature-flag object in packs-config.js
const GL_FEATURES = Object.freeze({
  packs: false,
  diskIndicator: false,
  toolProgress: false,
  prefetch: false,
  upload: false,
  download: false,
  restartButton: false, // until safe snapshot-reload replaces emulator.restart()
});
```

---

## Feature-by-Feature Classification

| Feature | Classification | Evidence & Rationale (**VERIFIED** unless noted) |
|---|---|---|
| **Boot from shipped snapshot** (with cold-boot fallback) | **CORE** | The core value proposition. Works reliably once `sw.js` (`BUG-07`, `BUG-09`, `BUG-10`, `BUG-12`) and `serial0_send` boot injection (`BUG-01`) are fixed. |
| **Terminal typing + responsive layout (fixed 80×24 or non-injecting fit)** | **CORE** | Full-viewport flex layout + toolbar overflow menu are safe once `#persistStatus` overflow (`BUG-26`) and iOS focus/zoom (`BUG-25`, **INFERRED**) are fixed. Keep terminal columns/rows clean **without** `stty` injection until `virtio-console` lands. |
| **Mobile on-screen key bar** (`Ctrl`, `Alt`, `Esc`, `Tab`, arrows, `Enter`, `Backspace`, `⌨`) | **CORE** | Essential for phones, but **must fix `BUG-24` first** (hook `latchedCtrl`/`latchedAlt` into native keyboard `term.onData` / `keydown`) so `Ctrl+O`/`Ctrl+D`/`Ctrl+C` actually work on mobile keyboards. |
| **OPFS Persistence + Reset** | **CORE** | Core promise on `/etc/motd` and `about.html`. Must fix `BUG-05` (offline build-id bypass), `BUG-13` (tab-hide drop), `BUG-14` (`dirty` race), `BUG-15` (Reset vs `pagehide` race), `BUG-16` (atomic `meta.json`, worker `onerror`, Safari/Firefox OPFS fallback), and `BUG-17` (`persist-9p.js` second-save bug) before launch. |
| **MOTD (first-visit orientation)** | **CORE** | Tells users networking is off and files live locally. Must NOT use `serial0_send("clear; cat /etc/motd\n")` (`BUG-01`). Fix: render MOTD directly via `term.write(...)` on first boot (local xterm output only, zero bytes sent to guest stdin!) OR bake it into the fresh snapshot's terminal output / guest `/etc/motd` printed before snapshot capture, and update wording to match actual enabled features (remove references to Upload/Download while flagged off). |
| **About page (`about.html`)** | **CORE** | Required for Debian GPL / v86 / xterm.js / SeaBIOS attribution. Static, clean, zero bugs found. |
| **Offline banner & Fatal error panel (with Reload button)** | **CORE** | Required so users never see silent hangs. Fix `BUG-09` (separate offline `chunk-offline` from 404 `chunk-missing-real`), `BUG-10` (precache `chunks-precache.json`), and `BUG-23` (add working Reload button to `#fatal`). |
| **Restart button (`#restart`)** | **FLAG-OFF** (or fix immediately in Phase 2) | **Evidence:** Currently bricks the VM at SeaBIOS on every snapshot boot (`BUG-22`, **VERIFIED** in `libv86.js:176090` & `build.sh:49-63`). Hide until replaced with a safe "Reload session" (save → reload page) or "Soft restart" (destroy & re-instantiate V86 from snapshot). |
| **Offline packs dialog (`packs.js` + `#packs`)** | **FLAG-OFF** | **Agrees with owner's guess — strongly confirmed by code:** local rewrite has an infinite 2-tab `BroadcastChannel` CPU/cache loop (`BUG-19`), broken cancel-then-remove/use-minimal (`BUG-20`), double caching across `GL_DATA_CACHE` + `GL_PACK_CACHE` (468 MB for 234 MB pack), silent `QuotaExceededError` bandwidth burn, and `"Removed null pack"` (`BUG-21`). Live `5761126` version has `localStorage` drift, no job lock, and shared-cache deletion. |
| **Per-tool progress bar (`tools.json`) & Prefetch (`maybePrefetch`)** | **FLAG-OFF** | **Agrees with owner's guess — strongly confirmed by code:** `sw.js:480` caches `packs/<id>/tools.json` forever in `GL_SHELL_CACHE` (`BUG-07`), `loadToolSets()` races SW startup and caches `null` forever (`BUG-30`), `measureToolCached()` runs up to 708 sequential CacheStorage IPC calls on main thread (`BUG-30`), and `smoke-deploy.test.js:768` explicitly disables `GL_PREFETCH` so prefetch is completely untested in CI. *(Note: the plain generic `"Loading from disk… N files, X MB"` bar has no `tools.json` dependency and is much simpler, so it can optionally graduate earlier than per-tool/prefetch once verified.)* |
| **Upload (`#uploadBtn` + drag-and-drop)** | **FLAG-OFF** | **Agrees with owner's guess, with nuance:** The underlying 9p `create_file()` + `persist-9p.js` stripping is actually solid (once `BUG-17` is fixed), **except** `index.html:1466-1468` injects unsanitized `echo "Uploaded ${file.name}..."` via `serial0_send` (`BUG-03`, command injection + editor corruption). Flag off for launch to keep scope tight; it is the **easiest** feature to re-enable first (Phase 5a) simply by deleting those 3 `serial0_send` lines and showing status in the toolbar only! |
| **Download `/root` (`#downloadBtn`)** | **FLAG-OFF** | **Agrees with owner's guess — strongly confirmed by code:** Violates **INV-1** twice (`tar czf` + `rm -f` over `serial0_send`), produces truncated `.tar.gz` whenever `tar` pauses >500 ms (`BUG-04`), fails on empty `/root` (`<=120B`), checks `DOWNLOAD_LIMIT` only *after* risking mobile OOM, leaves stale archives when over limit, has no concurrent-click lock, and mislabels `.tar.gz` as "zip". |
| **`stty -echo` / `stty rows cols` / `Ctrl-L` resize injection** | **REMOVE** | **Never ship.** Fundamentally violates **INV-1** (`BUG-02`); prompt-regex guarding (`watchShellPrompt`) can never be sound against arbitrary terminal output (`nano`, `vim`, `less`, scripts with `#`/`$`). Delete completely and replace in Phase 5b with v86's real out-of-band `virtio-console0-resize`. |
| **Boot-time `serial0_send("export TERM=...; clear; cat /etc/motd\n")`** | **REMOVE** | **Never ship.** Violates **INV-1** (`BUG-01`). Fix `TERM=xterm-256color` properly inside `tools/image/install.sh` (remove `TERM=vt102` from `.bashrc`/`.bash_profile`) and rebuild the snapshot. |
| **Unused `assets/xterm/addon-fit.js`, dead `GL_PACK_KEY`, dead `"golinux-packs-ui"` channel** | **REMOVE** | Zero callers (`BUG-08`, `BUG-19`); wastes precache work and confuses maintainers. |

---

## Graduation Criteria (What Each FLAG-OFF Feature Must Pass to Return)

1. **Restart button** → Replaces `emulator.restart()` with safe destroy + re-boot (or save + `location.reload()`); smoke test clicks Restart and verifies shell prompt responds; zero `serial0_send`.
2. **Upload (`GL_FEATURES.upload`)** → Delete `serial0_send` echo (`BUG-03`); sanitize filename (strip path separators/control chars); add in-flight lock; fix `persist-9p.js` (`BUG-17`); pass `serial0_send` spy test + upload-while-in-`nano` test + reload-leaves-`/mnt/host`-empty test.
3. **Terminal resize (`virtio-console`)** → Kernel + `/etc/inittab` boot `getty` on `/dev/hvc0` with `virtio_console` enabled in v86; `terminal.js` sends `emulator.bus.send("virtio-console0-resize", [cols, rows])` on resize; `serial0_send` / stdin spy proves 0 bytes injected; `nano` + `stty size` verified across desktop & mobile viewports.
4. **Offline packs (`GL_FEATURES.packs`)** → Fix infinite 2-tab `BroadcastChannel` loop (`BUG-19`), await cancelled job before starting `removePack`/`useMinimal` (`BUG-20`), stop `sw.js` from double-caching pack downloads into `GL_DATA_CACHE` (`BUG-21`), abort immediately on `QuotaExceededError`, fix `"Removed null pack"` UI string, clarify `common ⊂ full` UX; pass 2-tab BroadcastChannel unit test + cancel-during-download UI test + offline `gcc` smoke test.
5. **Download `/root` (`GL_FEATURES.download`)** → Zero `serial0_send` on the interactive console (use either a non-interactive second serial port `ttyS1` / guest helper daemon writing to a `.tmp` file then atomically `mv`ing into `/mnt/host`, OR host-side archive extraction); enforce size check *before* `read_file` allocation; add single-job lock; verify non-truncated `tar -tzf` on a throttled link and while `nano` is open.
6. **Per-tool progress bar & Prefetch (`GL_FEATURES.toolProgress`, `GL_FEATURES.prefetch`)** → Content-hash pack/tool JSON filenames (`TODO.md`) or stop `sw.js` caching `/packs/*` in `GL_SHELL_CACHE`; replace 708 serial `caches.open`+`match` calls with one `cache.keys()` snapshot (`BUG-30`); run `loadToolSets()` after SW ready with retry; enable `GL_PREFETCH = true` in a dedicated throttled smoke test proving measurable speedup without regressions.
