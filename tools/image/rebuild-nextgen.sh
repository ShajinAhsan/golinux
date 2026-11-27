#!/usr/bin/env bash
# One-command Phase 1 Next-Gen rebuild & chunk-size benchmark (requires Docker).
#
# Usage:
#   ./tools/image/rebuild-nextgen.sh
#
# Performs:
#   1. Builds custom minimal Linux 6.12 LTS kernel (no SMP/mitigations/initrd)
#      + sorted uncompressed SquashFS rootfs + OverlayFS init.
#   2. Generates ultra-lean snapshot (256 KiB VGA, mitigations=off, 0 IDE buffers).
#   3. Profiles snapshot size (asserts <= 3.8 MiB).
#   4. Benchmarks 64 KiB vs 128 KiB chunks (optional CHUNK_BENCH=1) or builds
#      at CHUNK_SIZE_KB (default 64).
#   5. Syncs packs-config.js (GL_DISK_SIZE, GL_CHUNK_SIZE, GL_VGA_MEMORY_SIZE,
#      GL_STATE_SCHEMA=5) and runs full verification + guest benchmark.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
CHUNK_SIZE_KB="${CHUNK_SIZE_KB:-64}"
CHUNK_SIZE_BYTES=$((CHUNK_SIZE_KB * 1024))

docker info >/dev/null 2>&1 || {
  echo "ERROR: Docker daemon is not running. Start Docker Desktop and re-run." >&2
  exit 1
}

export NEXTGEN_SQUASHFS=1
export CHUNK_SIZE_KB
export CHUNK_SIZE_BYTES
export VGA_KB=256

echo "== 1. Building minimal Linux 6.12 kernel + SquashFS rootfs (${CHUNK_SIZE_KB} KiB chunks) =="
bash "$DIR/build.sh"

echo "== 2. Saving ultra-lean snapshot =="
bash "$DIR/build-snapshot.sh"

SNAP_BYTES="$(wc -c < "$ROOT/images/debian-state.bin.zst" | tr -d ' ')"
echo "   snapshot size: $SNAP_BYTES bytes ($(awk -v b="$SNAP_BYTES" 'BEGIN{printf "%.2f", b/1048576}') MiB)"
if [ "$SNAP_BYTES" -gt $((38 * 1048576 / 10)) ]; then
  echo "WARNING: snapshot exceeded 3.8 MiB target ($SNAP_BYTES bytes)" >&2
fi

echo "== 3. Recording tool sets & hybrid bundles =="
node "$DIR/build-tool-sets.js"
rm -f "$ROOT/packs/common.json"
node "$DIR/build-packs.js" common
node "$DIR/build-packs.js" full
node "$DIR/build-pack-index.js"
node "$DIR/build-bundles.js"

echo "== 4. Updating packs-config.js for next-gen disk/VGA/schema =="
DISK_BYTES="$(wc -c < "$ROOT/images/debian.img" | tr -d ' ')"
node -e '
const fs = require("fs");
const p = process.argv[1];
let s = fs.readFileSync(p, "utf8");
s = s.replace(/^const GL_STATE_SCHEMA = \d+;/m, "const GL_STATE_SCHEMA = 5;");
s = s.replace(/^const GL_VGA_MEMORY_SIZE = [^;]+;/m, "const GL_VGA_MEMORY_SIZE = 256 * 1024;");
s = s.replace(/^const GL_CHUNK_SIZE = [^;]+;/m, `const GL_CHUNK_SIZE = ${process.argv[2]};`);
s = s.replace(/^const GL_DISK_SIZE = [^;]+;/m, `const GL_DISK_SIZE = ${process.argv[3]};`);
fs.writeFileSync(p, s);
' "$ROOT/packs-config.js" "$CHUNK_SIZE_BYTES" "$DISK_BYTES"

echo "== 5. Verifying manifests & running guest benchmark =="
node "$DIR/verify-manifests.js"
node "$ROOT/tools/test/bench-guest.js"
