#!/usr/bin/env bash
# Upload the disk chunks and offline packs to Cloudflare R2.
#
#   ./tools/deploy/upload-r2.sh --dry-run     # print what would happen
#   ./tools/deploy/upload-r2.sh               # actually upload
#
# Credentials come from the environment (never from this file):
#   R2_ACCOUNT_ID    Cloudflare account id
#   R2_BUCKET        bucket name, e.g. golinux-assets
#   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   R2 API token credentials
#
# These are mapped to the AWS_* names the aws CLI actually reads, so you do not
# need to export both sets. AWS_DEFAULT_REGION is set to "auto" (R2's value) and
# every aws call passes --endpoint-url explicitly.
#
# Why the S3 API and not wrangler: Cloudflare's own docs state that
# `wrangler r2 object put` "only allows one object at a time" and recommend an
# S3-compatible tool for bulk uploads (docs.cloudflare.com/r2/objects/upload-objects/).
# With ~5,600 chunks, one-process-per-object would take hours and hammer the API.
# `aws s3 sync` batches, skips unchanged files, and sets Content-Type per file.
#
# Only REAL chunks are uploaded. The 35,358 empty chunks are all byte-identical
# to zeroed 128 KiB blocks; v86 only ever reads them as empty regions, and the
# service worker answers a 404 for them with images/debian-chunks/empty-chunk.zst.
# That keeps the object count at ~5,600 instead of ~41,000.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
CHUNKS="$ROOT/images/debian-chunks"
PACKS="$ROOT/packs"
MANIFEST="$CHUNKS/manifest.json"
STAGE="$ROOT/.deploy-r2"

DRY_RUN=0
BUILD_ID_ARG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    -*) echo "unknown argument: $arg" >&2; exit 2 ;;
    *) BUILD_ID_ARG="$arg" ;;
  esac
done

need() { [ -n "${!1:-}" ] || { echo "missing env var $1" >&2; exit 1; }; }

# A dry run must work on a machine with no credentials and no aws CLI, so it
# can be used to check what would be uploaded. A real upload requires all four
# R2_* variables, checked individually so the message names the empty one.
if [ "$DRY_RUN" -eq 0 ]; then
  for v in R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
    [ -n "${!v:-}" ] || { echo "ERROR: $v is empty or unset." >&2; exit 1; }
  done
  command -v aws >/dev/null || { echo "aws CLI not found (brew install awscli)" >&2; exit 1; }
elif ! command -v aws >/dev/null; then
  echo "NOTE: aws CLI not installed; cannot show the exact sync plan."
  echo "      Staged file counts above are what would be uploaded."
fi

# The aws CLI reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, not the R2_*
# names, so map them here. Nothing is echoed: these must never be printed.
if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; then
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
fi
export AWS_DEFAULT_REGION=auto

ENDPOINT="https://${R2_ACCOUNT_ID:-<account-id>}.r2.cloudflarestorage.com"

# Build id: every upload goes under its own prefix, so a build's URLs are
# immutable and older builds stay intact for clients still on them.
BUILD_ID="$BUILD_ID_ARG"
if [ -z "$BUILD_ID" ]; then
  if [ ! -f "$ROOT/images/build-id.json" ]; then
    echo "ERROR: missing images/build-id.json and no build id argument." >&2
    echo "       Refusing to upload to flat, unversioned chunk paths." >&2
    echo "       Run: node tools/image/build-id.js  (after build.sh)" >&2
    exit 1
  fi
  BUILD_ID="$(node -e 'process.stdout.write(require(process.argv[1]).buildId || "")' "$ROOT/images/build-id.json")"
fi
if [ -z "$BUILD_ID" ]; then
  echo "ERROR: build id is empty — refusing to upload flat, unversioned chunk paths." >&2
  exit 1
fi
case "$BUILD_ID" in
  *[!0-9a-f]*) echo "invalid build id: '$BUILD_ID' (expected lowercase hex)" >&2; exit 1 ;;
esac
echo "build id: $BUILD_ID"

# Verify manifests agree with artifacts before uploading anything.
node "$ROOT/tools/image/verify-manifests.js"

# Stage from the per-build directory if present (single source for this build),
# falling back to flat chunks only if no per-build dir exists.
SRC_CHUNKS="$CHUNKS/$BUILD_ID"
if [ ! -d "$SRC_CHUNKS" ]; then
  echo "ERROR: expected per-build chunk directory $SRC_CHUNKS does not exist." >&2
  exit 1
fi
MANIFEST="$SRC_CHUNKS/manifest.json"
[ -f "$MANIFEST" ] || MANIFEST="$CHUNKS/manifest.json"

echo "== Staging the files that should exist in R2 =="
rm -rf "$STAGE"
mkdir -p "$STAGE/images/debian-chunks" "$STAGE/packs"

python3 - "$MANIFEST" "$SRC_CHUNKS" "$CHUNKS" "$STAGE" <<'PY'
import json, os, shutil, sys
manifest, src_chunks, flat_chunks, stage = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
real = json.load(open(manifest))["real"]
dst = os.path.join(stage, "images", "debian-chunks")
for name in real:
    shutil.copy2(os.path.join(src_chunks, name), os.path.join(dst, name))
tpl = os.path.join(src_chunks, "empty-chunk.zst")
if not os.path.exists(tpl):
    tpl = os.path.join(flat_chunks, "empty-chunk.zst")
shutil.copy2(tpl, os.path.join(dst, "empty-chunk.zst"))
print(f"staged {len(real) + 1} chunk files from {src_chunks}")
PY

cp "$PACKS"/*.json "$STAGE/packs/"
echo "staged $(ls -1 "$STAGE/packs" | wc -l | tr -d ' ') pack files"

CHUNK_COUNT=$(ls -1 "$STAGE/images/debian-chunks" | wc -l | tr -d ' ')
CHUNK_BYTES=$(du -sk "$STAGE/images/debian-chunks" | cut -f1)
echo "  chunks: $CHUNK_COUNT files, ~$((CHUNK_BYTES / 1024)) MB"

# Every aws call passes --endpoint-url explicitly (never rely on config), and
# the region comes from AWS_DEFAULT_REGION=auto set above.
aws_flags=(
  --endpoint-url "$ENDPOINT"
)

if [ "$DRY_RUN" -eq 1 ] && ! command -v aws >/dev/null; then
  echo
  echo "== Would upload =="
  echo "  s3://<bucket>/images/debian-chunks/$BUILD_ID   $CHUNK_COUNT objects"
  echo "  s3://<bucket>/packs/$BUILD_ID                  $(ls -1 "$STAGE/packs" | wc -l | tr -d ' ') objects"
  echo
  echo "DRY RUN (no aws CLI): nothing was uploaded."
  rm -rf "$STAGE"
  exit 0
fi

# No --delete anywhere: deleting a build is a separate, manual, documented step.
# Removing objects while clients are reading them is exactly the failure mode
# this scheme exists to prevent.
echo
echo "== Sync chunks =="
aws "${aws_flags[@]}" s3 sync "$STAGE/images/debian-chunks" \
  "s3://${R2_BUCKET:-<bucket>}/images/debian-chunks/$BUILD_ID" \
  --exclude "*" --include "*.zst" \
  --cache-control "public, max-age=31536000, immutable" \
  --content-type "application/zstd" \
  --only-show-errors \
  $( [ "$DRY_RUN" -eq 1 ] && echo "--dryrun" )

# Packs are the pack LISTS (index/common/full/tools), a handful of small JSON
# files. They are NOT immutable: they are re-recorded whenever packs or tool
# sets change, without the build id changing. 1 hour, must-revalidate.
#
# `aws s3 sync` skips files whose size/mtime are unchanged, so it would leave a
# stale Cache-Control on objects it does not re-upload. Each pack file is
# therefore copied explicitly with `aws s3 cp`, which always PUTs and therefore
# always applies the new metadata. There are only ever a few of these.
PACK_CACHE_CONTROL="public, max-age=3600, must-revalidate"

echo "== Upload packs (always re-uploaded, so the header is applied) =="
shopt -s nullglob
pack_files=("$STAGE"/packs/*.json)
shopt -u nullglob
[ "${#pack_files[@]}" -gt 0 ] || { echo "ERROR: no pack files staged" >&2; exit 1; }

for f in "${pack_files[@]}"; do
  base="$(basename "$f")"
  echo "  $base"
  aws "${aws_flags[@]}" s3 cp "$f" \
    "s3://${R2_BUCKET:-<bucket>}/packs/$BUILD_ID/$base" \
    --cache-control "$PACK_CACHE_CONTROL" \
    --content-type "application/json" \
    --only-show-errors \
    $( [ "$DRY_RUN" -eq 1 ] && echo "--dryrun" )
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "DRY RUN: nothing was uploaded."
else
  rm -rf "$STAGE"
  echo
  echo "Uploaded. Next:"
  echo "  1. Check the bucket is served from your custom domain, not r2.dev"
  echo "     (r2.dev is rate-limited and not for production)."
  echo "  2. Confirm GL_ASSET_ORIGIN in packs-config.js is that asset domain"
  echo "     (it must be https://assets.golinux.app in production)."
  echo "  3. Deploy the site with ./tools/deploy/deploy-site.sh — it rebuilds,"
  echo "     runs the required smoke test, then deploys the golinux Worker."
fi
