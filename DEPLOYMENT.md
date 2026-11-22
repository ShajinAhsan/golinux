# GoLinux — launch checklist

Everything below is manual on your side: I have not created any Cloudflare
resources and no credentials are in this repo.

---

## 0. What gets deployed where

| Content | Where | Why |
|---|---|---|
| `index.html`, `*.js`, `sw.js`, `manifest.json`, `icons/` | Pages | small, versioned with the app |
| `assets/v86/*.wasm`, `assets/xterm/*`, `assets/bios/*` | Pages | 2 MB total; must be same-origin for the SW |
| `assets/empty-chunk.zst` | Pages | the SW's 404/offline fallback, precached with the shell |
| `images/debian-{bzImage,initrd,state.bin.zst}` | Pages | ≤ 25 MiB each; needed before the disk |
| `images/build-id.json` | Pages | never cached; detects incompatible saved states |
| `images/debian-chunks/*.zst` (5,602 real) | **R2** | 222.8 MB, and 41k files would break the Pages 20,000-file limit |
| `packs/*.json` | **R2** | only needed when the user opts into a pack |

**The 35,358 empty chunks are not uploaded.** They are byte-identical zeroed
blocks; v86 only ever reads them as empty regions. The service worker answers a
404 for them with `assets/empty-chunk.zst`, which I verified by cold-booting
with those files 404ing (`ls`, `gcc` both fine).

---

## 1. Cloudflare limits that matter (verified in the docs)

| Limit | Value |
|---|---|
| Pages files per site | **20,000** (Free) |
| Pages max single file | **25 MiB** |
| Pages `_headers` rules | 100 |
| Pages custom domains | 100 per project |
| R2 free storage | **10 GB-month** |
| R2 free Class A (writes) | **1,000,000/month** |
| R2 free Class B (reads) | **10,000,000/month** |
| R2 egress | **free** |
| R2 objects per bucket | unlimited |
| R2 custom domains per bucket | 100 |

Two important details:

- **`r2.dev` is not for production.** Cloudflare documents it as
  rate-limited (hundreds of req/s → 429) and throttled. You need a custom
  domain on the bucket.
- **`.zst` is in Cloudflare's default cached-extension list**, so chunk
  responses are edge-cached without a Cache Everything rule. **HTML and JSON
  are not cached by default** — that is fine here, because the shell is
  handled by the service worker and `packs/index.json` is deliberately
  short-lived.

The largest Pages file is `images/debian-initrd` at **24.18 MiB** — inside the
25 MiB limit but with little headroom. If the initrd grows, move it to R2.

---

## 2. R2 setup (by hand)

1. **Create the bucket**
   Dashboard → R2 → *Create bucket* → name it e.g. `golinux-assets`.
   Leave it private; a custom domain makes objects readable.

2. **Connect a custom domain** (required, not `r2.dev`)
   Bucket → *Settings* → *Custom Domains* → *Connect Domain* →
   `assets.yourdomain.com`. Cloudflare creates the DNS record automatically
   if the zone is on your account. Wait for the certificate to show *Active*.

3. **Apply CORS** — the page is on a different origin, so chunk fetches need it.

   **REQUIRED before this step:** open `public/r2-cors.json` and replace the
   `https://YOUR-PROJECT.pages.dev` placeholder with the real Pages origin
   assigned to your project (shown in the Pages dashboard). `https://golinux.app`
   is already listed. Skipping this makes chunk requests fail CORS, and the
   machine will not boot on that origin.

   ```sh
   npx wrangler r2 bucket cors set golinux-assets --file public/r2-cors.json
   npx wrangler r2 bucket cors list golinux-assets   # verify the origins
   ```

4. **Create an API token for uploads**
   R2 → *Manage R2 API Tokens* → *Create API token* → permission
   **Object Read & Write**, scoped to this bucket. Note the Access Key ID and
   Secret Access Key — they are shown once.

5. **Export the credentials in your shell** (never commit them):
   ```sh
   export R2_ACCOUNT_ID=...
   export R2_BUCKET=golinux-assets
   export R2_ACCESS_KEY_ID=...
   export R2_SECRET_ACCESS_KEY=...
   ```

---

## 2b. How chunk URLs are versioned

Chunk filenames are positional (`chunk-<start>-<end>.zst`), so a rebuild gives
the **same names with different bytes**. Serving those under
`Cache-Control: immutable` would let the CDN and browsers keep handing out the
previous build's chunks — silent corruption (observed offline as
`invalid ELF header`).

Every build therefore gets its own path:

```
images/debian-chunks/<buildId>/chunk-<start>-<end>.zst
packs/<buildId>/common.json
```

`<buildId>` is a **content hash** of the served files (chunks + kernel + initrd
+ wasm), so identical contents produce an identical id and a no-op rebuild is
a true no-op. `tools/deploy/stamp-build-id.sh` writes it into
`packs-config.js` (`GL_BUILD_ID`), which derives `GL_CHUNK_PATH` and
`GL_PACKS_PATH`. Local dev leaves it empty and uses flat paths.

---

## 3. Deploy the chunks and packs

```sh
brew install awscli        # one-off; needs the aws CLI, not wrangler
./tools/deploy/upload-r2.sh --dry-run    # shows counts, uploads nothing
./tools/deploy/upload-r2.sh              # uploads 5,603 chunks + 3 pack files
```

I used the **S3 API rather than wrangler** because Cloudflare's own docs say
`wrangler r2 object put` "only allows one object at a time" and recommend an
S3-compatible tool for bulk. With ~5,600 objects, one process each is not
workable. `aws s3 sync` also skips unchanged files, so re-deploys are cheap.

---

## 4. Point the app at the asset origin

Edit **one line** in `packs-config.js`:

```js
const PL_ASSET_ORIGIN = "https://assets.yourdomain.com";
```

This is the single source for the asset base. The service worker proxies chunk
requests to it — the page itself always requests chunks same-origin, because
v86's `use_parts` derives filenames by splitting the URL on the *last dot*,
which mangles any absolute URL that has dots in the hostname.

Then rebuild and deploy the app:

```sh
./tools/deploy/build-pages.sh          # writes .deploy-pages, validates limits
npx wrangler pages deploy .deploy-pages --project-name golinux
```

---

## 5. DNS

| Record | Name | Target |
|---|---|---|
| Pages custom domain | `golinux.yourdomain.com` | Pages → *Custom domains* → add; Cloudflare creates the CNAME |
| R2 asset domain | `assets.yourdomain.com` | created in step 2.2 |

Both must be **proxied (orange cloud)** so caching and HTTPS apply.

---

## 6. Verify after deploy

```sh
curl -sI https://assets.yourdomain.com/images/debian-chunks/chunk-0-131072.zst
#   expect 200, content-type: application/zstd,
#   cache-control: public, max-age=31536000, immutable,
#   access-control-allow-origin: https://your-app-domain

curl -sI https://your-app-domain/sw.js
#   expect cache-control: no-cache, no-store, must-revalidate

curl -sI https://your-app-domain/images/build-id.json
#   expect cache-control: no-store
```

Then in a browser: hard-reload, confirm the shell appears, check DevTools →
Network that chunk requests go to `assets.…` and return 200, and run
`gcc --version`.

---

## 7. Rollback

Because each build lives at its own path, rollback is a pointer change — nothing
is deleted, and users on the bad build keep working throughout.

**Roll back the app to the previous build:**
```sh
./tools/deploy/stamp-build-id.sh <previous-build-id>   # e.g. from R2 listing
npx wrangler pages deploy .deploy-pages --project-name golinux
```
Take `<previous-build-id>` from the R2 prefixes:
```sh
aws --endpoint-url https://<account-id>.r2.cloudflarestorage.com s3 ls \
  s3://golinux-assets/images/debian-chunks/
```
The previous prefix still holds its chunks and packs, so the old app boots
immediately.

**Roll back a Pages-only change** (no image change): Pages → *Deployments* →
pick the previous deployment → *Rollback*. Deployments are kept 30 days plus
your 100 most recent.

**Retention: keep the last 3 builds.** There is no automatic deletion anywhere
in `upload-r2.sh` — deliberately. Never remove a build while clients may still
be running it:

> **Do not delete a build until at least a day after its successor has gone
> live.** Users with the old app open, and cached chunk URLs (up to a year of
> `immutable`), will 404 if the prefix disappears.

To prune, list the prefixes and delete explicitly, oldest first:
```sh
aws --endpoint-url https://<account-id>.r2.cloudflarestorage.com s3 ls \
  s3://golinux-assets/images/debian-chunks/
# then, for a build that is older than the newest three:
aws --endpoint-url https://<account-id>.r2.cloudflarestorage.com s3 rm \
  s3://golinux-assets/images/debian-chunks/<old-id> --recursive
aws --endpoint-url https://<account-id>.r2.cloudflarestorage.com s3 rm \
  s3://golinux-assets/packs/<old-id> --recursive
```
Each build is ~223 MB; the 10 GB free tier holds about 40, so three is
comfortable.

**Saved user states** are refused automatically when the build id changes
(`images/build-id.json` vs the stored `meta.json`), with a message telling the
user their old files are unavailable and to use *Download /root* next time.

## 8. Cost expectations

| | Per session | Free tier allows |
|---|---|---|
| Boot only (snapshot restores; 0 chunks) | 0 reads | unlimited |
| `gcc` + one compile | ~269 reads | ~37,000 sessions/month |
| Common tools session | ~683 reads | ~14,600 sessions/month |
| Full pack session | ~5,602 reads | ~1,800 sessions/month |

Storage: 222.8 MB against a 10 GB-month free tier. Egress is free. The likely
first limit is **Class B reads** if most visitors install the full pack; the
common pack is ~8× cheaper per session.
