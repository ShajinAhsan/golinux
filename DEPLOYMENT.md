# GoLinux — deploy guide (click-by-click)

Follow in order. **MANUAL** = you click in a dashboard. **SCRIPT** = you run a
command in a terminal. Run all commands from the repo root.

Names used throughout: domain **golinux.app**, R2 bucket **golinux-assets**,
R2 domain **assets.golinux.app**, Worker **golinux**.

> What lives where: R2 holds the disk chunks + packs (too many for a Worker's
> asset count). The Worker serves everything else. The service worker fetches
> chunks from R2.

---

## 0. Smoke test — REQUIRED before every deploy — SCRIPT

Nothing goes to the Worker or R2 until this passes. It exercises the **staged**
output against a local stand-in for production: the app on one origin, and a
mirror of exactly what `upload-r2.sh` uploads on a second (real
`images/debian-chunks/<buildId>/` paths, 404 for the zeroed chunks). It uses no
`?assets=` override and no credentials.

```sh
./tools/deploy/build-pages.sh
```

`build-pages.sh` runs the smoke test as its final step. To run it on its own:

```sh
node tools/test/smoke-deploy.test.js --pages .deploy-pages
```

It drives a fresh headless Chrome through: first load → shell → a **cold**
`gcc` compile (in its own fresh profile, since v86 caches chunks in RAM) →
`ls` → `gcc --version` → write a file in `/root` → save → reload → the file is
still there. It asserts the "Loading from disk" indicator appears and is labelled
`gcc`, that every chunk request went to the asset origin with the build id in the
path and returned 200, that none went to the app origin, and that no "out of
date" overlay appeared.

**You should see:** `PASS (0 failure(s))` and exit code 0. If it fails, do not
deploy — fix the cause and rebuild. (`SKIP_SMOKE=1` skips it for a local build
only; that output must never be deployed.)

---

## 1. Cloudflare account + add the domain — MANUAL

1. Go to <https://dash.cloudflare.com/sign-up> and create a free account.
2. In the dashboard click **Add a site** (top-right, or the big button on the
   home screen). Type `golinux.app` → **Continue**.
3. Pick the **Free** plan → **Continue**.
4. Cloudflare scans DNS and shows a list of records. Leave them as-is →
   **Continue**.
5. It shows **two nameservers** like
   `ada.ns.cloudflare.com` and `bob.ns.cloudflare.com`. **Copy both.**

**You should see:** the site listed with status **Pending Nameserver Update**.

---

## 2. Nameservers at name.com — MANUAL

1. Sign in at <https://www.name.com> → **My Domains** → click `golinux.app`.
2. Open the **Nameservers** (or **Manage DNS**) panel.
3. Choose **Use custom nameservers** (not name.com's default DNS).
4. Delete the existing entries, paste the **two Cloudflare nameservers** from
   step 1 → **Save**.

**You should see:** name.com says nameservers updated. Back in Cloudflare the
site flips to **Active** (usually minutes, up to 24 h). Wait for **Active**
before continuing — R2's custom domain and the Worker's domain need it.

---

## 3. R2 bucket + API token — MANUAL

1. Dashboard left sidebar → **R2 Object Storage** → **Create bucket**.
2. Name it `golinux-assets`. Leave **Public access** off →
   **Create bucket**.
   *(R2 asks for a payment method on file even on the free tier.)*
3. Left sidebar → **R2** → **Manage R2 API Tokens** → **Create API token**.
4. Token name `golinux-upload`. Permissions: **Object Read & Write**.
   Scope: **Only specific bucket** → `golinux-assets` →
   **Create API Token**.
5. The next screen shows **Access Key ID**, **Secret Access Key**, and the
   **Account ID** (also on the R2 overview page). **Copy all three now** — the
   secret is shown only once.

**You should see:** the bucket in the R2 list, and the token under
*Manage R2 API Tokens*.

---

## 4. Custom domain for R2 — MANUAL

1. **R2** → click bucket `golinux-assets` → **Settings** tab →
   **Custom Domains** → **Connect Domain**.
2. Type `assets.golinux.app` → **Connect Domain**.

**You should see:** the domain listed, status **Active** shortly after
(Cloudflare creates the DNS record itself because the zone is on your account).

> Do **not** use the `r2.dev` link — it is rate-limited and not for production.

---

## 5. CORS — MANUAL then SCRIPT

Chunks are fetched cross-origin (page on `golinux.app`, files on
`assets.golinux.app`), so the bucket needs a CORS rule.

1. **MANUAL:** open `public/r2-cors.json`. It already allows
   `https://golinux.app`, which is the live site, so nothing else is needed.
   Save.
2. **SCRIPT:** run once, then apply the rule:
   ```sh
   npx wrangler login                       # opens a browser, click Allow
   npx wrangler r2 bucket cors set golinux-assets --file public/r2-cors.json
   npx wrangler r2 bucket cors list golinux-assets
   ```

**You should see:** the list command prints a rule containing
`https://golinux.app`.

---

## 6. Upload the chunks — SCRIPT

1. Install the AWS CLI once (the uploader uses the S3 API, not wrangler):
   ```sh
   brew install awscli
   ```
2. Export your credentials in **this terminal** (from step 3; never commit
   them):
   ```sh
   export R2_ACCOUNT_ID=...        # Account ID
   export R2_BUCKET=golinux-assets
   export R2_ACCESS_KEY_ID=...
   export R2_SECRET_ACCESS_KEY=...
   ```
3. **Dry run first:**
   ```sh
   ./tools/deploy/upload-r2.sh --dry-run
   ```
   **You should see:** `build id: <16 hex>` and
   `chunks: 5601 files, ~234 MB`, then `DRY RUN: nothing was uploaded.`
4. **Upload for real:**
   ```sh
   ./tools/deploy/upload-r2.sh
   ```
   **You should see:** `Uploaded.` and a short "Next:" list.

---

## 7. Deploy the site — SCRIPT

The site is a **Cloudflare Worker with static assets**, not a Pages project.
`wrangler.jsonc` in the repo names it `golinux` and points at `.deploy-pages`.

One-time setup, yours to run (this script never logs in for you):

```sh
npx wrangler login
```

Then every deploy is:

```sh
./tools/deploy/deploy-site.sh
```

It refuses a build whose smoke test was skipped (`SKIP_SMOKE`), builds with the
required smoke test, prints the build id / `sw.js` sha256 / file count and size,
checks you are logged in, asks `Deploy build <id> to golinux.app? [y/N]`, runs
`npx wrangler deploy`, then verifies the live site with cache-busted requests
(retried): `sw.js` matches the local hash, `packs-config.js` has
`GL_ASSET_ORIGIN https://assets.golinux.app`, `chunks-precache.json` returns
200, `sw.js` is `no-cache`, and both `packs/<buildId>/tools.json` and a real
chunk on `assets.golinux.app` return 200 with
`access-control-allow-origin: https://golinux.app`.

`--dry-run` does everything except the deploy and the live checks.

**You should see:** `Deployed build <id> and verified https://golinux.app.`

**Before the first deploy**, `packs-config.js` must point at R2 (checked
automatically by the script):

```js
const GL_ASSET_ORIGIN = "https://assets.golinux.app";
```

If you skip that, every chunk is requested from the site, 404s, and the machine
will not boot.

---

## 8. The golinux.app domain — MANUAL (already set up)

The Worker is already named `golinux` in the dashboard (renamed from
`withered-boat-e970`) and `golinux.app` is bound to it. Nothing to do per
deploy.

If you ever re-point it: **Workers & Pages → golinux → Settings → Domains &
Routes → Add → Custom domain** → `golinux.app`, then **Add** →
`www.golinux.app` if wanted. Cloudflare creates the DNS records.

**You should see:** the domain listed as **Active**.

---

## 9. Final check on your phone — MANUAL

On your phone (mobile data, **not** your office Wi-Fi, so it is a real test):

1. Open `https://golinux.app`. **Expect:** a terminal prompt within a few
   seconds (`root@golinux:~#`).
2. Type `ls`, then `gcc --version`. **Expect:** normal output, no errors.
3. Type `echo 'int main(){return 0;}' > t.c && gcc t.c -o t && ./t && echo OK`.
   **Expect:** `OK`. (This reads many chunks; a failure here means CORS or the
   chunk path is wrong.)
4. Rotate the phone or lock/unlock the screen, then return to the tab.
   **Expect:** the session is still there.
5. In desktop DevTools → **Network**, filter `chunk`. **Expect:** requests to
   `assets.golinux.app` returning `200`.

---

## After launch: updates, rollback, retention — SCRIPT

- **Redeploy after a code change:** re-run step 7's two commands.
- **After re-recording packs or `tools.json`, ALWAYS do both:**
  1. re-upload them: `./tools/deploy/upload-r2.sh`
  2. **bump `GL_VERSION` in `packs-config.js`**

  Pack lists live at `packs/<buildId>/` and the build id comes from the *disk
  image*, so re-recording packs does not change their URL. Uploading replaces
  the bytes, and the `GL_VERSION` bump changes the shell/pack cache names so
  clients stop reusing the old cached copies. Skipping either step leaves stale
  packs being served. (Long-term fix: content-hashed pack names — see
  `TODO.md`.)

- **After changing any guest tool or the image:** re-record the per-tool sets
  with `node tools/image/build-tool-sets.js` (they drive the `Loading gcc…`
  bar and prefetch), then rebuild, re-upload, and bump `GL_VERSION` as above.
- **New disk image:** re-run `build.sh`, `build-snapshot.sh`, re-record packs,
  then steps 6 and 7. Each build lands at its own `…/<build-id>/` path.
- **Rollback the app:** `./tools/deploy/stamp-build-id.sh <previous-id>`, then
  `./tools/deploy/deploy-site.sh`. Or
  **Workers & Pages → golinux → Deployments → previous version → Rollback**.
- **Retention:** keep the last **3** builds in R2. Deletion is manual — there is
  no auto-delete. **Never delete a build until at least a day after its
  successor is live** (open clients and year-long `immutable` caches will 404).
  Prune explicitly with `aws s3 rm s3://golinux-assets/images/debian-chunks/<old-id> --recursive`
  and the matching `packs/<old-id>` prefix.

Cost is dominated by R2 **Class B reads**; the common pack is ~8× cheaper per
session than the full pack.
