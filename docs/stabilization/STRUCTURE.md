# GoLinux Module Structure Proposal (Zero-Framework, Zero-Build)

## 1. The Problem with `index.html` Today (**VERIFIED**)

`index.html` is **2,072 lines** (~78.5 KB) mixing CSS, HTML markup, and 10 distinct JS subsystems in one global `<script>` scope:
- Duplicate function definitions (`currentTerminal()` at lines 1602 and 1667) silently shadow each other.
- Global mutable variables (`activeTool`, `diskVisible`, `shellAtPrompt`, `latchedCtrl`, `window.emulator`, `packManifest`, `prefetchState`) cross-couple unrelated features.
- Pure logic (grid sizing, key modifier mapping, tool-set matching, pack formatting) cannot be unit-tested in Node without booting a browser or regex-scraping `index.html`.
- Feature flags cannot cleanly disable UI + listeners because event handlers are wired inline across 1,600 lines.

---

## 2. Proposed Module Layout (Native ES Modules, No Framework, No Build Step)

Native `<script type="module">` is supported by every browser capable of running v86 WebAssembly + OPFS + Service Workers (Chrome, Firefox, Safari/WebKit) (**VERIFIED** from platform specs; **INFERRED** zero runtime compatibility penalty).

**One deliberate classic-script exception:** `packs-config.js` stays a classic script (loaded via `<script src="packs-config.js">` in `index.html` and `importScripts("packs-config.js")` in `sw.js`) because classic service workers are universally supported across all browsers and guarantee `index.html` and `sw.js` read the exact same stamped file. All new UI/app modules under `js/` are standard ES modules.

```text
index.html                  (~140 lines: semantic HTML shell + <link> + <script type="module" src="js/main.js">)
styles.css                  (~230 lines: extracted CSS, fixed #persistStatus & iOS 16px textarea)
packs-config.js             (single source of truth for GL_VERSION, GL_BUILD_ID, GL_ASSET_ORIGIN, GL_FEATURES, GL_SHELL_FILES)
sw.js                       (service worker; precaches GL_SHELL_FILES from packs-config.js)
persist.js                  (OPFS persistence engine — pure logic exported for Node tests)
persist-9p.js               (v86 9p upload-stripping wrapper)
packs.js                    (offline pack engine — loaded/wired only when GL_FEATURES.packs)

js/
  main.js                   Entrypoint: reads GL_FEATURES, applies feature visibility, wires modules in explicit order
  status.js                 Status bar, #loading overlay, #fatal overlay (with Reload button), #offlineBanner, #diskBar, #persistStatus
  boot.js                   SW registration/control gate, snapshot fetch/progress, V86 instantiation, safe Restart, lifecycle events
  terminal.js               xterm.js adapter access, cell measurement, ResizeObserver layout, virtio-console resize (zero serial0_send!)
  keybar.js                 Pure modifier state machine + touch keybar + native-keyboard Ctrl/Alt interception + focus/keyboard toggle
  persist-ui.js             Binds GoPersist status updates, safe Reset (lock + disarm unload), storage-full/upgrade notices
  packs-ui.js               (Flagged) Packs dialog rendering, progress bar, Pause/Cancel/Remove/Use Minimal actions
  transfer.js               (Flagged) Upload (9p create_file, zero serial0_send) and future non-stdin Download
  tool-progress.js          (Flagged) Per-tool set matching (matchTool) and throttled prefetch (pure logic separated from DOM)
```

### Explicit Module Interfaces

| Module | Inputs / Dependencies | Exports (Public Contract) | Owns DOM | Allowed to touch Guest? |
|---|---|---|---|---|
| `js/status.js` | DOM refs only | `setStatus(text)`, `setLoading(t, d)`, `clearLoading()`, `showFatal(t, d, { reload })`, `showOfflineBanner()`, `setPersistStatus(msg, kind)`, `updateDiskBar(msg)` | `#status`, `#loading`, `#fatal`, `#offlineBanner`, `#diskBar`, `#persistStatus`, `#progress` | **NEVER** |
| `js/boot.js` | `packs-config.js`, `GoPersist`, `Go9p`, `status` | `prepareChunkAccess()`, `bootMachine({ onReady })`, `restartMachine()` | `#restart` | **NEVER** (no `serial0_send`!) |
| `js/terminal.js` | `getEmulator` getter | `computeGrid(w, h, cell)` *(pure)*, `fitTerminal()`, `observeTerminal()`, `focusTerminal()` | `#terminal` | Out-of-band `virtio-console0-resize` ONLY (Phase 5); **NEVER stdin** |
| `js/keybar.js` | `getTerminal` getter | `applyModifiers(str, mods)` *(pure)*, `setupKeyBar()`, `attachKeyboardInterceptor(term)` | `#keybar` | **YES — ONLY module allowed to send key-bar input via `term.input()`** |
| `js/persist-ui.js` | `GoPersist`, `status` | `setupPersistUI()` | `#resetBtn`, `#mReset` | **NEVER** |
| `js/packs-ui.js` | `GoPacks`, `status` | `setupPacksUI()` (no-op if `!GL_FEATURES.packs`) | `#packs`, `#packProgress`, `#openPacks`, `#mPacks` | **NEVER** |
| `js/transfer.js` | `getEmulator`, `status` | `setupTransferUI()` (no-op if `!GL_FEATURES.upload && !GL_FEATURES.download`) | `#uploadBtn`, `#downloadBtn`, `#uploadInput` | 9p `create_file` / `read_file` ONLY; **NEVER stdin** |
| `js/tool-progress.js` | `packs-config.js`, `status` | `matchTool(names, sets)` *(pure)*, `setupToolProgress()` | `#diskBar` sub-labels | **NEVER** |
| `js/main.js` | All modules above | Startup order: apply `GL_FEATURES` → `setupStatus` → `setupBarMenu` → `setupKeyBar` → `prepareChunkAccess()` → `bootMachine()` → `observeTerminal()` → optional flagged modules | `#barMenu`, `#barMenuBtn` | **NEVER** |

### Single Asset List for `sw.js` & `build-pages.sh`
Today `SHELL_FILES` in `sw.js:18-40` and `cp` commands in `tools/deploy/build-pages.sh:56-80` duplicate the file list — adding a module in `js/` and forgetting either list breaks offline mode or production boot. Solution: define `GL_SHELL_FILES` once in `packs-config.js` (or `shell-manifest.json`), read it in both `sw.js` (`install`) and `build-pages.sh`, and assert every entry exists in `verify-manifests.js`.

---

## 3. Cost vs. Benefit of the Split

### Costs
1. **Effort:** ~0.5–1 day of mechanical extraction, best done **after** Phase 1–3 tests exist to verify zero regressions.
2. **HTTP requests on cold first load:** ~8–10 small ES module files (~1–4 KB each) instead of one 78 KB HTML file. Over Cloudflare HTTP/2 they multiplex in 1 RTT and are precached by `sw.js` on install (**INFERRED** negligible latency vs the 11.1 MB snapshot).
3. **Cache list maintenance:** Automated once `sw.js` and `build-pages.sh` share `GL_SHELL_FILES`.

### Bugs Removed or Prevented by This Split
- **Directly eliminates:** duplicate `currentTerminal()` (`BUG-08`), dead `"golinux-packs-ui"` channel (`BUG-19`), early `loadToolSets()` before SW control (`BUG-30`), accidental `serial0_send` calls outside `js/keybar.js` (enforceable with a 3-line grep check for **INV-1**!).
- **Directly enables fast Node unit tests (no browser required):** `keybar.js` modifier state machine (`BUG-24`), `terminal.js` grid math, `tool-progress.js` matching (`BUG-30`), `persist.js` build-id & dirty-flag state machine (`BUG-05`, `BUG-13`, `BUG-14`, `BUG-15`).
- **Directly enables clean feature flags:** hiding `packs-ui.js`, `transfer.js`, and `tool-progress.js` means disabled features execute **zero** startup code, register **zero** listeners, and make **zero** network requests.

---

## 4. Honest Verdict: Refactor in Place vs. Rewrite

**Recommendation: Refactor in place + targeted replacement of specific broken subsystems. Do NOT rewrite from scratch.**

### Why NOT a full rewrite
1. **The core architecture is genuinely strong and already solved the hardest problems (VERIFIED):**
   - Deterministic content-hash `buildId` (`tools/image/build-id.js`) and versioned R2 prefixes (`upload-r2.sh`) are well-designed.
   - Snapshot RAM zeroing (`save-state.js` shrunk state from 40 MB → 11.1 MB) and 9p upload stripping (`persist-9p.js` + `check-9p-state-shape.js`) are non-trivial, verified wins.
   - Two-origin smoke test (`smoke-deploy.test.js`) and SW harness (`sw-chunk-fallback.test.js`) already provide strong foundations once their blind spots are fixed.
2. **Solo student bandwidth:** A rewrite from scratch discards working image pipelines, deploys, and test harnesses, delays stabilization by weeks, and reliably reintroduces subtle v86/SW edge cases (such as `use_parts` last-dot URL mangling or `init_on_free` snapshot bloat) that are already solved and documented here.

### Where surgical replacement *is* needed (instead of patching)
1. **Terminal resize (`applyGrid` + `watchShellPrompt`):** Delete completely; do not keep patching prompt regexes. Run clean fixed geometry first, then replace with v86's native `virtio-console0-resize` (verified present in `assets/v86/libv86.js:204262`).
2. **Download `/root`:** Delete the `serial0_send("tar czf ...")` + 500 ms polling hack; when re-enabled in Phase 5, replace with a non-stdin sideband (e.g., dedicated `ttyS1` guest helper writing atomically into 9p) or host-side export.
3. **`index.html` inline script:** Split mechanically into the ES modules above *after* Phase 1–3 stabilize invariants and add regression tests.
