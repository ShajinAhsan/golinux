#!/usr/bin/env bash
# Build, then deploy the site to the Cloudflare Worker "golinux" (golinux.app).
#
#   ./tools/deploy/deploy-site.sh             # build, confirm, deploy, verify
#   ./tools/deploy/deploy-site.sh --dry-run   # everything except the deploy
#
# This is a WORKER with static assets, not a Pages project: `wrangler deploy`
# uploads .deploy-pages (see wrangler.jsonc).
#
# Credentials: none are read from this repo. Wrangler uses the session created
# once by `npx wrangler login`. This script never prints a token.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
OUT="$ROOT/.deploy-pages"
SITE_URL="https://golinux.app"
ASSET_ORIGIN="https://assets.golinux.app"
EXPECTED_ASSET_ORIGIN="https://assets.golinux.app"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Build. The smoke test inside build-pages.sh is REQUIRED: a deploy must
#    never come from a build whose smoke test was skipped.
# ---------------------------------------------------------------------------
if [ "${SKIP_SMOKE:-0}" = "1" ]; then
  die "SKIP_SMOKE is set. deploy-site.sh refuses to deploy an output whose
       smoke test was skipped. Unset SKIP_SMOKE and try again."
fi

echo "== Building (this runs the required smoke test) =="
if ! "$ROOT/tools/deploy/build-pages.sh" "$OUT"; then
  die "build-pages.sh failed; not deploying."
fi

[ -f "$OUT/sw.js" ] || die "$OUT/sw.js is missing; build looks incomplete."

BUILD_ID="$(node -e 'process.stdout.write(require(process.argv[1]).buildId)' \
  "$ROOT/images/build-id.json")"
[ -n "$BUILD_ID" ] || die "build id is empty"

SW_SHA="$(shasum -a 256 "$OUT/sw.js" | cut -d' ' -f1)"
FILE_COUNT="$(find "$OUT" -type f | wc -l | tr -d ' ')"
TOTAL_BYTES="$(find "$OUT" -type f -exec stat -f%z {} + | awk '{s+=$1} END {print s+0}')"
TOTAL_MB="$(awk -v b="$TOTAL_BYTES" 'BEGIN {printf "%.2f", b/1048576}')"

echo
echo "== Build summary =="
echo "  build id : $BUILD_ID"
echo "  sw.js    : sha256 $SW_SHA"
echo "  files    : $FILE_COUNT"
echo "  size     : $TOTAL_MB MB"

# ---------------------------------------------------------------------------
# 2. Wrangler auth. Never attempt to log in: that is the user's action.
# ---------------------------------------------------------------------------
echo
echo "== Checking wrangler auth =="
if ! WHOAMI="$(cd "$ROOT" && npx wrangler whoami 2>&1)"; then
  echo "$WHOAMI" >&2
  die "wrangler is not authenticated. Run this yourself, then re-run:

       npx wrangler login"
fi
if printf '%s' "$WHOAMI" | grep -qiE 'not authenticated|not logged in|no account|Not logged in'; then
  echo "$WHOAMI" >&2
  die "wrangler is not logged in. Run this yourself, then re-run:

       npx wrangler login"
fi
echo "  authenticated."

# ---------------------------------------------------------------------------
# 3. Confirm.
# ---------------------------------------------------------------------------
echo
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY RUN: would now ask: Deploy build $BUILD_ID to golinux.app? [y/N]"
  echo "DRY RUN: would run: npx wrangler deploy"
else
  printf 'Deploy build %s to golinux.app? [y/N] ' "$BUILD_ID"
  read -r ANSWER
  case "$ANSWER" in
    y|Y|yes|YES) ;;
    *) echo "Aborted; nothing was deployed."; exit 1 ;;
  esac

  echo
  echo "== Deploying =="
  ( cd "$ROOT" && npx wrangler deploy )
fi

# ---------------------------------------------------------------------------
# 4. Verify the LIVE site. Cache-busted, retried: a fresh deployment can take
#    a few seconds to become consistent, and the CDN may still hold the old
#    copy for a moment.
# ---------------------------------------------------------------------------
fetch() {
  # fetch <url> <outfile> -> prints nothing; body goes to <outfile>
  curl -sS -m 20 -o "$2" "$1"
}

retry() {
  # retry <description> <attempts> <command...>
  local desc="$1" attempts="$2"; shift 2
  local i=1
  while [ "$i" -le "$attempts" ]; do
    if "$@"; then
      echo "ok: $desc"
      return 0
    fi
    if [ "$i" -lt "$attempts" ]; then
      echo "  … $desc (attempt $i/$attempts failed, retrying)"
      sleep 3
    fi
    i=$((i + 1))
  done
  echo "FAIL: $desc" >&2
  return 1
}

FAILED=0

check_sw_sha() {
  local tmp; tmp="$(mktemp)"
  fetch "$SITE_URL/sw.js?cb=$(date +%s%N)" "$tmp" || { rm -f "$tmp"; return 1; }
  local live; live="$(shasum -a 256 "$tmp" | cut -d' ' -f1)"
  rm -f "$tmp"
  [ "$live" = "$SW_SHA" ]
}

check_asset_origin() {
  local tmp; tmp="$(mktemp)"
  fetch "$SITE_URL/packs-config.js?cb=$(date +%s%N)" "$tmp" || { rm -f "$tmp"; return 1; }
  local ok=0
  if grep -qE "^const GL_ASSET_ORIGIN = \"${EXPECTED_ASSET_ORIGIN}\";" "$tmp"; then
    ok=1
  fi
  rm -f "$tmp"
  [ "$ok" -eq 1 ]
}

check_precache_200() {
  local code
  code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' \
    "$SITE_URL/chunks-precache.json?cb=$(date +%s%N)")"
  [ "$code" = "200" ]
}

check_sw_cache_control() {
  local hdr
  hdr="$(curl -sSI -m 20 "$SITE_URL/sw.js?cb=$(date +%s%N)" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control" {print tolower($2)}')"
  # Accept no-cache, or a max-age of 0 (with any must-revalidate qualifier).
  case "$hdr" in
    *no-cache*) return 0 ;;
    *max-age=0*) return 0 ;;
    *) echo "  cache-control was: ${hdr:-<none>}" >&2; return 1 ;;
  esac
}

check_tools_json() {
  local url="$ASSET_ORIGIN/packs/$BUILD_ID/tools.json?cb=$(date +%s%N)"
  local code cors
  code="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -H "Origin: $SITE_URL" "$url")"
  cors="$(curl -sSI -m 20 -H "Origin: $SITE_URL" "$url" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin" {print $2}')"
  [ "$code" = "200" ] && [ "$cors" = "$SITE_URL" ]
}

check_one_chunk() {
  local chunk
  chunk="$(node -e 'process.stdout.write(require(process.argv[1])[0])' \
    "$ROOT/chunks-precache.json")"
  [ -n "$chunk" ] || return 1
  local url="$ASSET_ORIGIN/images/debian-chunks/$BUILD_ID/$chunk?cb=$(date +%s%N)"
  local code cors
  code="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -H "Origin: $SITE_URL" "$url")"
  cors="$(curl -sSI -m 30 -H "Origin: $SITE_URL" "$url" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin" {print $2}')"
  [ "$code" = "200" ] && [ "$cors" = "$SITE_URL" ]
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "DRY RUN: would now verify $SITE_URL against this build."
  echo "DRY RUN: nothing was deployed and nothing was verified."
  exit 0
fi

echo
echo "== Verifying the live site =="
retry "sw.js sha256 matches the local build" 6 check_sw_sha || FAILED=1
retry "packs-config.js has GL_ASSET_ORIGIN $EXPECTED_ASSET_ORIGIN" 6 check_asset_origin || FAILED=1
retry "chunks-precache.json returns 200" 6 check_precache_200 || FAILED=1
retry "sw.js Cache-Control is no-cache / max-age=0" 6 check_sw_cache_control || FAILED=1
retry "packs/$BUILD_ID/tools.json returns 200 with CORS for $SITE_URL" 6 check_tools_json || FAILED=1
retry "a real chunk on the asset origin returns 200 with CORS" 6 check_one_chunk || FAILED=1

echo
if [ "$FAILED" -ne 0 ]; then
  die "deployed, but live verification failed. Check the failing item above."
fi
echo "Deployed build $BUILD_ID and verified $SITE_URL."
