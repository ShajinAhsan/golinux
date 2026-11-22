#!/usr/bin/env bash
# Build a Debian bookworm i386 CLI image for v86.
#
# Adapted from copy/v86 tools/docker/debian/build-raw-disk.sh. Two differences:
#  1. mkfs.ext4 / mount cannot run on macOS, so that step runs in a container.
#  2. Desktop packages are dropped; this is a CLI-only root filesystem.
#
# Produces, in images/:
#   debian-bzImage      kernel
#   debian-initrd       initrd
#   debian.img          raw ext4 disk (5 GiB sparse)
#   debian-chunks/      zstd chunks for v86 `use_parts` loading
set -veuo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
IMAGES="$ROOT/images"
WORK="$ROOT/.build"
CONTAINER_NAME=debian-cli-build
DISK_SIZE="${DISK_SIZE:-5G}"

mkdir -p "$IMAGES" "$WORK"

# Run the install steps in a container rather than via docker build.
# docker build hangs under qemu-user on Apple Silicon (qemu never reaps the
# exited apt-get), so we use --init to get a real supervisor.
echo "== Building root filesystem (i386) =="
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run --name "$CONTAINER_NAME" --init --platform linux/386 \
  -v "$DIR/install.sh:/install.sh:ro" \
  i386/debian:bookworm-slim \
  bash /install.sh

echo "== Exporting root filesystem =="
docker export "$CONTAINER_NAME" > "$WORK/debian-rootfs.tar"
docker rm "$CONTAINER_NAME" >/dev/null

echo "== Creating ext4 image ($DISK_SIZE) and populating it =="
rm -f "$IMAGES/debian.img"
docker run --rm --privileged \
  -v "$IMAGES:/images" \
  -v "$WORK:/work" \
  --platform linux/arm64 \
  debian:bookworm-slim \
  bash -c '
    set -euo pipefail
    apt-get update -qq
    apt-get install -y -qq e2fsprogs >/dev/null
    truncate -s '"$DISK_SIZE"' /images/debian.img
    mkfs.ext4 -q -F -L golinux /images/debian.img
    mkdir -p /mnt/root
    mount -o loop /images/debian.img /mnt/root
    tar -xf /work/debian-rootfs.tar -C /mnt/root
    # /etc/hostname, /etc/hosts and /etc/resolv.conf are bind mounts inside a
    # container, so writes to them never reach `docker export`. Set them here,
    # on the real filesystem, or the guest boots with hostname "(none)".
    echo golinux > /mnt/root/etc/hostname
    printf '%s\n' '127.0.0.1 localhost' '127.0.1.1 golinux' > /mnt/root/etc/hosts
    printf '%s\n' 'nameserver 10.0.2.3' > /mnt/root/etc/resolv.conf
    sync
    cp /mnt/root/boot/vmlinuz-* /images/debian-bzImage
    cp /mnt/root/boot/initrd.img-* /images/debian-initrd
    umount /mnt/root
  '

# ORDER MATTERS:
#   1. chunk the image into a per-build directory
#   2. build the manifest for those chunks
#   3. hash everything served -> build id (content hash, deterministic)
#   4. only then can pack lists / indexes be regenerated
# The build id cannot be computed before chunking, because it hashes the chunks.
echo "== Splitting into 128 KiB zstd chunks (per-build directory) =="
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUILD_ID_TMP="build-$STAMP"
rm -rf "$IMAGES/debian-chunks/$BUILD_ID_TMP"
mkdir -p "$IMAGES/debian-chunks/$BUILD_ID_TMP"
python3 "$ROOT/tools/split-image.py" --zstd 128k \
  "$IMAGES/debian.img" "$IMAGES/debian-chunks/$BUILD_ID_TMP/chunk-%d-%d"

rm -f "$WORK/debian-rootfs.tar"

echo "== Manifest for this build's chunks =="
node "$ROOT/tools/image/build-chunk-manifest.js" --dir "$IMAGES/debian-chunks/$BUILD_ID_TMP"

echo "== Computing content build id =="
node "$ROOT/tools/image/build-id.js" --dir "$IMAGES/debian-chunks/$BUILD_ID_TMP"
BUILD_ID="$(node -e 'process.stdout.write(require("'"$ROOT"'/images/build-id.json").buildId)')"
echo "   build id: $BUILD_ID"

# Rename the staging directory to the content hash. If a directory for this id
# already exists the contents are identical, so it is reused rather than
# replaced, which keeps an unchanged rebuild a true no-op.
echo "== Naming build directory after its content hash =="
if [ -d "$IMAGES/debian-chunks/$BUILD_ID" ]; then
  echo "   $BUILD_ID already exists; reusing it"
  rm -rf "$IMAGES/debian-chunks/$BUILD_ID_TMP"
else
  mv "$IMAGES/debian-chunks/$BUILD_ID_TMP" "$IMAGES/debian-chunks/$BUILD_ID"
fi

# Flat mirror for local dev, where GL_BUILD_ID is left empty. The glob would
# expand to 40,960 paths and overflow ARG_MAX ("Argument list too long"), so
# delete and copy with find instead.
find "$IMAGES/debian-chunks" -maxdepth 1 -name 'chunk-*.zst' -delete
# python rather than `find -exec cp`: 40,960 separate cp invocations is slow,
# and `cp *.zst` overflows ARG_MAX.
python3 - "$IMAGES/debian-chunks/$BUILD_ID" "$IMAGES/debian-chunks" <<'PYCOPY'
import os, shutil, sys
src, dst = sys.argv[1], sys.argv[2]
n = 0
for f in os.listdir(src):
    if f.startswith("chunk-") and f.endswith(".zst"):
        shutil.copy2(os.path.join(src, f), os.path.join(dst, f))
        n += 1
print(f"   mirrored {n} chunk files for local dev")
PYCOPY

echo "== Regenerating chunk manifest and pack lists =="
node "$ROOT/tools/image/build-chunk-manifest.js"
node "$ROOT/tools/image/build-pack-index.js"
# An image rebuild changes every chunk's BYTES, so a pack recorded against the
# previous image serves stale data (observed offline as "invalid ELF header"
# from git/gcc). Packs live under the build id and MUST be re-recorded.
if [ -f "$ROOT/packs/common.json" ]; then
  echo "  WARNING: chunks changed — packs are stale and MUST be re-recorded:"
  echo "        rm -f packs/common.json"
  echo "        node tools/image/build-packs.js common"
  echo "        node tools/image/build-packs.js full"
  echo "        node tools/image/build-pack-index.js"
fi

# Fail loudly rather than shipping a snapshot/pack set that no longer matches
# this image. Run build-snapshot.sh first if this is a fresh image.
node "$ROOT/tools/image/verify-manifests.js"

# Unit-test the service worker's chunk fallback (empty-chunk vs real-chunk 404).
# Fast, no emulator: guards the offline/404 policy on every image build.
node "$ROOT/tools/test/sw-chunk-fallback.test.js"

echo
echo "== Done =="
du -h "$IMAGES/debian.img" | sed 's/^/  raw disk: /'
du -sh "$IMAGES/debian-chunks" | sed 's/^/  chunks:   /'
ls -lh "$IMAGES/debian-bzImage" "$IMAGES/debian-initrd" | awk '{print "  "$9": "$5}'
