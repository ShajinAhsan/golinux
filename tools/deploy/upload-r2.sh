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
# can be used to check what would be uploaded.
if [ "$DRY_RUN" -eq 0 ]; then
  need R2_ACCOUNT_ID; need R2_BUCKET; need R2_ACCESS_KEY_ID; need R2_SECRET_ACCESS_KEY
  command -v aws >/dev/null || { echo "aws CLI not found (brew install awscli)" >&2; exit 1; }
elif ! command -v aws >/dev/null; then
  echo "NOTE: aws CLI not installed; cannot show the exact sync plan."
  echo "      Staged file counts above are what would be uploaded."
fi

ENDPOINT="https://${R2_ACCOUNT_ID:-<account-id>}.r2.cloudflarestorage.com"

echo "== Staging the files that should exist in R2 =="
rm -rf "$STAGE"
mkdir -p "$STAGE/images/debian-chunks" "$STAGE/packs"

python3 - "$MANIFEST" "$CHUNKS" "$STAGE" <<'PY'
import json, os, shutil, sys
manifest, chunks, stage = sys.argv[1], sys.argv[2], sys.argv[3]
real = json.load(open(manifest))["real"]
dst = os.path.join(stage, "images", "debian-chunks")
for name in real:
    shutil.copy2(os.path.join(chunks, name), os.path.join(dst, name))
# The zeroed chunk is needed by the service worker's 404 fallback.
shutil.copy2(os.path.join(chunks, "empty-chunk.zst"),
             os.path.join(dst, "empty-chunk.zst"))
print(f"staged {len(real) + 1} chunk files")
PY

cp "$PACKS"/*.json "$STAGE/packs/"
echo "staged $(ls -1 "$STAGE/packs" | wc -l | tr -d ' ') pack files"

CHUNK_COUNT=$(ls -1 "$STAGE/images/debian-chunks" | wc -l | tr -d ' ')
CHUNK_BYTES=$(du -sk "$STAGE/images/debian-chunks" | cut -f1)
echo "  chunks: $CHUNK_COUNT files, ~$((CHUNK_BYTES / 1024)) MB"

# Types matter: a wrong Content-Type on .zst or .json breaks parsing.
aws_flags=(
  --endpoint-url "$ENDPOINT"
  --region auto
)

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
# A production upload MUST be versioned. An empty GL_BUILD_ID-style id would put
# every build's chunks at the same unversioned prefix, so a rebuild silently
# overwrites bytes that `immutable` promised never to change. Refuse it.
if [ -z "$BUILD_ID" ]; then
  echo "ERROR: build id is empty — refusing to upload flat, unversioned chunk paths." >&2
  echo "       images/build-id.json has an empty buildId. Run: node tools/image/build-id.js" >&2
  exit 1
fi
case "$BUILD_ID" in
  *[!0-9a-f]*) echo "invalid build id: '$BUILD_ID' (expected lowercase hex)" >&2; exit 1 ;;
esac
echo "build id: $BUILD_ID"

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

echo "== Sync packs =="
aws "${aws_flags[@]}" s3 sync "$STAGE/packs" \
  "s3://${R2_BUCKET:-<bucket>}/packs/$BUILD_ID" \
  --exclude "*" --include "*.json" \
  --cache-control "public, max-age=300" \
  --content-type "application/json" \
  --only-show-errors \
  $( [ "$DRY_RUN" -eq 1 ] && echo "--dryrun" )

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "DRY RUN: nothing was uploaded."
else
  rm -rf "$STAGE"
  echo
  echo "Uploaded. Next:"
  echo "  1. Check the bucket is served from your custom domain, not r2.dev"
  echo "     (r2.dev is rate-limited and not for production)."
  echo "  2. Set PL_ASSET_ORIGIN in packs-config.js to that domain."
  echo "  3. Re-deploy the app origin."
fi
