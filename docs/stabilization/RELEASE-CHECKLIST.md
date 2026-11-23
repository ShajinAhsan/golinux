# GoLinux Release Checklist

Follow these steps **in exact order** for every future deploy to `https://golinux.app`. Do not skip steps, do not use `SKIP_SMOKE=1` for a real deploy, and never put credentials in git.

---

## 1. Pre-Flight Checks (Local, No Network)

1. **Clean working tree:**
   ```sh
   git status
   ```
   Must show `nothing to commit, working tree clean` on `main`.
2. **Verify launch feature flags & production origin in `packs-config.js`:**
   - `GL_ASSET_ORIGIN` is `"https://assets.golinux.app"`.
   - `GL_BUILD_ID` in the git working tree is `""` (never committed stamped).
   - `GL_FEATURES` matches the intended release scope (`SCOPE.md`).
3. **Bump `GL_VERSION` in `packs-config.js`:**
   - **MANDATORY on every deploy** (code change, snapshot update, pack re-record, or image rebuild) so returning browsers invalidate `GL_SHELL_CACHE` / `GL_DATA_CACHE` cleanly and pick up the new SW (`BUG-07`).
   - Commit the `GL_VERSION` bump before building.
4. **Confirm whether this deploy changes `buildId` (check Upgrade Story in `PLAN.md`):**
   - Code-only or snapshot-only change → `buildId` unchanged (returning users keep saved files; skip Section 2 & Section 4).
   - Disk-image rebuild (`tools/image/build.sh`) → **new `buildId`** (returning users' saved states will be incompatible — confirm this is intentional, and run Sections 2 and 4).

---

## 2. Image & Pack Rebuild (ONLY When Guest OS / Kernel / Snapshot Changed)

1. **Clear any stale temp recording files** (until Step 3.1 automates this):
   ```sh
   rm -f /tmp/golinux-pack-recording.img /tmp/golinux-tool-recording.img /tmp/golinux-tools-state.bin
   ```
2. **If disk image changed:**
   ```sh
   bash tools/image/build.sh
   ```
   Record the new `buildId` printed at the end (`cat images/build-id.json`).
3. **If disk image or snapshot changed:**
   ```sh
   bash tools/image/build-snapshot.sh
   ```
4. **If disk image changed (or packs enabled and changed):**
   ```sh
   rm -f packs/common.json packs/full.json packs/tools.json
   node tools/image/build-packs.js common
   node tools/image/build-packs.js full
   node tools/image/build-pack-index.js
   node tools/image/build-tool-sets.js
   ```
5. **Check Worker 25 MiB per-file headroom:**
   ```sh
   ls -lh images/debian-initrd images/debian-state.bin.zst images/debian-bzImage
   ```
   Confirm `images/debian-initrd` is safely under `25 MiB` (currently `24.18 MiB` — if it grows past 25 MiB, trim initrd modules before proceeding).

---

## 3. Automated Test Gate (ALL Must Exit 0)

Run every applicable layer before touching R2 or Cloudflare:

```sh
# Layer 1 & manifest/shape guards
node tools/image/verify-manifests.js
node tools/test/check-9p-state-shape.js
node tools/test/sw-chunk-fallback.test.js
node tools/test/packs.test.js            # (and unit.test.js / persist.test.js once added)

# Stage .deploy-pages + run Layer 3 production-like two-origin smoke test
# (includes serial0_send spy & fresh-vs-upgrade test once Phase 3 lands)
./tools/deploy/build-pages.sh

# Layout & cross-browser matrix (once Phase 3 lands)
node tools/test/ui-layout.test.js
# node tools/test/cross-browser.test.js  # Playwright Chromium + Firefox + WebKit
```

**Hard stop rule:** If ANY command exits non-zero, stop, fix the root cause, re-commit, and restart from Section 1.

---

## 4. R2 Asset Upload (ONLY When `buildId` Changed or Packs Were Re-Recorded)

1. Export R2 credentials in your local terminal only (never commit or log them):
   ```sh
   export R2_ACCOUNT_ID=...
   export R2_BUCKET=golinux-assets
   export R2_ACCESS_KEY_ID=...
   export R2_SECRET_ACCESS_KEY=...
   ```
2. **Dry run first:**
   ```sh
   ./tools/deploy/upload-r2.sh --dry-run
   ```
   Verify printed `build id` matches `images/build-id.json` and chunk count matches `chunks-precache.json` + 1 (`empty-chunk.zst`).
3. **Real upload:**
   ```sh
   ./tools/deploy/upload-r2.sh
   ```
4. **Verify R2 CORS & 200 BEFORE deploying the site:**
   Pick the first chunk in `chunks-precache.json` and check HTTP 200 + `access-control-allow-origin: https://golinux.app` on `https://assets.golinux.app/images/debian-chunks/<buildId>/<chunk>`.
5. **Retention rule:** **NEVER delete an old `<buildId>` prefix in R2 during deploy.** Keep the last 3 builds, and wait at least **24 hours** (recommended **7 days** if supporting recovery) after the successor goes live before pruning.

---

## 5. Deploy Site to Cloudflare Worker (`golinux`)

1. **Dry run first:**
   ```sh
   ./tools/deploy/deploy-site.sh --dry-run
   ```
   Verify build summary (`build id`, `sw.js` sha256, file count, size) and confirm `wrangler` is authenticated (if not, run `npx wrangler login` yourself).
2. **Deploy & run live verification:**
   ```sh
   ./tools/deploy/deploy-site.sh
   ```
   Confirm at the prompt (`y`) only after inspecting the build summary.
   Confirm the script prints `Deployed build <id> and verified https://golinux.app.` with exit code 0.
3. **Check live headers manually (sanity check for `_headers`):**
   ```sh
   curl -sSI https://golinux.app/sw.js | grep -i cache-control
   curl -sSI https://golinux.app/images/build-id.json | grep -i cache-control
   ```
   Ensure there are **no conflicting concatenated directives** (e.g., no `public, max-age=0, ..., no-cache, no-store`).

---

## 6. Post-Deploy Verification & Tagging

1. **Run the 5-minute Manual Real-Phone Checklist** (`docs/stabilization/TEST-PLAN.md §4`) on your phone over **cellular data** (not Wi-Fi).
2. **Record the known-good deploy in git** so rollback is deterministic:
   ```sh
   git tag -a "deploy-$(date +%Y%m%d-%H%M)-<buildId>" -m "Verified deploy of <buildId> (GL_VERSION=<vN>)"
   git push origin main --tags
   ```
3. Note the Cloudflare Worker deployment version ID (`npx wrangler deployments list`) in case you need a 10-second rollback.

---

## 7. Emergency Rollback Procedure

### Path A — Instant Rollback (~10 seconds, PREFERRED in an outage)
Use Cloudflare's immutable Worker deployment history (works even if your local repo changed):
1. List recent Worker deployments:
   ```sh
   npx wrangler deployments list
   ```
2. Roll back in Cloudflare Dashboard: **Workers & Pages → `golinux` → Deployments → select previous known-good version → Rollback** (or `npx wrangler rollback` if using Wrangler v3/v4 rollback command).
3. Verify `https://golinux.app` loads cleanly in a fresh private window AND in a returning tab.

> **Why Path A is safe for chunks:** Because R2 prefixes are immutable (`images/debian-chunks/<prevBuildId>/`) and never deleted for ≥24 h, the previous Worker version's chunks are guaranteed to still exist in R2.

### Path B — Deterministic Git + CLI Rollback (When Fixing Forward or After Breaking SW Cache)
> **Warning (current `BUG-27`):** Until Step 0.2 lands, **do NOT use `stamp-build-id.sh <prev-id>` + `deploy-site.sh`** — `build-pages.sh` overwrites `GL_BUILD_ID` from `images/build-id.json`!

Once Step 0.2 is in place:
1. Check out the previous verified deploy tag into a detached/rollback branch:
   ```sh
   git checkout -b rollback/YYYYMMDD <previous-deploy-tag>
   ```
2. **Bump `GL_VERSION`** (increment above the broken deploy's version!) so clients that already installed the broken SW immediately evict it and load the rolled-back shell.
3. Build against the previous build ID (explicitly, verified against R2):
   ```sh
   ./tools/deploy/build-pages.sh --build-id <prev-build-id>
   ```
4. Deploy and run live checks:
   ```sh
   ./tools/deploy/deploy-site.sh
   ```
5. Verify on your phone (fresh tab + returning tab that had visited the broken version).
