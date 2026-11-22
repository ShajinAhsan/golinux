#!/usr/bin/env bash
# Assemble the static directory that Cloudflare Pages serves.
#
#   ./tools/deploy/build-pages.sh [outdir]     (default: .deploy-pages)
#
# Layout produced:
#   index.html, manifest.json, *.js      app shell
#   sw.js, _headers                      worker + cache rules
#   assets/                              wasm, xterm, BIOS
#   icons/
#   images/                              kernel, initrd, snapshot, build-id
#
# Deliberately excluded:
#   images/debian-chunks/    -> R2 (41k files; Pages Free allows 20,000)
#   packs/                   -> R2
#   images/debian.img        -> 5 GiB; only the chunks are served
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
OUT="${1:-$ROOT/.deploy-pages}"

LIMIT_BYTES=$((25 * 1024 * 1024))   # Cloudflare Pages maximum file size
LIMIT_FILES=20000                    # Cloudflare Pages Free file count

# REFUSE TO SHIP FLAT PATHS. Checked BEFORE any copying so a missing or empty
# build id fails with a clear message instead of a bare cp error. An empty
# GL_BUILD_ID would make the deployed app request
# images/debian-chunks/chunk-*.zst (unversioned), letting a previous build's
# bytes be served from cache (silent corruption). Never a silent flat deploy.
if [ ! -f "$ROOT/images/build-id.json" ]; then
  echo "ERROR: images/build-id.json is missing — cannot stamp GL_BUILD_ID." >&2
  echo "       Refusing to build a deploy with flat, unversioned chunk paths." >&2
  echo "       Run: node tools/image/build-id.js  (after build.sh)" >&2
  exit 1
fi
BUILD_ID="$(node -e 'process.stdout.write(require(process.argv[1]).buildId || "")' "$ROOT/images/build-id.json")"
case "$BUILD_ID" in
  "")
    echo "ERROR: images/build-id.json has an empty buildId." >&2
    echo "       Refusing to build a deploy with flat, unversioned chunk paths." >&2
    echo "       Run: node tools/image/build-id.js" >&2
    exit 1 ;;
  *[!0-9a-f]*)
    echo "ERROR: images/build-id.json buildId is not lowercase hex: '$BUILD_ID'" >&2
    exit 1 ;;
esac

rm -rf "$OUT"
mkdir -p "$OUT/images" "$OUT/assets/xterm" "$OUT/assets/bios" "$OUT/assets/v86" "$OUT/icons"

cp "$ROOT"/index.html "$ROOT"/about.html "$ROOT"/manifest.json "$OUT"/
cp "$ROOT"/packs-config.js "$ROOT"/packs.js "$ROOT"/persist.js \
   "$ROOT"/persist-9p.js "$OUT"/
cp "$ROOT"/sw.js "$OUT"/
cp "$ROOT"/public/_headers "$OUT"/
cp "$ROOT"/icons/*.png "$OUT/icons/"
cp "$ROOT"/assets/xterm/xterm.js "$ROOT"/assets/xterm/xterm.css \
   "$ROOT"/assets/xterm/addon-fit.js "$OUT/assets/xterm/"
cp "$ROOT"/assets/bios/seabios.bin "$ROOT"/assets/bios/vgabios.bin "$OUT/assets/bios/"
cp "$ROOT"/assets/v86/libv86.js "$ROOT"/assets/v86/v86.wasm \
   "$ROOT"/assets/v86/v86-fallback.wasm "$OUT/assets/v86/"
# Needed by the service worker's 404 / offline fallback.
cp "$ROOT"/images/debian-chunks/empty-chunk.zst "$OUT/assets/empty-chunk.zst"
cp "$ROOT"/images/debian-bzImage "$ROOT"/images/debian-initrd \
   "$ROOT"/images/debian-state.bin.zst "$ROOT"/images/build-id.json "$OUT/images/"

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
node "$ROOT/tools/image/verify-manifests.js" --deploy --config "$OUT/packs-config.js"

echo "== Pages output: $OUT =="

# Fail loudly on the two limits that would break a deploy.
python3 - "$OUT" "$LIMIT_BYTES" "$LIMIT_FILES" <<'PY'
import os, sys
out, limit_bytes, limit_files = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
files = []
for root, _, names in os.walk(out):
    for n in names:
        p = os.path.join(root, n)
        files.append((os.path.getsize(p), os.path.relpath(p, out)))
total = sum(s for s, _ in files)
bad = [(s, p) for s, p in files if s > limit_bytes]
files.sort(reverse=True)

print(f"  files: {len(files)} / {limit_files}")
print(f"  total: {total / 1048576:.1f} MB")
print("  largest:")
for s, p in files[:5]:
    print(f"    {s / 1048576:7.2f} MB  {p}")

if bad:
    print("\nERROR: these exceed the 25 MiB per-file limit:")
    for s, p in bad:
        print(f"  {s / 1048576:.2f} MB  {p}")
    sys.exit(1)
if len(files) > limit_files:
    print(f"\nERROR: {len(files)} files exceeds the {limit_files} file limit")
    sys.exit(1)
print("\n  all files within Cloudflare Pages limits")
PY
