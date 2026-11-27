#!/usr/bin/env bash
# Regenerate the v86 machine state (snapshot) from the current disk image.
#
#   *** REBUILD THIS WHENEVER images/debian.img CHANGES. ***
#
# A v86 state image stores the full guest RAM plus device state. If the disk
# image is rebuilt, the snapshot no longer matches what is on disk and the
# restored machine will be inconsistent (stale caches, wrong inode data, or a
# failed restore). Always run this after tools/image/build.sh.
#
# Produces: images/debian-state.bin.zst
set -veuo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
IMAGES="$ROOT/images"

MEM_MB="${MEM_MB:-128}"
RAW="$IMAGES/debian-state.bin"
OUT="$IMAGES/debian-state.bin.zst"

for f in debian-bzImage debian.img; do
  [ -f "$IMAGES/$f" ] || { echo "missing $IMAGES/$f — run tools/image/build.sh first" >&2; exit 1; }
done
if [ "${NEXTGEN_SQUASHFS:-0}" != "1" ] && [ ! -f "$IMAGES/debian-initrd" ]; then
  echo "missing $IMAGES/debian-initrd — run tools/image/build.sh first" >&2; exit 1
fi

# The snapshot is prepared for size (see save-state.js for the reasoning and
# tools/image/profile-state.js for the measurement):
#   1. stop services not needed for an interactive shell
#   2. zero free RAM through a tmpfs, delete it, sync
#   3. drop page cache
#   4. kernel init_on_free=1 init_on_alloc=1
#
# Measured on this image at 256 MB RAM (compressed):
#   baseline                        40,658,067 bytes
#   zero free RAM                   13,157,804
#   init_on_free=1 + drop_caches    12,831,529
#   + zero free RAM (all combined)  10,659,081
#   (+ stopping services)           10,823,076   <- current
#
# drop_caches on its own is NOT a win (40508840 -> 40699014, +0.47%); it only
# helps as part of this combination, where it stops cached file data from
# re-dirtying the pages we just zeroed.

echo "== Booting headless and saving state at ${MEM_MB} MB =="
BOOT_TIMEOUT_MS="${BOOT_TIMEOUT_MS:-180000}" \
  node "$DIR/save-state.js" "$MEM_MB" "$RAW"

echo "== Compressing =="
zstd --ultra -22 -T0 -f "$RAW" -o "$OUT"
rm -f "$RAW"

echo "== Refreshing build id (invalidates saved user states) =="
node "$DIR/build-id.js"

echo "== Refreshing pack index (snapshot size) =="
node "$DIR/build-pack-index.js"

echo "== Verifying manifests are not stale =="
node "$DIR/verify-manifests.js"

echo
echo "== Done =="
ls -lh "$OUT" | awk '{print "  snapshot: "$9" ("$5")"}'
echo "  memory:   ${MEM_MB} MB (must match MEMORY_SIZE in index.html)"
