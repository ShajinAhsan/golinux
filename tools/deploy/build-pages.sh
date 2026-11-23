#!/usr/bin/env bash
# Assemble the static directory the golinux WORKER serves (static assets).
#
#   ./tools/deploy/build-pages.sh [outdir] [--build-id <id>]  (default: .deploy-pages)
#
# Layout produced:
#   index.html, styles.css, js/*.js, manifest.json, *.js   app shell
#   sw.js, _headers                                        app worker + header rules
#   assets/                                                wasm, xterm, BIOS
#   icons/
#   images/                                                kernel, initrd, snapshot, build-id
#
# Deliberately excluded:
#   images/debian-chunks/    -> R2 (41k files; the Worker allows 20,000 free)
#   packs/                   -> R2
#   images/debian.img        -> 5 GiB; only the chunks are served
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
OUT="$ROOT/.deploy-pages"
OVERRIDE_BUILD_ID=""

while [ $# -gt 0 ]; do
  case "$1" in
    --build-id)
      [ $# -ge 2 ] || { echo "ERROR: --build-id requires a value" >&2; exit 2; }
      OVERRIDE_BUILD_ID="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,16p' "$0"; exit 0
      ;;
    -*)
      echo "ERROR: unknown argument: $1" >&2; exit 2
      ;;
    *)
      OUT="$1"
      shift
      ;;
  esac
done

# Cloudflare Workers static assets limits (verified 2026-11-23):
#   - 25 MiB per file, all plans
#   - 20,000 files per Worker version on the free plan; 100,000 on paid
#     (paid requires Wrangler >= 4.34.0). 20,000 is the safe floor to enforce.
LIMIT_BYTES=$((25 * 1024 * 1024))
LIMIT_FILES=20000

# REFUSE TO SHIP FLAT PATHS. Checked BEFORE any copying so a missing or empty
# build id fails with a clear message instead of a bare cp error.
if [ -n "$OVERRIDE_BUILD_ID" ]; then
  BUILD_ID="$OVERRIDE_BUILD_ID"
  echo "Using explicit rollback/override build id: $BUILD_ID"
else
  if [ ! -f "$ROOT/images/build-id.json" ]; then
    echo "ERROR: images/build-id.json is missing — cannot stamp GL_BUILD_ID." >&2
    echo "       Refusing to build a deploy with flat, unversioned chunk paths." >&2
    echo "       Run: node tools/image/build-id.js  (after build.sh)" >&2
    exit 1
  fi
  BUILD_ID="$(node -e 'process.stdout.write(require(process.argv[1]).buildId || "")' "$ROOT/images/build-id.json")"
fi
case "$BUILD_ID" in
  "")
    echo "ERROR: buildId is empty." >&2
    echo "       Refusing to build a deploy with flat, unversioned chunk paths." >&2
    echo "       Run: node tools/image/build-id.js" >&2
    exit 1 ;;
  *[!0-9a-f]*)
    echo "ERROR: buildId is not lowercase hex: '$BUILD_ID'" >&2
    exit 1 ;;
esac

rm -rf "$OUT"
mkdir -p "$OUT/images" "$OUT/assets/xterm" "$OUT/assets/bios" "$OUT/assets/v86" "$OUT/icons"

cp "$ROOT"/index.html "$ROOT"/terminal.html "$ROOT"/about.html "$ROOT"/manifest.json "$OUT"/
for css in styles.css landing.css; do
  if [ -f "$ROOT/$css" ]; then
    cp "$ROOT/$css" "$OUT/"
  fi
done
if [ -d "$ROOT/js" ]; then
  mkdir -p "$OUT/js"
  cp "$ROOT"/js/*.js "$OUT/js/"
fi
cp "$ROOT"/packs-config.js "$ROOT"/packs.js "$ROOT"/persist.js \
   "$ROOT"/persist-9p.js "$OUT"/
cp "$ROOT"/sw.js "$OUT"/
cp "$ROOT"/public/_headers "$OUT"/
cp "$ROOT"/icons/*.png "$OUT/icons/"
cp "$ROOT"/assets/xterm/xterm.js "$ROOT"/assets/xterm/xterm.css "$OUT/assets/xterm/"
cp "$ROOT"/assets/bios/seabios.bin "$ROOT"/assets/bios/vgabios.bin "$OUT/assets/bios/"
cp "$ROOT"/assets/v86/libv86.js "$ROOT"/assets/v86/v86.wasm \
   "$ROOT"/assets/v86/v86-fallback.wasm "$OUT/assets/v86/"
# Needed by the service worker's 404 / offline fallback.
cp "$ROOT"/images/debian-chunks/empty-chunk.zst "$OUT/assets/empty-chunk.zst"
# The worker fetches this from the APP origin (not R2) to tell a zeroed chunk
# from a real one. Without it, every empty-chunk 404 is treated as a real chunk
# loss and the machine stops with "this version is out of date".
if [ ! -f "$ROOT/chunks-precache.json" ]; then
  echo "ERROR: chunks-precache.json is missing — the service worker needs it to" >&2
  echo "       distinguish zeroed chunks from real ones." >&2
  echo "       Run: node tools/image/build-chunk-manifest.js" >&2
  exit 1
fi
cp "$ROOT/chunks-precache.json" "$OUT"/chunks-precache.json
if [ ! -f "$ROOT/bundles.json" ]; then
  echo "ERROR: bundles.json is missing — run: node tools/image/build-bundles.js" >&2
  exit 1
fi
cp "$ROOT/bundles.json" "$OUT"/bundles.json
cp "$ROOT"/images/debian-bzImage "$ROOT"/images/debian-initrd \
   "$ROOT"/images/debian-state.bin.zst "$ROOT"/images/build-id.json "$OUT/images/"
if [ -n "$OVERRIDE_BUILD_ID" ]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.buildId = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  ' "$OUT/images/build-id.json" "$BUILD_ID"
fi

# Stamp the build id (validated above) so the deployed app requests this
# build's chunk paths. Done on the COPY under $OUT, never on the source tree, so
# a local dev checkout keeps GL_BUILD_ID = "" and flat paths.
python3 - "$OUT/packs-config.js" "$BUILD_ID" <<'PY2'
import re, sys
path, build_id = sys.argv[1], sys.argv[2]
src = open(path).read()
new, n = re.subn(r'^const GL_BUILD_ID = "[^"]*";',
                 f'const GL_BUILD_ID = "{build_id}";', src, flags=re.M)
if n != 1:
    sys.exit(f"failed to stamp GL_BUILD_ID (matched {n} times)")
open(path, "w").write(new)
PY2
# Prove the stamped copy is non-empty, or the deploy is flat.
python3 - "$OUT/packs-config.js" <<'PY3'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r'^const GL_BUILD_ID = "([^"]*)";', src, re.M)
if not m or not m.group(1):
    sys.exit("ERROR: GL_BUILD_ID is empty in the staged packs-config.js; "
             "the deploy would ship flat, unversioned chunk paths")
PY3
echo "   stamped GL_BUILD_ID = $BUILD_ID"

# Final gate on the STAGED tree: --deploy requires a non-empty, matching build
# id, so a flat unversioned deploy cannot leave this script.
if [ -z "$OVERRIDE_BUILD_ID" ]; then
  node "$ROOT/tools/image/verify-manifests.js" --deploy --config "$OUT/packs-config.js"
else
  node "$ROOT/tools/image/verify-manifests.js" --deploy --allow-override-id --config "$OUT/packs-config.js"
fi

echo "== Assets output: $OUT =="

# Fail loudly on the two limits that would break a deploy, and warn above 90%.
python3 - "$OUT" "$LIMIT_BYTES" "$LIMIT_FILES" <<'PY'
import os, sys
out, limit_bytes, limit_files = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
warn_bytes = int(limit_bytes * 0.90)
files = []
for root, _, names in os.walk(out):
    for n in names:
        p = os.path.join(root, n)
        files.append((os.path.getsize(p), os.path.relpath(p, out)))
total = sum(s for s, _ in files)
bad = [(s, p) for s, p in files if s > limit_bytes]
warn = [(s, p) for s, p in files if warn_bytes < s <= limit_bytes]
files.sort(reverse=True)

print(f"  files: {len(files)} / {limit_files}")
print(f"  total: {total / 1048576:.1f} MB")
print("  largest:")
for s, p in files[:5]:
    print(f"    {s / 1048576:7.2f} MB  {p}")

for s, p in warn:
    print(f"\nWARNING: {p} is {s / 1048576:.2f} MiB (>90% of 25 MiB Worker limit)")

if bad:
    print("\nERROR: these exceed the 25 MiB per-file limit:")
    for s, p in bad:
        print(f"  {s / 1048576:.2f} MB  {p}")
    sys.exit(1)
if len(files) > limit_files:
    print(f"\nERROR: {len(files)} files exceeds the {limit_files} file limit")
    sys.exit(1)
print(f"\n  all files within Workers static-asset limits "
      f"(25 MiB/file, {limit_files} files)")
PY

# REQUIRED before any deploy: drive the staged output through a real headless
# browser against a local mirror of R2 (real versioned chunk paths, 404 for
# zeroed chunks). Catches the exact class of bug that only shows up in
# production: wrong asset origin, a chunk regex that ignores the build id, a
# missing precache list. Skips only when explicitly asked (local builds).
if [ "${SKIP_SMOKE:-0}" = "1" ]; then
  echo
  echo "!! SKIPPED the deploy smoke test (SKIP_SMOKE=1). Do not deploy this output."
else
  echo
  echo "== Deploy smoke test (required) =="
  node "$ROOT/tools/test/smoke-deploy.test.js" --pages "$OUT"
fi
